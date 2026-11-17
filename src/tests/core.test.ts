import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserManager,
  isBlankTabUrl,
  urlsMatchForTabLookup,
} from '../browser/manager.js';
import { CuaError } from '../errors.js';
import { ReplRuntime } from '../repl/runtime.js';
import {
  setBlockedControlPort,
  validateCdpEndpoint,
  validateNavigationUrl,
} from '../security/auth.js';

test('validateNavigationUrl allows http/https/about:blank and blocks unsafe schemes & metadata', () => {
  assert.equal(validateNavigationUrl('https://example.com'), 'https://example.com/');
  assert.equal(validateNavigationUrl('http://localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(validateNavigationUrl('about:blank'), 'about:blank');
  assert.equal(validateNavigationUrl('ABOUT:BLANK'), 'about:blank');

  for (const blocked of [
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/123',
    'chrome://settings',
    'about:crash',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    assert.throws(
      () => validateNavigationUrl(blocked),
      (err: unknown) => err instanceof CuaError && err.code === 'SafetyBlocked',
      `Expected SafetyBlocked for ${blocked}`,
    );
  }

  setBlockedControlPort(45678);
  try {
    assert.throws(
      () => validateNavigationUrl('http://127.0.0.1:45678/release'),
      (err: unknown) => err instanceof CuaError && err.code === 'SafetyBlocked',
    );
  } finally {
    setBlockedControlPort(null);
  }

  for (const invalid of ['', '   ', 'not-a-url']) {
    assert.throws(
      () => validateNavigationUrl(invalid),
      (err: unknown) => err instanceof CuaError && err.code === 'InvalidArgument',
    );
  }
});

test('validateCdpEndpoint allows loopback/chrome and blocks remote SSRF targets', () => {
  assert.equal(validateCdpEndpoint('chrome'), 'chrome');
  assert.equal(validateCdpEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  assert.equal(
    validateCdpEndpoint('ws://localhost:9222/devtools/browser/1'),
    'ws://localhost:9222/devtools/browser/1',
  );

  assert.throws(
    () => validateCdpEndpoint('http://192.168.1.50:9222'),
    (err: unknown) => err instanceof CuaError && err.code === 'SafetyBlocked',
  );
  assert.throws(
    () => validateCdpEndpoint('http://169.254.169.254/'),
    (err: unknown) => err instanceof CuaError && err.code === 'SafetyBlocked',
  );
  assert.throws(
    () => validateCdpEndpoint('file:///C:/test'),
    (err: unknown) => err instanceof CuaError && err.code === 'SafetyBlocked',
  );
  assert.throws(
    () => validateCdpEndpoint(''),
    (err: unknown) => err instanceof CuaError && err.code === 'InvalidArgument',
  );
});

test('ReplRuntime preserves state across executions, supports URL, and blocks Node globals & prototype escapes', async () => {
  const manager = new BrowserManager();
  const runtime = new ReplRuntime(manager);

  try {
    const first = await runtime.execute(
      'state.count = (state.count || 0) + 1; console.log("step1"); return state.count;',
      { includeSnapshot: false },
    );
    assert.equal(first.ok, true);
    assert.equal(first.value, 1);
    assert.deepEqual(first.logs, ['step1']);

    const second = await runtime.execute(
      'state.count += 4; const u = new URL("https://example.com/path?a=1&b=2"); return { count: state.count, host: u.hostname, a: u.searchParams.get("a") };',
      { includeSnapshot: false },
    );
    assert.equal(second.ok, true);
    assert.deepEqual(second.value, { count: 5, host: 'example.com', a: '1' });

    const blocked = await runtime.execute(
      'return typeof process === "undefined" && typeof require === "undefined";',
      { includeSnapshot: false },
    );
    assert.equal(blocked.ok, true);
    assert.equal(blocked.value, true);

    const escapeAttempts = [
      'return ({}).constructor.constructor("return process")();',
      'return state.constructor.constructor("return process")();',
      'return cua.url.constructor.constructor("return process")();',
      'return sleep.constructor.constructor("return process")();',
      'return console.log.constructor.constructor("return process")();',
      'return (new URL("https://example.com")).constructor.constructor("return process")();',
      'return { then(res) { return res.constructor("return process")(); } };',
      'Promise.prototype.then = function(r) { return r && r.constructor ? r.constructor("return process")() : null; }; return 123;',
    ];

    for (const attempt of escapeAttempts.slice(0, 7)) {
      const res = await runtime.execute(attempt, { includeSnapshot: false });
      assert.equal(res.ok, false, `Escape attempt should fail: ${attempt}`);
      assert.match(res.error ?? '', /EvalError|Code generation from strings disallowed/i);
    }

    const thenTamper = await runtime.execute(escapeAttempts[7], { includeSnapshot: false });
    assert.equal(thenTamper.ok, true);
    assert.equal(thenTamper.value, 123);

    runtime.resetRepl();
    const afterReset = await runtime.execute(
      'return state.count ?? null;',
      { includeSnapshot: false },
    );
    assert.equal(afterReset.ok, true);
    assert.equal(afterReset.value, null);
  } finally {
    await runtime.dispose();
  }
});

test('ReplRuntime terminates async sleep and async infinite loops cleanly without freezing', async () => {
  const manager = new BrowserManager();
  const runtime = new ReplRuntime(manager);

  try {
    const setup = await runtime.execute('state.saved = "ok"; return true;', {
      includeSnapshot: false,
    });
    assert.equal(setup.ok, true);

    const sleepTimeout = await runtime.execute('await sleep(2500); return "done";', {
      timeoutMs: 1000,
      includeSnapshot: false,
    });
    assert.equal(sleepTimeout.ok, false);
    assert.match(sleepTimeout.error ?? '', /\[Timeout\]/);

    const infiniteLoop = await runtime.execute(
      'await sleep(10); while (true) {}',
      {
        timeoutMs: 1000,
        includeSnapshot: false,
      },
    );
    assert.equal(infiniteLoop.ok, false);
    assert.match(infiniteLoop.error ?? '', /\[Timeout\]/);

    const recovered = await runtime.execute('return state.saved ?? null;', {
      includeSnapshot: false,
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.value, 'ok');
  } finally {
    await runtime.dispose();
  }
});

test('ReplRuntime serializes concurrent execute calls without interleaving logs', async () => {
  const manager = new BrowserManager();
  const runtime = new ReplRuntime(manager);

  try {
    const [a, b] = await Promise.all([
      runtime.execute('console.log("first-start"); await sleep(80); console.log("first-end"); state.seq = ["a"]; return 1;', {
        includeSnapshot: false,
      }),
      runtime.execute('console.log("second"); state.seq.push("b"); return state.seq;', {
        includeSnapshot: false,
      }),
    ]);

    assert.equal(a.ok, true);
    assert.deepEqual(a.logs, ['first-start', 'first-end']);
    assert.equal(b.ok, true);
    assert.deepEqual(b.logs, ['second']);
    assert.deepEqual(b.value, ['a', 'b']);
  } finally {
    await runtime.dispose();
  }
});

test('urlsMatchForTabLookup and isBlankTabUrl match existing tabs accurately', () => {
  assert.equal(
    urlsMatchForTabLookup(
      'http://110.189.152.111:8082/resource/equipManage',
      'http://110.189.152.111:8082/resource/equipManage/',
    ),
    true,
  );
  assert.equal(
    urlsMatchForTabLookup(
      'http://110.189.152.111:8082/resource/equipManage?tab=1',
      'http://110.189.152.111:8082/resource/equipManage',
    ),
    false,
  );
  assert.equal(
    urlsMatchForTabLookup(
      'https://example.com/#/a',
      'https://example.com/#/b',
    ),
    false,
  );
  assert.equal(isBlankTabUrl('about:blank'), true);
  assert.equal(isBlankTabUrl('chrome://newtab'), true);
  assert.equal(isBlankTabUrl('chrome://newtab/'), true);
  assert.equal(isBlankTabUrl('edge://newtab/'), true);
  assert.equal(isBlankTabUrl('https://example.com'), false);
});

