import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_RUNTIME_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    uninstall: false,
    purgeData: false,
    checkOnly: false,
    verify: true,
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    targetDir: path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-chrome-use'),
    dataDir:
      process.env.PLUGIN_DATA?.trim() ||
      path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'agy-chrome-use'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--purge-data') opts.purgeData = true;
    else if (arg === '--check-only') opts.checkOnly = true;
    else if (arg === '--no-verify') opts.verify = false;
    else if (arg === '--runtime-root' && argv[i + 1]) opts.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--target-dir' && argv[i + 1]) opts.targetDir = path.resolve(argv[++i]);
    else if (arg === '--data-dir' && argv[i + 1]) opts.dataDir = path.resolve(argv[++i]);
  }
  return opts;
}

function findChromeBinary() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ].filter(Boolean);

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const out = execFileSync(
          'reg',
          ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const match = /REG_\w+\s+(.+\.exe)/i.exec(out);
        if (match && fs.existsSync(match[1].trim())) {
          return match[1].trim();
        }
      } catch {
        // Ignore missing registry key.
      }
    }

    try {
      const out = execFileSync('where', ['chrome'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const first = out.split(/\r?\n/).find((l) => l.trim() && fs.existsSync(l.trim()));
      if (first) return first.trim();
    } catch {
      // Not on PATH.
    }
    return null;
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? null;
  }

  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const res = spawnSync('which', [bin], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  }
  return null;
}

function getNpmVersion() {
  const res = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status === 0) {
    return res.stdout.trim();
  }
  return null;
}

function hasInstalledDependencies(runtimeRoot) {
  const required = ['@modelcontextprotocol/sdk', 'playwright', 'zod'];
  return required.every((pkg) =>
    fs.existsSync(path.join(runtimeRoot, 'node_modules', ...pkg.split('/'), 'package.json')),
  );
}

function hasBuiltArtifacts(runtimeRoot) {
  return (
    fs.existsSync(path.join(runtimeRoot, 'dist', 'server.js')) &&
    fs.existsSync(path.join(runtimeRoot, 'dist', 'repl', 'repl-worker.js'))
  );
}

function getLatestMtimeMs(dir) {
  let latest = 0;
  if (!fs.existsSync(dir)) return latest;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, getLatestMtimeMs(full));
    } else if (entry.isFile()) {
      latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  }
  return latest;
}

function needsBuild(runtimeRoot) {
  if (!hasBuiltArtifacts(runtimeRoot)) return true;
  const distMtime = Math.min(
    fs.statSync(path.join(runtimeRoot, 'dist', 'server.js')).mtimeMs,
    fs.statSync(path.join(runtimeRoot, 'dist', 'repl', 'repl-worker.js')).mtimeMs,
  );
  const srcMtime = getLatestMtimeMs(path.join(runtimeRoot, 'src'));
  return srcMtime > distMtime;
}

