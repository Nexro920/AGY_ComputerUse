import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

test('Browser integration: perception masking, Shadow DOM, occlusion, CSP HUD, settle, dialogs, tabs & screenshot pruning', async () => {
  const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cua-browser-'));
  process.env.PLUGIN_DATA = tempDataDir;

  const [
    { BrowserManager },
    { ReplRuntime },
    { CuaError },
    { captureSnapshot, captureScreenshot },
    { hudShowStatus, hudMoveCursor, hudClickRipple, hudSetIdle, hudHideTransient },
    { autoSettle },
    { SCREENSHOT_DIR },
  ] = await Promise.all([
    import('../browser/manager.js'),
    import('../repl/runtime.js'),
    import('../errors.js'),
    import('../browser/perception.js'),
    import('../browser/hud.js'),
    import('../browser/settle.js'),
    import('../config.js'),
  ]);

  const cdpPort = await getFreePort();
  const headlessChrome = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [`--remote-debugging-port=${cdpPort}`],
  });

  const testServer = http.createServer((req, res) => {
    if (req.url === '/csp') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'",
      });
      res.end(`<!doctype html><html><body>
        <button id="csp-btn">CSP Button</button>
        <div id="settle-target">initial</div>
      </body></html>`);
      return;
    }

    if (req.url === '/popup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Popup Window</title></head><body><h1>Popup Page</h1></body></html>');
      return;
    }

    if (req.url === '/second') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Second Page</title></head><body><h1>Second Page</h1></body></html>');
      return;
    }

    if (req.url === '/redirect-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head><title>Test App</title></head>
<body style="margin:0;padding:16px;font-family:sans-serif;">
  <div id="status">init</div>
  <input type="password" id="pwd" value="SuperSecret123" placeholder="Password" />
  <input type="text" id="username" value="old-user" placeholder="Username" />
  <select id="role-sel">
    <option value="viewer">Viewer</option>
    <option value="admin">Admin</option>
  </select>

  <div id="shadow-host"></div>
  <button id="detach-btn">Detachable</button>

  <div style="position:relative;width:160px;height:40px;margin-top:8px;">
    <button id="badged-btn" style="width:160px;height:40px;" onclick="document.getElementById('status').textContent='badged-clicked'">Badged Button</button>
    <span id="center-badge" style="position:absolute;left:60px;top:10px;width:40px;height:20px;background:red;"></span>
  </div>

  <div style="position:relative;width:160px;height:40px;margin-top:8px;">
    <button id="covered-btn" style="width:160px;height:40px;">Covered Button</button>
    <div id="full-cover" style="position:absolute;inset:0;background:rgba(0,0,0,0.5);"></div>
  </div>

  <button id="partial-inview" onclick="document.getElementById('status').textContent='wrong-partial'">Confirm Settings Draft</button>
  <button id="alert-btn" onclick="alert('hello-alert'); document.getElementById('status').textContent='after-alert';">Trigger Alert</button>
  <a id="popup-link" href="/popup" target="_blank">Open Popup</a>
  <div tabindex="" id="empty-tabindex">Not Interactive</div>

  <div style="height:1600px;"></div>
  <button id="exact-offscreen" onclick="document.getElementById('status').textContent='exact-confirm'">Confirm</button>

  <script>
    const host = document.getElementById('shadow-host');
    const sr = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.id = 'shadow-btn';
    btn.textContent = 'Shadow Action';
    btn.addEventListener('click', () => {
      document.getElementById('status').textContent = 'shadow-clicked';
    });
    sr.appendChild(btn);
  </script>
</body>
</html>`);
  });

  await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
  const httpPort = (testServer.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  const manager = new BrowserManager();
  const runtime = new ReplRuntime(manager);

  try {
    // 1. Attach over CDP and navigate to /main
    const attachRes = await runtime.execute(
      `await cua.attach("http://127.0.0.1:${cdpPort}"); return await cua.goto("${baseUrl}/");`,
      { includeSnapshot: true },
    );
    assert.equal(attachRes.ok, true, attachRes.error ?? '');
    assert.ok(attachRes.snapshot);

    // Password masking & empty tabindex exclusion & Shadow DOM extraction
    const pwdNode = attachRes.snapshot.nodes.find((n) => n.placeholder === 'Password');
    assert.ok(pwdNode);
    assert.equal(pwdNode.value, '***');
    assert.ok(!attachRes.snapshot.formatted.includes('SuperSecret123'));
    assert.equal(
      attachRes.snapshot.nodes.some((n) => n.name === 'Not Interactive'),
      false,
    );
    const shadowNode = attachRes.snapshot.nodes.find((n) => n.name === 'Shadow Action');
    assert.ok(shadowNode, 'Shadow DOM button should appear in snapshot');

    // 2. Shadow DOM click (by ref) must NOT false-positive Occluded against Shadow Host
    const shadowClick = await runtime.execute(
      `await cua.click("${shadowNode.ref}"); return await cua.text();`,
      { includeSnapshot: false },
    );
    assert.equal(shadowClick.ok, true, shadowClick.error ?? '');
    assert.match(String(shadowClick.value), /^shadow-clicked/);

    // 3. Center-badged button clicks cleanly via fallback inset probe points
    const badgedClick = await runtime.execute(
      `await cua.click("css=#badged-btn"); return await cua.text();`,
      { includeSnapshot: false },
    );
    assert.equal(badgedClick.ok, true, badgedClick.error ?? '');
    assert.match(String(badgedClick.value), /^badged-clicked/);

    // 4. Fully covered button throws [Occluded]
    const coveredClick = await runtime.execute(
      `await cua.click("css=#covered-btn");`,
      { includeSnapshot: false },
    );
    assert.equal(coveredClick.ok, false);
    assert.match(coveredClick.error ?? '', /\[Occluded\]/);

    // 5. Invalid CSS selector throws [InvalidArgument]
    const badSelector = await runtime.execute(
      `await cua.click("css=div[");`,
      { includeSnapshot: false },
    );
    assert.equal(badSelector.ok, false);
    assert.match(badSelector.error ?? '', /\[InvalidArgument\]/);

    // 6. Missing ref throws [ElementNotFound]; removed node throws [ElementDetached]
    const missingRef = await runtime.execute(
      `await cua.click("e9999");`,
      { includeSnapshot: false },
    );
    assert.equal(missingRef.ok, false);
    assert.match(missingRef.error ?? '', /\[ElementNotFound\]/);

    const activePage = await manager.ensurePage();
    const detachSnap = await captureSnapshot(activePage, { viewportOnly: true });
    const detachNode = detachSnap.nodes.find((n) => n.name === 'Detachable');
    assert.ok(detachNode);
    await activePage.evaluate(() => document.getElementById('detach-btn')?.remove());
    const detachedRes = await runtime.execute(
      `await cua.click("${detachNode.ref}");`,
      { includeSnapshot: false },
    );
    assert.equal(detachedRes.ok, false);
    assert.match(detachedRes.error ?? '', /\[ElementDetached\]/);

    // 7. Exact offscreen text match ("Confirm") beats in-viewport substring ("Confirm Settings Draft")
    const exactMatchRes = await runtime.execute(
      `await cua.click("Confirm"); return await cua.text();`,
      { includeSnapshot: false },
    );
    assert.equal(exactMatchRes.ok, true, exactMatchRes.error ?? '');
    assert.match(String(exactMatchRes.value), /^exact-confirm/);

    // 8. Type & native <select>
    const formRes = await runtime.execute(
      `
        await cua.type("css=#username", "alice");
        await cua.select("css=#role-sel", "admin");
        const snap = await cua.snapshot({ viewportOnly: false });
        const userNode = snap.nodes.find((n) => n.placeholder === "Username");
        const roleNode = snap.nodes.find((n) => n.tag === "select");
        return { user: userNode?.value, role: roleNode?.value };
      `,
      { includeSnapshot: false },
    );
    assert.equal(formRes.ok, true, formRes.error ?? '');
    assert.deepEqual(formRes.value, { user: 'alice', role: 'Admin' });

    // 9. Native dialog (alert) auto-dismisses without deadlocking & logs warning
    const dialogRes = await runtime.execute(
      `await cua.click("css=#alert-btn"); return await cua.text();`,
      { includeSnapshot: false },
    );
    assert.equal(dialogRes.ok, true, dialogRes.error ?? '');
    assert.match(String(dialogRes.value), /^after-alert/);
    assert.ok(
      dialogRes.logs.some((l) => l.includes('[dialog:alert]') && l.includes('hello-alert')),
      `Expected dialog warning in logs, got: ${JSON.stringify(dialogRes.logs)}`,
    );

    // 10. Popup (target="_blank") auto-follow + tab management
    const popupRes = await runtime.execute(
      `
        await cua.click("css=#popup-link");
        await sleep(200);
        const url = await cua.url();
        const title = await cua.title();
        await cua.newTab("${baseUrl}/second");
        const tabs = await cua.tabs();
        await cua.switchTab("Test App");
        const switchedTitle = await cua.title();
        return { url, title, tabCount: tabs.length, switchedTitle };
      `,
      { includeSnapshot: false },
    );
    assert.equal(popupRes.ok, true, popupRes.error ?? '');
    assert.deepEqual(popupRes.value, {
      url: `${baseUrl}/popup`,
      title: 'Popup Window',
      tabCount: 3,
      switchedTitle: 'Test App',
    });

    // 11. Hover, scroll, drag, waitText, waitUrl, back, forward, reload, closeTab & includeScreenshot
    const extraRes = await runtime.execute(
      `
        await cua.hover("css=#badged-btn");
        await cua.scroll("down", 200);
        await cua.drag("css=#badged-btn", "css=#username");
        await cua.goto("${baseUrl}/second", { currentTab: true });
        await cua.waitUrl("/second", 3000);
        await cua.waitText("Second Page", 3000);
        const backRes = await cua.back();
        const fwdRes = await cua.forward();
        const reloadRes = await cua.reload();
        return { backUrl: backRes.url, fwdUrl: fwdRes.url, reloadTitle: reloadRes.title };
      `,
      { includeSnapshot: true, includeScreenshot: true },
    );
    assert.equal(extraRes.ok, true, extraRes.error ?? '');
    assert.equal(extraRes.screenshots.length, 1);
    assert.equal(extraRes.screenshots[0].mimeType, 'image/jpeg');
    assert.deepEqual(extraRes.value, {
      backUrl: `${baseUrl}/`,
      fwdUrl: `${baseUrl}/second`,
      reloadTitle: 'Second Page',
    });

    await manager.closeTab();

    // 12. Strict CSP page HUD injection (no unsafe-eval!) + hudHideTransient + autoSettle
    const cspPage = await manager.newTab(`${baseUrl}/csp`);
    await hudShowStatus(cspPage, 'CSP Check');
    await hudMoveCursor(cspPage, 40, 40, { x: 10, y: 10, width: 80, height: 30 });
    await hudClickRipple(cspPage, 40, 40);

    const hudVisibleState = await cspPage.evaluate(() => {
      const host = document.getElementById('__agy_chrome_use_hud__');
      const shadow = host?.shadowRoot;
      return {
        hasHost: Boolean(host),
        pillVisible: shadow?.getElementById('pill')?.classList.contains('visible') ?? false,
        curVisible: shadow?.getElementById('cur')?.classList.contains('visible') ?? false,
        hlVisible: shadow?.getElementById('hl')?.classList.contains('visible') ?? false,
      };
    });
    assert.deepEqual(hudVisibleState, {
      hasHost: true,
      pillVisible: true,
      curVisible: true,
      hlVisible: true,
    });

    await hudSetIdle(cspPage, { x: 40, y: 40 });
    const hudIdleState = await cspPage.evaluate(() => {
      const shadow = document.getElementById('__agy_chrome_use_hud__')?.shadowRoot;
      return {
        pillVisible: shadow?.getElementById('pill')?.classList.contains('visible') ?? false,
        curVisible: shadow?.getElementById('cur')?.classList.contains('visible') ?? false,
        hlVisible: shadow?.getElementById('hl')?.classList.contains('visible') ?? true,
      };
    });
    assert.deepEqual(hudIdleState, {
      pillVisible: true,
      curVisible: true,
      hlVisible: false,
    });

    await hudHideTransient(cspPage);
    const hudHiddenState = await cspPage.evaluate(() => {
      const shadow = document.getElementById('__agy_chrome_use_hud__')?.shadowRoot;
      return {
        pillVisible: shadow?.getElementById('pill')?.classList.contains('visible') ?? true,
        curVisible: shadow?.getElementById('cur')?.classList.contains('visible') ?? true,
        hlVisible: shadow?.getElementById('hl')?.classList.contains('visible') ?? true,
      };
    });
    assert.deepEqual(hudHiddenState, {
      pillVisible: false,
      curVisible: false,
      hlVisible: false,
    });

    // Verify autoSettle waits for DOM mutations and completes cleanly
    await cspPage.evaluate(() => {
      setTimeout(() => {
        const el = document.getElementById('settle-target');
        if (el) el.textContent = 'settled-ok';
      }, 60);
    });
    await autoSettle(cspPage, { quietMs: 120, maxWaitMs: 1000 });
    const settledText = await cspPage.evaluate(
      () => document.getElementById('settle-target')?.textContent,
    );
    assert.equal(settledText, 'settled-ok');

    // 13. Screenshot capture + pruneOldScreenshots(20)
    for (let i = 0; i < 22; i++) {
      await captureScreenshot(cspPage, { format: i % 2 === 0 ? 'jpeg' : 'png' });
    }
    await new Promise((r) => setTimeout(r, 150));
    const savedShots = await fs.readdir(SCREENSHOT_DIR);
    assert.ok(
      savedShots.length <= 20,
      `Expected <= 20 pruned screenshots, got ${savedShots.length}`,
    );

    // 14. autoSettle ignores HUD mutations and honors maxWaitMs hard cap under continuous DOM churn
    await cspPage.evaluate(() => {
      const iv = setInterval(() => {
        const hud = document.getElementById('__agy_chrome_use_hud__');
        if (hud) hud.setAttribute('data-tick', String(Date.now()));
      }, 25);
      (window as unknown as Record<string, unknown>).__hudTick = iv;
    });
    const tHudStart = Date.now();
    await autoSettle(cspPage, { quietMs: 120, maxWaitMs: 900 });
    const hudElapsed = Date.now() - tHudStart;
    assert.ok(hudElapsed < 700, `autoSettle should ignore HUD mutations, took ${hudElapsed}ms`);

    await cspPage.evaluate(() => {
      clearInterval((window as unknown as Record<string, number>).__hudTick);
      const iv = setInterval(() => {
        const el = document.getElementById('settle-target');
        if (el) el.textContent = String(Date.now());
      }, 20);
      (window as unknown as Record<string, unknown>).__domChurn = iv;
    });
    const tCapStart = Date.now();
    await autoSettle(cspPage, { quietMs: 150, maxWaitMs: 400 });
    const capElapsed = Date.now() - tCapStart;
    await cspPage.evaluate(() => {
      clearInterval((window as unknown as Record<string, number>).__domChurn);
    });
    assert.ok(capElapsed >= 350 && capElapsed < 1200, `Expected maxWaitMs cap near 400ms, got ${capElapsed}ms`);

    // 15. maxNodes truncation, clearRefs(), out-of-bounds coordinates, SSRF attach block, and stale cross-tab ref
    const testAppPage = await manager.newTab(`${baseUrl}/`);
    const maxNodesSnap = await captureSnapshot(testAppPage, {
      viewportOnly: true,
      maxNodes: 3,
    });
    assert.equal(maxNodesSnap.nodes.length, 3);
    const staleRef = maxNodesSnap.nodes[0].ref;

    const badCoordRes = await runtime.execute(
      `await cua.clickAt(-5, 10);`,
      { includeSnapshot: false },
    );
    assert.equal(badCoordRes.ok, false);
    assert.match(badCoordRes.error ?? '', /\[InvalidArgument\]/);

    const ssrfAttachRes = await runtime.execute(
      `await cua.attach("http://192.168.1.50:9222");`,
      { includeSnapshot: false },
    );
    assert.equal(ssrfAttachRes.ok, false);
    assert.match(ssrfAttachRes.error ?? '', /\[SafetyBlocked\]/);

    // Switch to another tab and attempt to click ref captured on Test App -> must reject as stale!
    await manager.switchTab('Popup Window');
    const staleRefRes = await runtime.execute(
      `await cua.click("${staleRef}");`,
      { includeSnapshot: false },
    );
    assert.equal(staleRefRes.ok, false);
    assert.match(staleRefRes.error ?? '', /\[ElementNotFound\]/);

    // clearRefs() also invalidates refs on the same page
    await manager.switchTab('Test App');
    await manager.clearRefs();
    const clearedRefRes = await runtime.execute(
      `await cua.click("${staleRef}");`,
      { includeSnapshot: false },
    );
    assert.equal(clearedRefRes.ok, false);
    assert.match(clearedRefRes.error ?? '', /\[ElementNotFound\]/);

    // 16. openOrSwitchUrl branches (reused-blank, switched, current-tab) + 302 redirect SafetyBlocked
    const blankPage = await manager.newTab();
    assert.equal(blankPage.url(), 'about:blank');
    const reused = await manager.openOrSwitchUrl(`${baseUrl}/fresh-tab`);
    assert.equal(reused.action, 'reused-blank');
    const switchedAgain = await manager.openOrSwitchUrl(`${baseUrl}/popup`);
    assert.equal(switchedAgain.action, 'switched');
    const currentTabAction = await manager.openOrSwitchUrl(`${baseUrl}/second`, { currentTab: true });
    assert.equal(currentTabAction.action, 'current-tab');

    const redirRes = await runtime.execute(
      `await cua.goto("${baseUrl}/redirect-metadata", { currentTab: true });`,
      { includeSnapshot: false },
    );
    assert.equal(redirRes.ok, false);
    assert.match(redirRes.error ?? '', /\[SafetyBlocked\]/);

    // 17. Cursor persists after runtime.execute steps and hides completely on releaseControl()
    await manager.switchTab('Test App');
    await runtime.execute(`await cua.snapshot({ viewportOnly: true });`, {
      includeSnapshot: false,
    });
    const activePageBeforeRelease = manager.getActivePage();
    assert.ok(activePageBeforeRelease);
    const activeUrlBeforeRelease = activePageBeforeRelease.url();
    const activeCursorBeforeRelease = await activePageBeforeRelease.evaluate(() => {
      const shadow = document.getElementById('__agy_chrome_use_hud__')?.shadowRoot;
      return {
        curVisible: shadow?.getElementById('cur')?.classList.contains('visible') ?? false,
        pillVisible: shadow?.getElementById('pill')?.classList.contains('visible') ?? false,
      };
    });
    assert.deepEqual(activeCursorBeforeRelease, {
      curVisible: true,
      pillVisible: true,
    });

    const rel = await manager.releaseControl();
    assert.equal(rel.released, true);
    assert.equal(rel.mode, 'attached-cdp');
    assert.equal((await manager.getStatus()).mode, 'disconnected');
    assert.equal(headlessChrome.isConnected(), true);
    await manager.attachCdp(`http://127.0.0.1:${cdpPort}`);
    const reattached = await manager.switchTab('Test App');
    assert.equal(reattached.url(), activeUrlBeforeRelease);
    const activeCursorAfterRelease = await reattached.evaluate(() => {
      const shadow = document.getElementById('__agy_chrome_use_hud__')?.shadowRoot;
      return {
        curVisible: shadow?.getElementById('cur')?.classList.contains('visible') ?? true,
        pillVisible: shadow?.getElementById('pill')?.classList.contains('visible') ?? true,
      };
    });
    assert.deepEqual(activeCursorAfterRelease, {
      curVisible: false,
      pillVisible: false,
    });

    assert.equal(new CuaError('ElementNotFound', 'check').code, 'ElementNotFound');

    // 18. Auth persistence grant/get/revoke inside isolated tempDataDir
    const { grantAuthorization, getAuthRecord, isAuthorized, revokeAuthorization } = await import(
      '../security/auth.js'
    );
    assert.equal(await isAuthorized(), false);
    await grantAuthorization('test-suite', 'integration');
    assert.equal(await isAuthorized(), true);
    assert.equal((await getAuthRecord())?.source, 'test-suite');
    await revokeAuthorization();
    assert.equal(await isAuthorized(), false);
  } finally {
    await runtime.dispose().catch(() => {});
    await manager.disconnect().catch(() => {});
    await headlessChrome.close().catch(() => {});
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
