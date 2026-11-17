import { Worker } from 'node:worker_threads';
import { CuaError, formatError } from '../errors.js';
import { isBlockedNetworkError, validateNavigationUrl } from '../security/auth.js';
import { humanClick, humanDrag, humanHover, humanScroll, humanSelect, humanType, } from '../browser/actions.js';
import { hudShowStatus } from '../browser/hud.js';
import { captureScreenshot, captureSnapshot, invalidateSnapshotRefs, } from '../browser/perception.js';
import { autoSettle } from '../browser/settle.js';
const MAX_LOG_ENTRIES = 500;
const POST_TIMEOUT_SNAPSHOT_CAP_MS = 2000;
const POST_EXEC_HUD_HIDE_CAP_MS = 2000;
async function withSoftTimeout(promise, ms, fallback) {
    let timer;
    try {
        return await Promise.race([
            promise.catch(() => fallback),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export class ReplRuntime {
    manager;
    worker = null;
    execQueue = Promise.resolve();
    nextExecId = 1;
    lastCommittedStateJson;
    activeExec = null;
    constructor(manager) {
        this.manager = manager;
    }
    pushLog(logs, state, level, line) {
        if (logs.length >= MAX_LOG_ENTRIES) {
            if (!state.logsTruncated) {
                state.logsTruncated = true;
                logs.push(`[warn] Console log output truncated at ${MAX_LOG_ENTRIES} entries.`);
            }
            return;
        }
        logs.push(level === 'log' ? line : `[${level}] ${line}`);
    }
    ensureWorker() {
        if (this.worker)
            return this.worker;
        const workerUrl = new URL('./repl-worker.js', import.meta.url);
        const worker = new Worker(workerUrl);
        worker.on('message', (msg) => {
            if (msg.type === 'reset-ack')
                return;
            const current = this.activeExec;
            if (!current || current.worker !== worker || msg.execId !== current.execId) {
                return;
            }
            if (msg.type === 'log') {
                this.pushLog(current.logs, current, msg.level, msg.line);
                return;
            }
            if (msg.type === 'rpc') {
                void this.handleRpc(worker, current, msg.callId, msg.method, msg.argsJson);
                return;
            }
            if (msg.type === 'exec-result') {
                if (msg.stateJson !== undefined) {
                    this.lastCommittedStateJson = msg.stateJson;
                }
                let value = undefined;
                if (msg.hasValue && msg.valueJson !== undefined) {
                    try {
                        value = JSON.parse(msg.valueJson);
                    }
                    catch {
                        value = msg.valueJson;
                    }
                }
                this.activeExec = null;
                current.resolve({
                    ok: msg.ok,
                    value,
                    error: msg.error,
                });
            }
        });
        worker.on('error', (err) => {
            if (this.worker === worker) {
                this.worker = null;
            }
            const current = this.activeExec;
            if (current && current.worker === worker) {
                this.activeExec = null;
                current.resolve({
                    ok: false,
                    error: formatError(err),
                });
            }
        });
        worker.on('exit', (code) => {
            if (this.worker === worker) {
                this.worker = null;
            }
            const current = this.activeExec;
            if (current && current.worker === worker) {
                this.activeExec = null;
                current.resolve({
                    ok: false,
                    error: `REPL worker exited unexpectedly with code ${code}`,
                });
            }
        });
        worker.unref();
        this.worker = worker;
        return worker;
    }
    async handleRpc(worker, current, callId, method, argsJson) {
        try {
            const fn = current.sdk[method];
            if (!fn) {
                throw new CuaError('InvalidArgument', `Unknown cua method: ${method}`);
            }
            const args = JSON.parse(argsJson);
            const result = await fn(...args);
            if (this.activeExec !== current || this.worker !== worker)
                return;
            const resultJson = result === undefined ? '' : JSON.stringify(result);
            worker.postMessage({
                type: 'rpc-result',
                callId,
                ok: true,
                resultJson,
            });
        }
        catch (err) {
            if (this.activeExec !== current || this.worker !== worker)
                return;
            if (err instanceof CuaError) {
                worker.postMessage({
                    type: 'rpc-result',
                    callId,
                    ok: false,
                    errorCode: err.code,
                    errorMessage: err.message.replace(/^\[[^\]]+\]\s*/, ''),
                    errorDetailsJson: err.details ? JSON.stringify(err.details) : undefined,
                });
            }
            else {
                worker.postMessage({
                    type: 'rpc-result',
                    callId,
                    ok: false,
                    errorCode: 'Error',
                    errorMessage: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    terminateWorkerSync() {
        const w = this.worker;
        this.worker = null;
        if (w) {
            void w.terminate().catch(() => { });
        }
    }
    async dispose() {
        const w = this.worker;
        this.worker = null;
        this.activeExec = null;
        if (w) {
            await w.terminate().catch(() => { });
        }
    }
    resetRepl() {
        this.lastCommittedStateJson = undefined;
        this.activeExec = null;
        invalidateSnapshotRefs();
        this.terminateWorkerSync();
    }
    buildSdk(trace, screenshots, deadlineMs) {
        const remainingMs = () => deadlineMs - Date.now();
        const runStep = async (action, detail, fn) => {
            if (remainingMs() <= 0) {
                throw new CuaError('Timeout', `REPL execution deadline exceeded before ${action}`);
            }
            const start = Date.now();
            try {
                return await fn();
            }
            finally {
                trace.push({
                    action,
                    detail,
                    durationMs: Date.now() - start,
                });
            }
        };
        const opTimeout = (capMs) => Math.max(500, Math.min(capMs, remainingMs()));
        const throwNavError = async (page, actionMsg, err) => {
            const blocked = this.manager.consumeBlockedNavigation(page);
            if (blocked || isBlockedNetworkError(err)) {
                await page.goto('about:blank').catch(() => { });
                throw new CuaError('SafetyBlocked', blocked || `Blocked redirect or unsafe navigation during ${actionMsg}`);
            }
            throw new CuaError('NavigationFailed', `${actionMsg}: ${err instanceof Error ? err.message : String(err)}`);
        };
        return {
            attach: (cdpUrl) => {
                const endpoint = typeof cdpUrl === 'string' ? cdpUrl : undefined;
                return runStep('attach', endpoint || 'auto', async () => {
                    const page = await this.manager.attachCdp(endpoint);
                    return { url: page.url(), title: await page.title().catch(() => '') };
                });
            },
            goto: (url, rawOpts) => {
                const urlStr = String(url ?? '');
                const opts = rawOpts && typeof rawOpts === 'object'
                    ? rawOpts
                    : undefined;
                return runStep('goto', urlStr, async () => {
                    const safeUrl = validateNavigationUrl(urlStr);
                    const { page, action } = await this.manager.openOrSwitchUrl(safeUrl, {
                        currentTab: opts?.currentTab,
                    });
                    if (action === 'switched') {
                        await hudShowStatus(page, `Switched to existing tab: ${safeUrl}`);
                        if (opts?.reload) {
                            try {
                                await page.reload({
                                    waitUntil: opts?.waitUntil ?? 'domcontentloaded',
                                    timeout: opTimeout(25000),
                                });
                            }
                            catch (err) {
                                await throwNavError(page, `Failed to reload ${safeUrl}`, err);
                            }
                        }
                        await this.manager.assertSafePage(page);
                        await autoSettle(page);
                        return {
                            url: page.url(),
                            title: await page.title().catch(() => ''),
                            tabAction: action,
                        };
                    }
                    await hudShowStatus(page, `Navigating to ${safeUrl}`);
                    try {
                        await page.goto(safeUrl, {
                            waitUntil: opts?.waitUntil ?? 'domcontentloaded',
                            timeout: opTimeout(25000),
                        });
                    }
                    catch (err) {
                        await throwNavError(page, `Failed to navigate to ${safeUrl}`, err);
                    }
                    await this.manager.assertSafePage(page);
                    await autoSettle(page);
                    return {
                        url: page.url(),
                        title: await page.title().catch(() => ''),
                        tabAction: action,
                    };
                });
            },
            back: () => runStep('back', undefined, async () => {
                const page = await this.manager.ensurePage();
                let res = null;
                try {
                    res = await page.goBack({
                        waitUntil: 'domcontentloaded',
                        timeout: opTimeout(15000),
                    });
                }
                catch (err) {
                    await throwNavError(page, 'Failed to navigate back', err);
                }
                await this.manager.assertSafePage(page);
                await autoSettle(page);
                return {
                    navigated: res !== null,
                    url: page.url(),
                    title: await page.title().catch(() => ''),
                };
            }),
            forward: () => runStep('forward', undefined, async () => {
                const page = await this.manager.ensurePage();
                let res = null;
                try {
                    res = await page.goForward({
                        waitUntil: 'domcontentloaded',
                        timeout: opTimeout(15000),
                    });
                }
                catch (err) {
                    await throwNavError(page, 'Failed to navigate forward', err);
                }
                await this.manager.assertSafePage(page);
                await autoSettle(page);
                return {
                    navigated: res !== null,
                    url: page.url(),
                    title: await page.title().catch(() => ''),
                };
            }),
            reload: () => runStep('reload', undefined, async () => {
                const page = await this.manager.ensurePage();
                try {
                    await page.reload({
                        waitUntil: 'domcontentloaded',
                        timeout: opTimeout(20000),
                    });
                }
                catch (err) {
                    await throwNavError(page, 'Failed to reload page', err);
                }
                await this.manager.assertSafePage(page);
                await autoSettle(page);
                return { url: page.url(), title: await page.title().catch(() => '') };
            }),
            snapshot: (rawOpts) => {
                const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : undefined;
                return runStep('snapshot', undefined, async () => {
                    const page = await this.manager.ensurePage();
                    return captureSnapshot(page, opts);
                });
            },
            screenshot: (rawOpts) => {
                const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : undefined;
                return runStep('screenshot', undefined, async () => {
                    const page = await this.manager.ensurePage();
                    const shot = await captureScreenshot(page, opts);
                    screenshots.push(shot);
                    return {
                        filePath: shot.filePath,
                        mimeType: shot.mimeType,
                    };
                });
            },
            click: (target, rawOpts) => {
                const opts = rawOpts && typeof rawOpts === 'object'
                    ? rawOpts
                    : undefined;
                return runStep('click', JSON.stringify(target), async () => {
                    const page = await this.manager.ensurePage();
                    const pt = await humanClick(page, target, opts);
                    await this.manager.assertSafePage(this.manager.getActivePage() ?? page);
                    return pt;
                });
            },
            clickAt: (x, y) => runStep('clickAt', `(${String(x)}, ${String(y)})`, async () => {
                const page = await this.manager.ensurePage();
                const pt = await humanClick(page, { x: Number(x), y: Number(y) });
                await this.manager.assertSafePage(this.manager.getActivePage() ?? page);
                return pt;
            }),
            dblclick: (target) => runStep('dblclick', JSON.stringify(target), async () => {
                const page = await this.manager.ensurePage();
                const pt = await humanClick(page, target, { clickCount: 2 });
                await this.manager.assertSafePage(this.manager.getActivePage() ?? page);
                return pt;
            }),
            hover: (target) => runStep('hover', JSON.stringify(target), async () => {
                const page = await this.manager.ensurePage();
                return humanHover(page, target);
            }),
            type: (target, text, rawOpts) => {
                const opts = rawOpts && typeof rawOpts === 'object'
                    ? rawOpts
                    : undefined;
                return runStep('type', JSON.stringify(target), async () => {
                    const page = await this.manager.ensurePage();
                    const pt = await humanType(page, target, String(text ?? ''), opts);
                    await this.manager.assertSafePage(this.manager.getActivePage() ?? page);
                    return pt;
                });
            },
            press: (key) => {
                const keyStr = String(key ?? '');
                return runStep('press', keyStr, async () => {
                    const page = await this.manager.ensurePage();
                    await hudShowStatus(page, `Key ${keyStr}`);
                    await page.keyboard.press(keyStr);
                    await autoSettle(page, { quietMs: 120, maxWaitMs: 800 });
                    await this.manager.assertSafePage(this.manager.getActivePage() ?? page);
                });
            },
            scroll: (directionOrDelta, amount) => runStep('scroll', JSON.stringify(directionOrDelta), async () => {
                const page = await this.manager.ensurePage();
                const amt = typeof amount === 'number' ? amount : undefined;
                return humanScroll(page, directionOrDelta, amt);
            }),
            drag: (from, to) => runStep('drag', `${JSON.stringify(from)} -> ${JSON.stringify(to)}`, async () => {
                const page = await this.manager.ensurePage();
                return humanDrag(page, from, to);
            }),
            select: (target, value) => runStep('select', `${JSON.stringify(target)} = ${String(value ?? '')}`, async () => {
                const page = await this.manager.ensurePage();
                const pt = await humanSelect(page, target, String(value ?? ''));
                await this.manager.assertSafePage(this.manager.getActivePage() ?? page);
                return pt;
            }),
            waitText: (text, timeoutMs) => {
                const textStr = String(text ?? '');
                const t = typeof timeoutMs === 'number' ? timeoutMs : 10000;
                return runStep('waitText', textStr, async () => {
                    const page = await this.manager.ensurePage();
                    await page
                        .getByText(textStr, { exact: false })
                        .first()
                        .waitFor({ state: 'visible', timeout: opTimeout(t) });
                    return true;
                });
            },
            waitUrl: (pattern, timeoutMs) => {
                const patternStr = String(pattern ?? '');
                const t = typeof timeoutMs === 'number' ? timeoutMs : 10000;
                return runStep('waitUrl', patternStr, async () => {
                    const page = await this.manager.ensurePage();
                    await page.waitForURL((u) => u.toString().includes(patternStr), {
                        timeout: opTimeout(t),
                    });
                    return page.url();
                });
            },
            tabs: () => runStep('tabs', undefined, () => this.manager.listTabs()),
            newTab: (url) => {
                const urlStr = typeof url === 'string' ? url : undefined;
                return runStep('newTab', urlStr, async () => {
                    const page = await this.manager.newTab(urlStr, opTimeout(25000));
                    return { url: page.url(), title: await page.title().catch(() => '') };
                });
            },
            switchTab: (matcher) => runStep('switchTab', String(matcher), async () => {
                const m = typeof matcher === 'number' ? matcher : String(matcher ?? '');
                const page = await this.manager.switchTab(m);
                return { url: page.url(), title: await page.title().catch(() => '') };
            }),
            closeTab: (index) => {
                const idx = typeof index === 'number' ? index : undefined;
                return runStep('closeTab', idx === undefined ? 'active' : String(idx), () => this.manager.closeTab(idx));
            },
            text: () => runStep('text', undefined, async () => {
                const page = await this.manager.ensurePage();
                return page.evaluate(() => (document.body?.innerText || '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim()
                    .slice(0, 8000));
            }),
            url: () => runStep('url', undefined, async () => {
                const page = await this.manager.ensurePage();
                return page.url();
            }),
            title: () => runStep('title', undefined, async () => {
                const page = await this.manager.ensurePage();
                return page.title();
            }),
        };
    }
    execute(code, opts) {
        const run = this.execQueue.then(() => this.executeSerialized(code, opts));
        this.execQueue = run.catch(() => { });
        return run;
    }
    async executeSerialized(code, opts) {
        const timeoutMs = Math.max(1000, Math.min(opts?.timeoutMs ?? 30000, 120000));
        const deadlineMs = Date.now() + timeoutMs;
        const logs = [];
        const trace = [];
        const screenshots = [];
        const hadWorker = this.worker !== null;
        const worker = this.ensureWorker();
        worker.ref();
        const execId = this.nextExecId++;
        const sdk = this.buildSdk(trace, screenshots, deadlineMs);
        let timeoutHandle;
        try {
            const workerPromise = new Promise((resolve) => {
                this.activeExec = {
                    execId,
                    worker,
                    logs,
                    logsTruncated: false,
                    sdk,
                    resolve,
                };
                worker.postMessage({
                    type: 'exec',
                    execId,
                    code,
                    timeoutMs,
                    initialStateJson: !hadWorker ? this.lastCommittedStateJson : undefined,
                });
            });
            const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new CuaError('Timeout', `REPL execution timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            });
            const execOutcome = await Promise.race([workerPromise, timeoutPromise]);
            for (const dlg of this.manager.drainDialogEvents()) {
                this.pushLog(logs, this.activeExec ?? { logsTruncated: logs.length >= MAX_LOG_ENTRIES }, 'warn', dlg);
            }
            if (!execOutcome.ok) {
                let snapshot;
                if (opts?.includeSnapshot !== false) {
                    const page = this.manager.getActivePage();
                    if (page && !page.isClosed()) {
                        snapshot = await withSoftTimeout(captureSnapshot(page), POST_TIMEOUT_SNAPSHOT_CAP_MS, undefined);
                    }
                }
                return {
                    ok: false,
                    error: execOutcome.error || 'REPL execution failed',
                    logs,
                    trace,
                    snapshot,
                    screenshots,
                };
            }
            let snapshot;
            if (opts?.includeSnapshot !== false) {
                const page = await this.manager.ensurePage().catch(() => null);
                if (page && !page.isClosed()) {
                    snapshot = await withSoftTimeout(captureSnapshot(page), 5000, undefined);
                }
            }
            if (opts?.includeScreenshot && screenshots.length === 0) {
                const page = await this.manager.ensurePage().catch(() => null);
                if (page && !page.isClosed()) {
                    const shot = await captureScreenshot(page).catch(() => null);
                    if (shot)
                        screenshots.push(shot);
                }
            }
            return {
                ok: true,
                value: execOutcome.value,
                logs,
                trace,
                snapshot,
                screenshots,
            };
        }
        catch (err) {
            if (err instanceof CuaError && err.code === 'Timeout') {
                this.activeExec = null;
                this.terminateWorkerSync();
            }
            for (const dlg of this.manager.drainDialogEvents()) {
                this.pushLog(logs, { logsTruncated: logs.length >= MAX_LOG_ENTRIES }, 'warn', dlg);
            }
            let snapshot;
            if (opts?.includeSnapshot !== false) {
                const page = this.manager.getActivePage();
                if (page && !page.isClosed()) {
                    snapshot = await withSoftTimeout(captureSnapshot(page), POST_TIMEOUT_SNAPSHOT_CAP_MS, undefined);
                }
            }
            return {
                ok: false,
                error: formatError(err),
                logs,
                trace,
                snapshot,
                screenshots,
            };
        }
        finally {
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            this.activeExec = null;
            this.worker?.unref();
            await withSoftTimeout(this.manager.hideAllHuds(), POST_EXEC_HUD_HIDE_CAP_MS, undefined);
        }
    }
}
//# sourceMappingURL=runtime.js.map