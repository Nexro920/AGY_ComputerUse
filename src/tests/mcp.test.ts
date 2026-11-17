import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((c) => c.type === 'text');
  return item?.text ?? '';
}

async function runHookWithStdin(
  pluginRoot: string,
  env: NodeJS.ProcessEnv,
  stdinText: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('node', [path.join(pluginRoot, 'scripts', 'stop-hook.mjs')], {
      cwd: pluginRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`stop-hook exited ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.end(stdinText);
  });
}

test('MCP server enforces authorization gates, reset scopes, control server auth, and stop-hook behavior', async () => {
  const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cua-test-'));
  const pluginRoot = process.cwd();

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/server.js'],
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: tempDataDir,
    },
  });

  const client = new Client({
    name: 'agy-chrome-use-test-client',
    version: '0.1.0',
  });

  try {
    await client.connect(transport);

    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['cua_authorize', 'cua_exec', 'cua_reset', 'cua_status']);

    // Unauthenticated cua_exec must be blocked (even if extra authorize property is supplied).
    const unauthExec = await client.callTool({
      name: 'cua_exec',
      arguments: { code: 'return 1 + 1;', includeSnapshot: false, authorize: true },
    });
    assert.equal(unauthExec.isError, true);
    assert.match(
      getFirstText(unauthExec as { content: Array<{ type: string; text?: string }> }),
      /AUTHORIZATION_REQUIRED/,
    );

    // Unauthenticated cua_reset(scope="page") must NOT launch/navigate Chrome.
    const unauthResetPage = await client.callTool({
      name: 'cua_reset',
      arguments: { scope: 'page' },
    });
    assert.equal(unauthResetPage.isError, true);
    assert.match(
      getFirstText(unauthResetPage as { content: Array<{ type: string; text?: string }> }),
      /AUTHORIZATION_REQUIRED/,
    );

    // cua_authorize with confirm=false must NOT authorize.
    const denyAuth = await client.callTool({
      name: 'cua_authorize',
      arguments: { confirm: false },
    });
    assert.equal(denyAuth.isError, true);

    const authRes = await client.callTool({
      name: 'cua_authorize',
      arguments: { confirm: true, note: 'automated-test' },
    });
    assert.equal(authRes.isError ?? false, false);

    const statusRes = await client.callTool({
      name: 'cua_status',
      arguments: {},
    });
    const statusJson = JSON.parse(
      getFirstText(statusRes as { content: Array<{ type: string; text?: string }> }),
    ) as { authorized: boolean };
    assert.equal(statusJson.authorized, true);

    const firstExec = await client.callTool({
      name: 'cua_exec',
      arguments: {
        code: 'state.x = 40; return state.x + 2;',
        includeSnapshot: false,
      },
    });
    assert.equal(firstExec.isError ?? false, false);
    assert.match(
      getFirstText(firstExec as { content: Array<{ type: string; text?: string }> }),
      /42/,
    );

    const secondExec = await client.callTool({
      name: 'cua_exec',
      arguments: {
        code: 'return state.x + 8;',
        includeSnapshot: false,
      },
    });
    assert.equal(secondExec.isError ?? false, false);
    assert.match(
      getFirstText(secondExec as { content: Array<{ type: string; text?: string }> }),
      /48/,
    );

    // cua_reset(scope="repl") clears state variables.
    const resetRepl = await client.callTool({
      name: 'cua_reset',
      arguments: { scope: 'repl' },
    });
    assert.equal(resetRepl.isError ?? false, false);

    const afterResetExec = await client.callTool({
      name: 'cua_exec',
      arguments: {
        code: 'return state.x ?? null;',
        includeSnapshot: false,
      },
    });
    assert.equal(afterResetExec.isError ?? false, false);
    assert.match(
      getFirstText(afterResetExec as { content: Array<{ type: string; text?: string }> }),
      /null/,
    );

    // cua_reset(scope="browser") succeeds cleanly even when disconnected.
    const resetBrowser = await client.callTool({
      name: 'cua_reset',
      arguments: { scope: 'browser' },
    });
    assert.equal(resetBrowser.isError ?? false, false);

    // Verify control.json & per-PID control file exist and enforce HTTP auth + Host checks.
    const controlRaw = await fs.readFile(path.join(tempDataDir, 'control.json'), 'utf8');
    const control = JSON.parse(controlRaw) as { pid: number; port: number; token: string };
    assert.ok(control.port > 0);
    assert.ok(control.token.length > 0);

    const pidControlRaw = await fs.readFile(
      path.join(tempDataDir, 'controls', `control-${control.pid}.json`),
      'utf8',
    );
    assert.deepEqual(JSON.parse(pidControlRaw), control);

    const noAuthRes = await fetch(`http://127.0.0.1:${control.port}/release`, {
      method: 'POST',
    });
    assert.equal(noAuthRes.status, 401);

    const badToken = '0'.repeat(control.token.length);
    const badAuthRes = await fetch(`http://127.0.0.1:${control.port}/release`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${badToken}` },
    });
    assert.equal(badAuthRes.status, 401);

    const wrongMethodRes = await fetch(`http://127.0.0.1:${control.port}/release`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${control.token}` },
    });
    assert.equal(wrongMethodRes.status, 404);

    const notFoundRes = await fetch(`http://127.0.0.1:${control.port}/unknown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${control.token}` },
    });
    assert.equal(notFoundRes.status, 404);

    // Spoofed Host header via raw HTTP request should return 403.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: control.port,
          path: '/release',
          method: 'POST',
          headers: {
            Host: 'evil.example:9999',
            Authorization: `Bearer ${control.token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(hostStatus, 403);

    // stop-hook.mjs releases cleanly and returns {}.
    const { stdout: hookStdout } = await execFileAsync(
      'node',
      [path.join(pluginRoot, 'scripts', 'stop-hook.mjs')],
      {
        cwd: pluginRoot,
        env: { ...process.env, PLUGIN_DATA: tempDataDir },
      },
    );
    assert.deepEqual(JSON.parse(hookStdout.trim()), {});
  } finally {
    await client.close().catch(() => {});
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('stop-hook.mjs skips release when fullyIdle is false and continues past 401/dead entries', async () => {
  const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cua-hook-'));
  const pluginRoot = process.cwd();
  const controlsDir = path.join(tempDataDir, 'controls');
  await fs.mkdir(controlsDir, { recursive: true });

  let hits = 0;
  const mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/release') {
      if (req.headers.authorization === 'Bearer good-token') {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = (mockServer.address() as { port: number }).port;

  try {
    // Write a failing-auth entry in controls/ and a valid entry in control.json.
    await fs.writeFile(
      path.join(controlsDir, 'control-11111.json'),
      JSON.stringify({ pid: 11111, port, token: 'bad-token' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempDataDir, 'control.json'),
      JSON.stringify({ pid: 22222, port, token: 'good-token' }),
      'utf8',
    );

    const skipOut = await runHookWithStdin(
      pluginRoot,
      { ...process.env, PLUGIN_DATA: tempDataDir },
      JSON.stringify({ fullyIdle: false }),
    );
    assert.deepEqual(JSON.parse(skipOut.trim()), {});
    assert.equal(hits, 0);

    const runOut = await runHookWithStdin(
      pluginRoot,
      { ...process.env, PLUGIN_DATA: tempDataDir },
      JSON.stringify({ fullyIdle: true }),
    );
    assert.deepEqual(JSON.parse(runOut.trim()), {});
    assert.equal(hits, 1);
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

