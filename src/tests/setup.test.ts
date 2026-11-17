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
