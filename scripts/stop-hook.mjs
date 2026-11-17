import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function readStdin(timeoutMs = 300) {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      process.stdin.pause();
      process.stdin.unref?.();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function getCandidateDataDirs() {
  const dirs = [
    process.env.PLUGIN_DATA?.trim(),
    path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-chrome-use'),
    path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'agy-chrome-use'),
  ].filter(Boolean);
  return [...new Set(dirs)];
}

async function getControlFilePaths() {
  const files = [];
  for (const dir of getCandidateDataDirs()) {
    const controlsDir = path.join(dir, 'controls');
    try {
      const entries = await fs.readdir(controlsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /^control-\d+\.json$/.test(entry.name)) {
          files.push(path.join(controlsDir, entry.name));
        }
      }
    } catch {
      // Directory may not exist.
    }
    files.push(path.join(dir, 'control.json'));
  }
  return files;
}

async function main() {
  const raw = await readStdin();
  try {
    if (raw.trim()) {
      const payload = JSON.parse(raw);
      if (payload?.fullyIdle === false) {
        process.stdout.write('{}\n');
        return;
      }
    }
  } catch {
    // Proceed even if stdin is malformed.
  }

  const seenEndpoints = new Set();
  const controlFiles = await getControlFilePaths();

  for (const filePath of controlFiles) {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const { port, token } = JSON.parse(text);
      if (!port || !token) continue;

      const endpointKey = `${port}:${token}`;
      if (seenEndpoints.has(endpointKey)) continue;
      seenEndpoints.add(endpointKey);

      const res = await fetch(`http://127.0.0.1:${port}/release`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Connection: 'close',
        },
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) {
        continue;
      }
    } catch {
      // Server may not be running or control file belongs to an exited process.
    }
  }

  process.stdout.write('{}\n');
}

main()
  .catch(() => {
    process.stdout.write('{}\n');
  })
  .finally(() => {
    process.exitCode = 0;
  });

