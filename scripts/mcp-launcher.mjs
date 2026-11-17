import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REQUIRED_PACKAGES = ['@modelcontextprotocol/sdk', 'playwright', 'zod'];

function logErr(msg) {
  process.stderr.write(`[agy-chrome-use] ${msg}\n`);
}

function hasBuiltServer(dir) {
  return Boolean(
    dir &&
      fs.existsSync(path.join(dir, 'dist', 'server.js')) &&
      fs.existsSync(path.join(dir, 'dist', 'repl', 'repl-worker.js')) &&
      fs.existsSync(path.join(dir, 'package.json')),
  );
}

function hasRequiredPackages(dir) {
  return Boolean(
    dir &&
      REQUIRED_PACKAGES.every((pkg) =>
        fs.existsSync(path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json')),
      ),
  );
}

function findSourceRoot() {
  const candidates = [
    process.env.AGY_CHROME_RUNTIME_ROOT?.trim(),
    process.env.PLUGIN_ROOT?.trim(),
    path.resolve(__dirname, '..'),
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (hasBuiltServer(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function collectFilesSorted(rootDir, currentDir = rootDir, out = []) {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFilesSorted(rootDir, full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      out.push({ rel, full });
    }
  }
  return out;
}

async function computeDistHash(distDir) {
  const hash = crypto.createHash('sha256');
  const files = await collectFilesSorted(distDir);
  for (const file of files) {
    hash.update(file.rel);
    hash.update('\0');
    hash.update(await fsp.readFile(file.full));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function computeDepsHash(pkgJson) {
  const deps = pkgJson?.dependencies || {};
  const ordered = Object.keys(deps)
    .sort()
    .reduce((acc, k) => {
      acc[k] = deps[k];
      return acc;
    }, {});
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

async function copyDirClean(srcDir, destDir) {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirClean(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

async function withInstallLock(lockDir, fn) {
  await fsp.mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await fsp.mkdir(lockDir);
      break;
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (code !== 'EEXIST') throw err;
      try {
        const stat = await fsp.stat(lockDir);
        if (Date.now() - stat.mtimeMs > 180_000) {
          await fsp.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for runtime bootstrap lock at ${lockDir}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runNpmInstall(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
      // Critical: keep stdout untouched because MCP stdio uses stdout for JSON-RPC.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let errTail = '';
    const forwardErr = (chunk) => {
      const text = String(chunk);
      errTail = (errTail + text).slice(-4000);
      process.stderr.write(text);
    };
    child.stdout.on('data', forwardErr);
    child.stderr.on('data', forwardErr);
    child.on('error', (err) => {
      reject(new Error(`Failed to invoke npm (${args.join(' ')}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm ${args.join(' ')} exited with code ${code}: ${errTail.trim()}`));
      }
    });
  });
}

async function prepareMarketplaceRuntime(sourceRoot, dataRoot) {
  const runtimeDir = path.join(dataRoot, 'runtime');
  const lockDir = path.join(dataRoot, '.runtime-bootstrap.lock');
  const stampPath = path.join(runtimeDir, '.runtime-stamp.json');

  const pkgText = await fsp.readFile(path.join(sourceRoot, 'package.json'), 'utf8');
  const pkgJson = JSON.parse(pkgText);
  const distHash = await computeDistHash(path.join(sourceRoot, 'dist'));
  const depsHash = computeDepsHash(pkgJson);

  const readStamp = async () => {
    try {
      return JSON.parse(await fsp.readFile(stampPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const isUpToDate = (stamp) =>
    Boolean(
      stamp &&
        stamp.distHash === distHash &&
        stamp.depsHash === depsHash &&
        hasBuiltServer(runtimeDir) &&
        hasRequiredPackages(runtimeDir),
    );

  const initialStamp = await readStamp();
  if (isUpToDate(initialStamp)) {
    return path.join(runtimeDir, 'dist', 'server.js');
  }

  await withInstallLock(lockDir, async () => {
    const currentStamp = await readStamp();
    if (isUpToDate(currentStamp)) {
      return;
    }

    await fsp.mkdir(runtimeDir, { recursive: true });

    const needDistSync = !currentStamp || currentStamp.distHash !== distHash || !hasBuiltServer(runtimeDir);
    if (needDistSync) {
      await copyDirClean(path.join(sourceRoot, 'dist'), path.join(runtimeDir, 'dist'));
    }

    const needDepsInstall =
      !hasRequiredPackages(runtimeDir) || (currentStamp?.depsHash && currentStamp.depsHash !== depsHash);
    if (needDepsInstall) {
      logErr(`Installing runtime dependencies into ${runtimeDir} (first-time setup)...`);
      await fsp.writeFile(path.join(runtimeDir, 'package.json'), pkgText, 'utf8');
      const lockSrc = path.join(sourceRoot, 'package-lock.json');
      const hasLock = fs.existsSync(lockSrc);
      if (hasLock) {
        await fsp.copyFile(lockSrc, path.join(runtimeDir, 'package-lock.json'));
      }

      let installed = false;
      if (hasLock) {
        try {
          await runNpmInstall(['ci', '--omit=dev', '--no-audit', '--no-fund'], runtimeDir);
          installed = true;
        } catch {
          logErr('npm ci fallback to npm install...');
        }
      }
      if (!installed) {
        await runNpmInstall(['install', '--omit=dev', '--no-audit', '--no-fund'], runtimeDir);
      }
      if (!hasRequiredPackages(runtimeDir)) {
        throw new Error(`Runtime dependency bootstrap completed but packages are still missing under ${runtimeDir}`);
      }
    } else if (!fs.existsSync(path.join(runtimeDir, 'package.json'))) {
      await fsp.writeFile(path.join(runtimeDir, 'package.json'), pkgText, 'utf8');
    }

    await fsp.writeFile(
      stampPath,
      JSON.stringify({ distHash, depsHash, updatedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  });

  return path.join(runtimeDir, 'dist', 'server.js');
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0] || 0);
  if (nodeMajor < 20) {
    logErr(`Node.js >= 20 is required (found v${process.versions.node}). Install Node.js LTS and retry.`);
    process.exit(1);
  }

  const sourceRoot = findSourceRoot();
  if (!sourceRoot) {
    logErr(
      'agy-chrome-use built runtime (dist/server.js) not found. Reinstall the plugin or run `npm run build` in the repository.',
    );
    process.exit(1);
  }

  if (!process.env.PLUGIN_ROOT?.trim()) {
    process.env.PLUGIN_ROOT = sourceRoot;
  }

  let serverEntry;
  if (hasRequiredPackages(sourceRoot)) {
    serverEntry = path.join(sourceRoot, 'dist', 'server.js');
  } else {
    const dataRoot =
      process.env.PLUGIN_DATA?.trim() ||
      path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'agy-chrome-use');
    process.env.PLUGIN_DATA = dataRoot;
    serverEntry = await prepareMarketplaceRuntime(sourceRoot, dataRoot);
  }

  await import(pathToFileURL(serverEntry).href);
}

main().catch((err) => {
  logErr(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
