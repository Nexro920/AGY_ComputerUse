import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('setup.mjs performs pre-flight check, installs plugin bundle, verifies MCP, and uninstalls safely', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cua-setup-'));
  const targetDir = path.join(tempRoot, 'plugins', 'agy-chrome-use');
  const dataDir = path.join(tempRoot, 'plugin-data', 'agy-chrome-use');
  const pluginRoot = process.cwd();
  const setupScript = path.join(pluginRoot, 'scripts', 'setup.mjs');

  try {
    // 1. Check-only mode passes without creating plugin bundle.
    const { stdout: checkOut } = await execFileAsync('node', [
      setupScript,
      '--check-only',
      '--runtime-root',
      pluginRoot,
      '--target-dir',
      targetDir,
      '--data-dir',
      dataDir,
    ]);
    assert.match(checkOut, /Node\.js \(>=20\): \[OK\]/);
    assert.match(checkOut, /Google Chrome:\s+\[OK\]/);

    // 2. Full installation writes BOM-free configs and passes live MCP handshake verification.
    const { stdout: installOut } = await execFileAsync('node', [
      setupScript,
      '--runtime-root',
      pluginRoot,
      '--target-dir',
      targetDir,
      '--data-dir',
      dataDir,
    ]);
    assert.match(installOut, /\[OK\] MCP server verified\. Registered tools: cua_authorize, cua_exec, cua_reset, cua_status/);

    const mcpRaw = await fs.readFile(path.join(targetDir, 'mcp_config.json'), 'utf8');
    assert.equal(mcpRaw.charCodeAt(0) === 0xfeff, false, 'mcp_config.json must not have BOM');
    const mcpJson = JSON.parse(mcpRaw) as {
      mcpServers: { 'agy-chrome-use': { env: { AGY_CHROME_RUNTIME_ROOT: string } } };
    };
    assert.equal(mcpJson.mcpServers['agy-chrome-use'].env.AGY_CHROME_RUNTIME_ROOT, pluginRoot);

    const hooksRaw = await fs.readFile(path.join(targetDir, 'hooks.json'), 'utf8');
    assert.equal(hooksRaw.charCodeAt(0) === 0xfeff, false, 'hooks.json must not have BOM');
    const hooksJson = JSON.parse(hooksRaw) as {
      'agy-chrome-use-release': { Stop: Array<{ command: string }> };
    };
    assert.ok(
      hooksJson['agy-chrome-use-release'].Stop[0].command.includes(
        path.join(targetDir, 'scripts', 'stop-hook.mjs'),
      ),
    );

    // 3. Create fake user auth.json and verify --uninstall preserves dataDir by default.
    await fs.writeFile(path.join(dataDir, 'auth.json'), '{"authorized":true}', 'utf8');
    await execFileAsync('node', [
      setupScript,
      '--uninstall',
      '--runtime-root',
      pluginRoot,
      '--target-dir',
      targetDir,
      '--data-dir',
      dataDir,
    ]);
    await assert.rejects(() => fs.access(targetDir));
    await fs.access(path.join(dataDir, 'auth.json'));

    // 4. --uninstall --purge-data removes dataDir as well.
    await execFileAsync('node', [
      setupScript,
      '--uninstall',
      '--purge-data',
      '--runtime-root',
      pluginRoot,
      '--target-dir',
      targetDir,
      '--data-dir',
      dataDir,
    ]);
    await assert.rejects(() => fs.access(dataDir));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('plugin bundle satisfies Antigravity Marketplace manifest, asset, and zero-node_modules launcher contracts', async () => {
  const pluginRoot = process.cwd();
  const manifestRaw = await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    $schema?: string;
    name: string;
    displayName: string;
    description: string;
    version: string;
    logo: string;
    author: { name: string; url?: string } | string;
    suggestedPrompts?: string[];
  };

  assert.equal(manifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(!/^(Antigravity|Gemini|Claude|Cursor)\b/i.test(manifest.displayName));
  assert.ok(!/\b(Plugin|MCP)$/i.test(manifest.displayName));
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.ok(manifest.description.length >= 40 && manifest.description.length <= 200);
  assert.ok(manifest.logo && !path.isAbsolute(manifest.logo) && !manifest.logo.startsWith('http'));
  await fs.access(path.join(pluginRoot, manifest.logo));
  assert.ok((manifest.suggestedPrompts?.length ?? 0) <= 3);

  const skillMd = await fs.readFile(path.join(pluginRoot, 'skills', 'cua-repl', 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\r?\nname:\s*cua-repl\b/m);

  const mcpRaw = await fs.readFile(path.join(pluginRoot, 'mcp_config.json'), 'utf8');
  const mcpCfg = JSON.parse(mcpRaw) as {
    mcpServers: {
      'agy-chrome-use': { command: string; args: string[]; env?: Record<string, string> };
    };
  };
  const serverCfg = mcpCfg.mcpServers['agy-chrome-use'];
  assert.equal(serverCfg.command, 'node');
  assert.deepEqual(serverCfg.args, ['${PLUGIN_ROOT}/scripts/mcp-launcher.mjs']);
  assert.equal(serverCfg.env?.PLUGIN_ROOT, undefined);
  assert.equal(serverCfg.env?.PLUGIN_DATA, undefined);

  // Verify mcp-launcher boots cleanly when PLUGIN_ROOT lacks node_modules (Marketplace layout).
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cua-mkt-'));
  const isolatedPluginRoot = path.join(tempRoot, 'readonly-plugin');
  const isolatedDataDir = path.join(tempRoot, 'plugin-data');
  try {
    await fs.mkdir(path.join(isolatedPluginRoot, 'scripts'), { recursive: true });
    await fs.copyFile(path.join(pluginRoot, 'package.json'), path.join(isolatedPluginRoot, 'package.json'));
    await fs.copyFile(
      path.join(pluginRoot, 'scripts', 'mcp-launcher.mjs'),
      path.join(isolatedPluginRoot, 'scripts', 'mcp-launcher.mjs'),
    );
    await fs.cp(path.join(pluginRoot, 'dist'), path.join(isolatedPluginRoot, 'dist'), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}tests`) && !src.endsWith('.map'),
    });

    await fs.mkdir(path.join(isolatedDataDir, 'runtime'), { recursive: true });
    await fs.symlink(
      path.join(pluginRoot, 'node_modules'),
      path.join(isolatedDataDir, 'runtime', 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(isolatedPluginRoot, 'scripts', 'mcp-launcher.mjs')],
      cwd: isolatedPluginRoot,
      env: {
        ...process.env,
        PLUGIN_ROOT: isolatedPluginRoot,
        PLUGIN_DATA: isolatedDataDir,
      },
    });
    const client = new Client({ name: 'agy-marketplace-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      assert.deepEqual(
        list.tools.map((t) => t.name).sort(),
        ['cua_authorize', 'cua_exec', 'cua_reset', 'cua_status'],
      );
    } finally {
      await client.close();
    }

    await fs.access(path.join(isolatedDataDir, 'runtime', 'dist', 'server.js'));
    await fs.access(path.join(isolatedDataDir, 'runtime', '.runtime-stamp.json'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});
