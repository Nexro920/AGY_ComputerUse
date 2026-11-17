import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserManager } from './browser/manager.js';
import { CONTROL_DIR, CONTROL_FILE } from './config.js';
import { formatError } from './errors.js';
import { ReplRuntime } from './repl/runtime.js';
import {
  getAuthRecord,
  grantAuthorization,
  isAuthorized,
  setBlockedControlPort,
} from './security/auth.js';

const manager = new BrowserManager();
const runtime = new ReplRuntime(manager);

const server = new McpServer({
  name: 'agy-chrome-use',
  version: '0.1.0',
});

const AUTHORIZATION_REQUIRED_TEXT = [
  'AUTHORIZATION_REQUIRED: First-time use of agy-chrome-use requires explicit user approval.',
  'Explain to the user that agy-chrome-use will connect to Chrome (prioritizing an open Chrome window via CDP, or launching a managed Chrome window) and perform clicking, typing, and scrolling on web pages.',
  'Once the user agrees, call `cua_authorize` with `{"confirm": true}`. Subsequent calls will not prompt again.',
].join('\n');

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

async function writeFileAtomic(
  targetPath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode });
  await fs.rename(tmpPath, targetPath);
}

server.registerTool(
  'cua_authorize',
  {
    title: 'Authorize AGY Chrome Use',
    description:
      'Persist one-time user authorization for agy-chrome-use to connect to Chrome and perform page clicks, typing, and scrolling. Call only after the user explicitly approves.',
    inputSchema: {
      confirm: z
        .boolean()
        .describe('Must be true after the user confirms first-use authorization.'),
      note: z
        .string()
        .optional()
        .describe('Optional note recording the authorization context.'),
    },
  },
  async ({ confirm, note }) => {
    if (!confirm) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Authorization not granted because confirm was false.',
          },
        ],
      };
    }
    const record = await grantAuthorization('user-confirmed', note);
    return {
      content: [
        {
          type: 'text',
          text: `Authorization granted and persisted at ${record.grantedAt}. Future sessions will run without prompting.`,
        },
      ],
    };
  },
);

server.registerTool(
  'cua_status',
  {
    title: 'Chrome Use Status',
    description:
      'Check one-time authorization state, active Chrome connection mode (attached-cdp vs managed-profile), and open tabs.',
    inputSchema: {},
  },
  async () => {
    const auth = await getAuthRecord();
    const status = await manager.getStatus();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              authorized: auth?.authorized === true,
              grantedAt: auth?.grantedAt ?? null,
              connection: status,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  'cua_reset',
  {
    title: 'Reset Chrome REPL or Browser',
    description:
      'Reset persistent REPL variables (scope="repl"), navigate active tab to blank (scope="page"), release control cleanly for human handoff without closing managed windows (scope="control"), or disconnect/close Chrome session (scope="browser").',
    inputSchema: {
      scope: z
        .enum(['repl', 'page', 'control', 'browser'])
        .optional()
        .default('repl')
        .describe(
          'What to reset: repl variables, current page, release control for human handoff, or close/disconnect browser.',
        ),
    },
  },
  async ({ scope }) => {
    if (scope === 'repl') {
      runtime.resetRepl();
      return {
        content: [{ type: 'text', text: 'REPL state variables cleared.' }],
      };
    }
    if (scope === 'control') {
      const rel = await manager.releaseControl();
      return {
        content: [
          {
            type: 'text',
            text:
              rel.mode === 'attached-cdp'
                ? 'Released CDP control and hid HUD overlays (user Chrome tabs left open).'
                : 'Hid HUD overlays and kept browser window open for human interaction.',
          },
        ],
      };
    }
    if (scope === 'page') {
      if (!(await isAuthorized())) {
        return {
          isError: true,
          content: [{ type: 'text', text: AUTHORIZATION_REQUIRED_TEXT }],
        };
      }
      try {
        const page = await manager.ensurePage();
        await manager.clearRefs();
        await page.goto('about:blank');
        return {
          content: [{ type: 'text', text: 'Active tab reset to about:blank.' }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatError(err) }],
        };
      }
    }
    await manager.disconnect();
    runtime.resetRepl();
    return {
      content: [
        {
          type: 'text',
          text: 'Browser connection closed/disconnected and REPL reset.',
        },
      ],
    };
  },
);