async function checkDirWritable(targetPath) {
  let probe = targetPath;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    await fsp.access(probe, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommandOrThrow(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(' ')}), exit code ${res.status}`);
  }
}

async function removeTargetSafe(targetDir) {
  if (!fs.existsSync(targetDir)) return false;
  const stat = await fsp.lstat(targetDir);
  if (stat.isSymbolicLink()) {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'rmdir', targetDir], { stdio: 'ignore' });
    } else {
      await fsp.unlink(targetDir);
    }
  } else {
    await fsp.rm(targetDir, { recursive: true, force: true });
  }
  return true;
}

async function copyDirRecursive(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

async function verifyInstalledMcp(targetDir) {
  const mcpRaw = await fsp.readFile(path.join(targetDir, 'mcp_config.json'), 'utf8');
  const mcpCfg = JSON.parse(mcpRaw);
  const entry = mcpCfg?.mcpServers?.['agy-chrome-use'];
  if (!entry?.command || !Array.isArray(entry.args)) {
    throw new Error('Installed mcp_config.json is missing mcpServers.agy-chrome-use');
  }

  const tempData = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-cua-verify-'));
  const expandVars = (value) =>
    String(value).replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, k) =>
      k === 'PLUGIN_ROOT' ? targetDir : tempData,
    );
  const resolvedArgs = entry.args.map(expandVars);
  const resolvedEnv = Object.fromEntries(
    Object.entries(entry.env || {}).map(([k, v]) => [k, expandVars(v)]),
  );
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(entry.command, resolvedArgs, {
        cwd: targetDir,
        env: {
          ...process.env,
          ...resolvedEnv,
          PLUGIN_ROOT: targetDir,
          PLUGIN_DATA: tempData,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      let initialized = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`MCP handshake timed out. stderr: ${stderrBuf}`));
      }, 8000);

      child.stderr.on('data', (d) => {
        stderrBuf += String(d);
      });

      child.stdout.on('data', (chunk) => {
        stdoutBuf += String(chunk);
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1 && !initialized) {
              initialized = true;
              child.stdin.write(
                JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
              );
              child.stdin.write(
                JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
              );
            } else if (msg.id === 2) {
              clearTimeout(timer);
              const names = (msg.result?.tools || []).map((t) => t.name).sort();
              child.kill();
              resolve(names);
            }
          } catch {
            // Ignore non-JSON lines.
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'agy-setup-verify', version: '0.1.0' },
          },
        }) + '\n',
      );
    });

    const expected = ['cua_authorize', 'cua_exec', 'cua_reset', 'cua_status'];
    for (const name of expected) {
      if (!result.includes(name)) {
        throw new Error(`Missing expected MCP tool "${name}". Found: ${JSON.stringify(result)}`);
      }
    }
    return result;
  } finally {
    await fsp.rm(tempData, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.uninstall) {
    const removed = await removeTargetSafe(opts.targetDir);
    console.log(
      removed
        ? `[OK] Removed plugin bundle at ${opts.targetDir}`
        : `[INFO] Plugin bundle not found at ${opts.targetDir}`,
    );
    if (opts.purgeData && fs.existsSync(opts.dataDir)) {
      await fsp.rm(opts.dataDir, { recursive: true, force: true });
      console.log(`[OK] Purged plugin data directory at ${opts.dataDir}`);
    } else if (fs.existsSync(opts.dataDir)) {
      console.log(
        `[INFO] Preserved user data (auth/profile) at ${opts.dataDir} (pass --purge-data to remove)`,
      );
    }
    return;
  }

  const nodeMajor = Number(process.versions.node.split('.')[0] || 0);
  const npmVersion = getNpmVersion();
  const chromePath = findChromeBinary();
  const targetWritable = await checkDirWritable(opts.targetDir);
  const dataWritable = await checkDirWritable(opts.dataDir);
  const depsReady = hasInstalledDependencies(opts.runtimeRoot);
  const distReady = hasBuiltArtifacts(opts.runtimeRoot);

  console.log('=== AGY Chrome Use Environment Check ===');
  console.log(`Node.js (>=20): ${nodeMajor >= 20 ? '[OK]' : '[FAIL]'} v${process.versions.node}`);
  console.log(`npm:            ${npmVersion ? `[OK] v${npmVersion}` : '[FAIL] not found'}`);
  console.log(`Google Chrome:  ${chromePath ? `[OK] ${chromePath}` : '[FAIL] not found'}`);
  console.log(`Plugin target:  ${targetWritable ? '[OK]' : '[FAIL]'} ${opts.targetDir}`);
  console.log(`Data directory: ${dataWritable ? '[OK]' : '[FAIL]'} ${opts.dataDir}`);
  console.log(`npm packages:   ${depsReady ? '[OK] installed' : '[PENDING] will install'}`);
  console.log(`Build (dist/):  ${distReady ? '[OK] built' : '[PENDING] will build'}`);

  const blockingFailures = [];
  if (nodeMajor < 20) blockingFailures.push(`Node.js >= 20 required (found v${process.versions.node})`);
  if (!npmVersion) blockingFailures.push('npm CLI is required but was not found on PATH');
  if (!chromePath) blockingFailures.push('Google Chrome executable was not found');
  if (!targetWritable) blockingFailures.push(`Target directory is not writable: ${opts.targetDir}`);
  if (!dataWritable) blockingFailures.push(`Data directory is not writable: ${opts.dataDir}`);

  if (blockingFailures.length > 0) {
    console.error('\n[REFUSED] Environment does not meet minimum requirements:');
    for (const f of blockingFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  if (opts.checkOnly) {
    if (!depsReady || !distReady) {
      console.log('\n[INFO] Prerequisites satisfied; run installer without --check-only to install dependencies & build.');
    } else {
      console.log('\n[OK] All environment and build checks passed.');
    }
    return;
  }

  if (!depsReady) {
    console.log('\n[1/4] Installing npm dependencies...');
    if (fs.existsSync(path.join(opts.runtimeRoot, 'package-lock.json'))) {
      try {
        runCommandOrThrow('npm', ['ci', '--no-audit', '--no-fund'], opts.runtimeRoot);
      } catch {
        runCommandOrThrow('npm', ['install', '--no-audit', '--no-fund'], opts.runtimeRoot);
      }
    } else {
      runCommandOrThrow('npm', ['install', '--no-audit', '--no-fund'], opts.runtimeRoot);
    }
  } else {
    console.log('\n[1/4] Dependencies already installed.');
  }

  if (needsBuild(opts.runtimeRoot)) {
    console.log('[2/4] Building TypeScript sources...');
    runCommandOrThrow('npm', ['run', 'build'], opts.runtimeRoot);
    if (!hasBuiltArtifacts(opts.runtimeRoot)) {
      throw new Error('Build succeeded but dist/server.js or dist/repl/repl-worker.js is missing');
    }
  } else {
    console.log('[2/4] Build artifacts already up to date.');
  }

  console.log(`[3/4] Installing plugin bundle to ${opts.targetDir}...`);
  if (fs.existsSync(opts.targetDir)) {
    const stat = await fsp.lstat(opts.targetDir);
    if (stat.isSymbolicLink()) {
      await removeTargetSafe(opts.targetDir);
    }
  }
  await fsp.mkdir(opts.targetDir, { recursive: true });
  await fsp.mkdir(opts.dataDir, { recursive: true });

  await fsp.copyFile(
    path.join(opts.runtimeRoot, 'plugin.json'),
    path.join(opts.targetDir, 'plugin.json'),
  );
  if (fs.existsSync(path.join(opts.runtimeRoot, 'README.md'))) {
    await fsp.copyFile(
      path.join(opts.runtimeRoot, 'README.md'),
      path.join(opts.targetDir, 'README.md'),
    );
  }

  const mcpCfg = JSON.parse(
    await fsp.readFile(path.join(opts.runtimeRoot, 'mcp_config.json'), 'utf8'),
  );
  if (mcpCfg?.mcpServers?.['agy-chrome-use']) {
    mcpCfg.mcpServers['agy-chrome-use'].env = {
      ...(mcpCfg.mcpServers['agy-chrome-use'].env || {}),
      AGY_CHROME_RUNTIME_ROOT: opts.runtimeRoot,
    };
  }
  await fsp.writeFile(
    path.join(opts.targetDir, 'mcp_config.json'),
    JSON.stringify(mcpCfg, null, 2) + '\n',
    'utf8',
  );

  const installedScriptsDir = path.join(opts.targetDir, 'scripts');
  await fsp.mkdir(installedScriptsDir, { recursive: true });
  const mcpLauncherSrc = path.join(opts.runtimeRoot, 'scripts', 'mcp-launcher.mjs');
  if (fs.existsSync(mcpLauncherSrc)) {
    await fsp.copyFile(mcpLauncherSrc, path.join(installedScriptsDir, 'mcp-launcher.mjs'));
  }

  const stopHookSrc = path.join(opts.runtimeRoot, 'scripts', 'stop-hook.mjs');
  const hooksSrc = path.join(opts.runtimeRoot, 'hooks.json');
  if (fs.existsSync(stopHookSrc)) {
    const installedHook = path.join(installedScriptsDir, 'stop-hook.mjs');
    await fsp.copyFile(stopHookSrc, installedHook);
    if (fs.existsSync(hooksSrc)) {
      const hooksCfg = JSON.parse(await fsp.readFile(hooksSrc, 'utf8'));
      const stopArr = hooksCfg?.['agy-chrome-use-release']?.Stop;
      if (Array.isArray(stopArr) && stopArr.length > 0) {
        stopArr[0].command = `node "${installedHook}"`;
      }
      await fsp.writeFile(
        path.join(opts.targetDir, 'hooks.json'),
        JSON.stringify(hooksCfg, null, 2) + '\n',
        'utf8',
      );
    }
  } else if (fs.existsSync(hooksSrc)) {
    await fsp.copyFile(hooksSrc, path.join(opts.targetDir, 'hooks.json'));
  }

  await fsp.rm(path.join(opts.targetDir, 'assets'), { recursive: true, force: true });
  if (fs.existsSync(path.join(opts.runtimeRoot, 'assets'))) {
    await copyDirRecursive(path.join(opts.runtimeRoot, 'assets'), path.join(opts.targetDir, 'assets'));
  }
  await fsp.rm(path.join(opts.targetDir, 'rules'), { recursive: true, force: true });
  await fsp.rm(path.join(opts.targetDir, 'skills'), { recursive: true, force: true });
  await copyDirRecursive(path.join(opts.runtimeRoot, 'rules'), path.join(opts.targetDir, 'rules'));
  await copyDirRecursive(path.join(opts.runtimeRoot, 'skills'), path.join(opts.targetDir, 'skills'));

  if (opts.verify) {
    console.log('[4/4] Verifying installed MCP server handshake...');
    const tools = await verifyInstalledMcp(opts.targetDir);
    console.log(`[OK] MCP server verified. Registered tools: ${tools.join(', ')}`);
  } else {
    console.log('[4/4] Verification skipped (--no-verify).');
  }

  console.log('\n=== Installation Complete ===');
  console.log(`Plugin directory : ${opts.targetDir}`);
  console.log(`Runtime directory: ${opts.runtimeRoot}`);
  console.log(`Data directory   : ${opts.dataDir}`);
  console.log('\nNext steps:');
  console.log('  1. Ask AGY to open any URL (e.g. "Open https://example.com in Chrome").');
  console.log('  2. Approve the one-time first-use authorization prompt (saved permanently).');
  console.log('  3. Optional: to reuse your logged-in Chrome tabs, turn on chrome://inspect/#remote-debugging in Chrome.');
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