server.registerTool(
  'cua_exec',
  {
    title: 'Execute Chrome REPL Script',
    description:
      'Run persistent async JavaScript in the Chrome CUA REPL with `cua.*` helpers (goto, snapshot, click, clickAt, type, press, scroll, drag, waitText, waitUrl, screenshot, tabs, newTab, switchTab, text) and persistent `state`. Prefers already-open Chrome via CDP before falling back to a persistent managed Chrome window.',
    inputSchema: {
      code: z
        .string()
        .describe(
          'Async JS body executed inside the persistent REPL (use `await cua.*` and `return ...`).',
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe('Execution timeout in milliseconds (default 30000, max 120000).'),
      includeSnapshot: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include pruned semantic snapshot after execution (default true).'),
      includeScreenshot: z
        .boolean()
        .optional()
        .default(false)
        .describe('Attach a compressed viewport screenshot after execution (default false).'),
    },
  },
  async ({ code, timeoutMs, includeSnapshot, includeScreenshot }) => {
    if (!(await isAuthorized())) {
      return {
        isError: true,
        content: [{ type: 'text', text: AUTHORIZATION_REQUIRED_TEXT }],
      };
    }

    const result = await runtime.execute(code, {
      timeoutMs,
      includeSnapshot,
      includeScreenshot,
    });
    const status = await manager.getStatus();

    const sections: string[] = [];
    sections.push(
      `Status: ${result.ok ? 'OK' : 'ERROR'} | Mode: ${status.mode}${status.diagnostic ? ` (${status.diagnostic})` : ''}`,
    );

    if (result.trace.length > 0) {
      sections.push(
        'Trace:\n' +
          result.trace
            .map(
              (t) =>
                `- ${t.action}${t.detail ? ` ${t.detail}` : ''} (${t.durationMs}ms)`,
            )
            .join('\n'),
      );
    }

    if (result.logs.length > 0) {
      sections.push('Console:\n' + result.logs.join('\n'));
    }

    if (result.value !== undefined) {
      sections.push('Return:\n' + JSON.stringify(result.value, null, 2));
    }

    if (!result.ok && result.error) {
      sections.push('Error:\n' + result.error);
    }

    if (result.screenshots.length > 0) {
      sections.push(
        'Screenshots:\n' +
          result.screenshots.map((s) => `- ${s.filePath}`).join('\n'),
      );
    }

    if (result.snapshot) {
      sections.push('Snapshot:\n' + result.snapshot.formatted);
    }

    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > = [{ type: 'text', text: sections.join('\n\n') }];

    for (const shot of result.screenshots) {
      content.push({
        type: 'image',
        data: shot.base64,
        mimeType: shot.mimeType,
      });
    }

    return {
      isError: !result.ok,
      content,
    };
  },
);

async function pruneDeadControlFiles(): Promise<void> {
  try {
    const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((e) => e.isFile() && /^control-\d+\.json$/.test(e.name))
        .map(async (e) => {
          const full = path.join(CONTROL_DIR, e.name);
          try {
            const parsed = JSON.parse(await fs.readFile(full, 'utf8')) as { pid?: number };
            if (typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)) {
              await fs.unlink(full).catch(() => {});
            }
          } catch {
            await fs.unlink(full).catch(() => {});
          }
        }),
    );
  } catch {
    // Ignore when control dir doesn't exist yet.
  }
}

/** Start a localhost-only control server so lifecycle Stop hooks can release browser control. */
async function startControlServer(): Promise<() => Promise<void>> {
  const token = crypto.randomBytes(24).toString('hex');
  let boundPort = 0;

  const httpServer = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host?.toLowerCase();
    if (
      hostHeader &&
      boundPort > 0 &&
      hostHeader !== `127.0.0.1:${boundPort}` &&
      hostHeader !== `localhost:${boundPort}`
    ) {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden host' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/release') {
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${token}`;
      const valid =
        auth.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      if (!valid) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const result = await manager.releaseControl().catch(() => ({
        released: false,
        mode: 'disconnected' as const,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    res.writeHead(404, { Connection: 'close' });
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  httpServer.unref();

  const addr = httpServer.address();
  boundPort = typeof addr === 'object' && addr ? addr.port : 0;
  setBlockedControlPort(boundPort);

  const payload = JSON.stringify({ pid: process.pid, port: boundPort, token }, null, 2);
  const pidControlFile = path.join(CONTROL_DIR, `control-${process.pid}.json`);

  await pruneDeadControlFiles();
  await writeFileAtomic(pidControlFile, payload, 0o600);
  await writeFileAtomic(CONTROL_FILE, payload, 0o600);

  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    setBlockedControlPort(null);
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.unlink(pidControlFile).catch(() => {});
    try {
      const raw = await fs.readFile(CONTROL_FILE, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: number };
      if (parsed.pid === process.pid) {
        await fs.unlink(CONTROL_FILE).catch(() => {});
      }
    } catch {
      // Ignore missing or concurrently replaced control file.
    }
  };
}

async function main(): Promise<void> {
  const stopControl = await startControlServer().catch(() => async () => {});
  let exiting = false;
  const cleanup = async () => {
    if (exiting) return;
    exiting = true;
    await runtime.dispose().catch(() => {});
    await manager.releaseControl().catch(() => {});
    await stopControl();
  };
  process.once('SIGINT', () => {
    cleanup().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    cleanup().finally(() => process.exit(0));
  });
  process.stdin.once('end', () => {
    cleanup().catch(() => {});
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    cleanup().catch(() => {});
  };
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP server error:', err);
  process.exit(1);
});

