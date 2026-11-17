import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium, } from 'playwright';
import { CHROME_PROFILE_DIR, getCdpCandidates } from '../config.js';
import { CuaError } from '../errors.js';
import { checkBlockedNavigationReason, getBlockedRouteRegex, isBlockedNetworkError, validateCdpEndpoint, validateNavigationUrl, } from '../security/auth.js';
import { hudHideTransient, hudSetIdle } from './hud.js';
import { invalidateSnapshotRefs } from './perception.js';
const execFileAsync = promisify(execFile);
function isUsablePageUrl(url) {
    return (url.startsWith('http://') ||
        url.startsWith('https://') ||
        url === 'about:blank');
}
/** Return true when a tab URL represents an unused blank/new-tab page. */
export function isBlankTabUrl(url) {
    const normalized = url.trim().toLowerCase();
    return (normalized === '' ||
        normalized === 'about:blank' ||
        normalized === 'chrome://newtab' ||
        normalized === 'chrome://newtab/' ||
        normalized === 'edge://newtab' ||
        normalized === 'edge://newtab/');
}
/** Verify that a page's landed URL (after redirects or clicks) satisfies navigation safety rules. */
export async function assertSafeLandedPage(page) {
    const landed = page.url();
    if (!landed || isBlankTabUrl(landed))
        return;
    try {
        validateNavigationUrl(landed);
    }
    catch (err) {
        await page.goto('about:blank').catch(() => { });
        if (err instanceof CuaError && err.code === 'SafetyBlocked') {
            throw err;
        }
        throw new CuaError('SafetyBlocked', `Navigation landed on blocked URI "${landed}"`, { url: landed });
    }
}
/**
 * Compare an open tab URL against a target navigation URL.
 * Matches origin, normalized pathname (trailing slash ignored), search query,
 * and hash when the target URL specifies one.
 */
export function urlsMatchForTabLookup(tabUrl, targetUrl) {
    if (tabUrl === targetUrl)
        return true;
    try {
        const a = new URL(tabUrl);
        const b = new URL(targetUrl);
        if (a.origin !== b.origin)
            return false;
        const normPath = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
        if (normPath(a.pathname) !== normPath(b.pathname))
            return false;
        if (a.search !== b.search)
            return false;
        if (b.hash && a.hash !== b.hash)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
async function isChromeProcessRunning() {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { timeout: 1500 });
            return /chrome\.exe/i.test(stdout);
        }
        if (process.platform === 'darwin') {
            await execFileAsync('pgrep', ['-x', 'Google Chrome'], { timeout: 1500 });
            return true;
        }
        if (process.platform === 'linux') {
            try {
                await execFileAsync('pgrep', ['-x', 'chrome'], { timeout: 1500 });
                return true;
            }
            catch {
                await execFileAsync('pgrep', ['-x', 'chromium'], { timeout: 1500 });
                return true;
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
async function probeCdpHttp(cdpUrl) {
    try {
        const res = await fetch(`${cdpUrl}/json/version`, {
            signal: AbortSignal.timeout(800),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
export class BrowserManager {
    browser = null;
    context = null;
    activePage = null;
    mode = 'disconnected';
    cdpChannelKind = null;
    endpoint;
    diagnostic;
    contextClosed = false;
    lastCursorPos = null;
    hudActive = false;
    hudIdleTimer = null;
    hudIdleAutoHideMs = 15_000;
    trackedPages = new WeakSet();
    trackedContexts = new WeakSet();
    dialogEvents = [];
    routeCleanups = [];
    routeSetupPromises = [];
    blockedNavReason = new WeakMap();
    isConnected() {
        if (this.mode === 'attached-cdp') {
            return Boolean(this.browser?.isConnected() && this.context && !this.contextClosed);
        }
        if (this.mode === 'managed-profile') {
            if (!this.context || this.contextClosed)
                return false;
            if (this.browser && !this.browser.isConnected())
                return false;
            try {
                this.context.pages();
                return true;
            }
            catch {
                return false;
            }
        }
        return false;
    }
    pickBestPage(context) {
        const pages = context
            ? context.pages().filter((p) => !p.isClosed())
            : this.getOpenPages();
        if (pages.length === 0)
            return null;
        for (let i = pages.length - 1; i >= 0; i--) {
            if (isUsablePageUrl(pages[i].url())) {
                return pages[i];
            }
        }
        return pages[pages.length - 1];
    }
    attachPageListeners(page) {
        if (this.trackedPages.has(page))
            return;
        this.trackedPages.add(page);
        page.on('dialog', async (dialog) => {
            const entry = `[dialog:${dialog.type()}] ${dialog.message()} (auto-dismissed)`;
            if (this.dialogEvents.length < 50) {
                this.dialogEvents.push(entry);
            }
            await dialog.dismiss().catch(() => { });
        });
        page.on('popup', (popup) => {
            this.attachPageListeners(popup);
            this.activePage = popup;
            if (this.hudActive) {
                void hudSetIdle(popup, this.lastCursorPos, 'Active');
            }
        });
        page.on('domcontentloaded', () => {
            if (this.hudActive && !page.isClosed() && page === this.activePage) {
                void hudSetIdle(page, this.lastCursorPos, 'Active');
            }
        });
        page.on('request', (req) => {
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
                const reason = checkBlockedNavigationReason(req.url());
                if (reason) {
                    this.blockedNavReason.set(page, reason);
                }
            }
        });
        page.on('response', (res) => {
            if (res.status() >= 300 && res.status() < 400 && res.frame() === page.mainFrame()) {
                const loc = res.headers()['location'];
                if (loc) {
                    try {
                        const resolved = new URL(loc, res.url()).toString();
                        const reason = checkBlockedNavigationReason(resolved);
                        if (reason) {
                            this.blockedNavReason.set(page, reason);
                        }
                    }
                    catch {
                        // Ignore malformed location header.
                    }
                }
            }
        });
    }
    consumeBlockedNavigation(page) {
        const reason = this.blockedNavReason.get(page) ?? null;
        this.blockedNavReason.delete(page);
        return reason;
    }
    attachContextListeners(context) {
        if (this.trackedContexts.has(context))
            return;
        this.trackedContexts.add(context);
        const routeRegex = getBlockedRouteRegex();
        const routeHandler = (route) => route.abort('blockedbyclient').catch(() => { });
        const setup = context
            .route(routeRegex, routeHandler)
            .then(() => {
            this.routeCleanups.push(() => context.unroute(routeRegex, routeHandler).catch(() => { }));
        })
            .catch(() => { });
        this.routeSetupPromises.push(setup);
        context.on('close', () => {
            if (this.context === context) {
                this.contextClosed = true;
                this.resetState();
            }
        });
        context.on('page', (page) => {
            this.attachPageListeners(page);
        });
        for (const p of context.pages()) {
            this.attachPageListeners(p);
        }
    }
    async ensureRoutesReady() {
        if (this.routeSetupPromises.length === 0)
            return;
        const pending = this.routeSetupPromises.splice(0, this.routeSetupPromises.length);
        await Promise.allSettled(pending);
    }
    attachLifecycleListeners(context, browser) {
        this.contextClosed = false;
        this.attachContextListeners(context);
        for (const ctx of browser?.contexts() ?? []) {
            this.attachContextListeners(ctx);
        }
        browser?.on('disconnected', () => {
            if (this.browser === browser) {
                this.resetState();
            }
        });
    }
    resetState() {
        this.browser = null;
        this.context = null;
        this.activePage = null;
        this.mode = 'disconnected';
        this.cdpChannelKind = null;
        this.endpoint = undefined;
        this.diagnostic = undefined;
        this.contextClosed = false;
        this.lastCursorPos = null;
        this.hudActive = false;
        this.clearHudIdleTimer();
        this.trackedPages = new WeakSet();
        this.trackedContexts = new WeakSet();
        this.dialogEvents = [];
        this.routeCleanups = [];
        this.routeSetupPromises = [];
        this.blockedNavReason = new WeakMap();
    }
    getOpenPages() {
        const contexts = this.browser?.contexts() ?? (this.context ? [this.context] : []);
        const seen = new Set();
        const pages = [];
        for (const ctx of contexts) {
            this.attachContextListeners(ctx);
            for (const p of ctx.pages()) {
                if (!p.isClosed() && !seen.has(p)) {
                    this.attachPageListeners(p);
                    seen.add(p);
                    pages.push(p);
                }
            }
        }
        return pages;
    }
    drainDialogEvents() {
        if (this.dialogEvents.length === 0)
            return [];
        return this.dialogEvents.splice(0, this.dialogEvents.length);
    }
    async connectAndBindCdp(endpointOrChannel, timeoutMs, displayEndpoint) {
        const browser = await chromium.connectOverCDP(endpointOrChannel, {
            timeout: timeoutMs,
        });
        const context = browser.contexts()[0] ?? (await browser.newContext());
        this.browser = browser;
        this.context = context;
        this.mode = 'attached-cdp';
        this.cdpChannelKind = endpointOrChannel === 'chrome' ? 'channel' : 'explicit-url';
        this.endpoint = displayEndpoint;
        this.diagnostic = undefined;
        this.attachLifecycleListeners(context, browser);
        await this.ensureRoutesReady();
        this.activePage = this.pickBestPage() ?? (await context.newPage());
        this.attachPageListeners(this.activePage);
        await this.activePage.bringToFront().catch(() => { });
        return this.activePage;
    }
    async attachCdp(targetEndpoint) {
        const validatedTarget = targetEndpoint !== undefined ? validateCdpEndpoint(targetEndpoint) : undefined;
        if (validatedTarget) {
            await this.disconnect();
        }
        if (validatedTarget === 'chrome') {
            try {
                return await this.connectAndBindCdp('chrome', 10000, 'chrome (default remote debugging)');
            }
            catch (err) {
                throw new CuaError('BrowserUnavailable', `Could not attach to open Chrome via remote debugging channel: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const candidates = validatedTarget ? [validatedTarget] : getCdpCandidates();
        for (const url of candidates) {
            const reachable = url.startsWith('ws') ? true : await probeCdpHttp(url);
            if (!reachable)
                continue;
            return await this.connectAndBindCdp(url, 5000, url);
        }
        if (!validatedTarget) {
            try {
                // Chrome 136+ remote debugging (chrome://inspect/#remote-debugging) uses
                // DevToolsActivePort without /json/version and may need >2s for handshake/approval.
                return await this.connectAndBindCdp('chrome', 10000, 'chrome (default remote debugging)');
            }
            catch {
                // Channel remote debugging not enabled; fall through.
            }
        }
        throw new CuaError('BrowserUnavailable', `Could not attach to an open Chrome instance via CDP (${candidates.join(', ')}).`);
    }
    /** Ensure a Chrome context is connected (attached-cdp preferred, else managed-profile). */
    async ensureConnected() {
        if (this.isConnected() && this.context) {
            await this.ensureRoutesReady();
            return this.context;
        }
        try {
            await this.attachCdp();
            if (this.context)
                return this.context;
        }
        catch {
            // Fall back to a visible managed persistent Chrome window.
        }
        const runningNoCdp = await isChromeProcessRunning();
        await fs.mkdir(CHROME_PROFILE_DIR, { recursive: true });
        let context;
        try {
            context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
                channel: 'chrome',
                headless: false,
                viewport: null,
                ignoreDefaultArgs: ['--enable-automation'],
                args: ['--no-first-run', '--no-default-browser-check'],
            });
        }
        catch (err) {
            throw new CuaError('BrowserUnavailable', `Failed to launch managed Chrome window (verify Google Chrome is installed and no leftover Chrome process is locking ${CHROME_PROFILE_DIR}): ${err instanceof Error ? err.message : String(err)}`);
        }
        this.browser = context.browser();
        this.context = context;
        this.mode = 'managed-profile';
        this.endpoint = CHROME_PROFILE_DIR;
        this.diagnostic = runningNoCdp
            ? 'Open Chrome did not expose remote debugging (port 9222 or chrome://inspect/#remote-debugging); launched persistent managed Chrome window instead.'
            : 'No open Chrome detected; launched persistent managed Chrome window.';
        this.attachLifecycleListeners(context, this.browser ?? undefined);
        await this.ensureRoutesReady();
        this.activePage = this.pickBestPage(context) ?? (await context.newPage());
        this.attachPageListeners(this.activePage);
        await this.activePage.bringToFront().catch(() => { });
        return context;
    }
    async ensurePage() {
        const context = await this.ensureConnected();
        if (this.activePage && !this.activePage.isClosed()) {
            this.attachPageListeners(this.activePage);
            await this.ensureRoutesReady();
            return this.activePage;
        }
        this.activePage = this.pickBestPage() ?? (await context.newPage());
        this.attachPageListeners(this.activePage);
        await this.ensureRoutesReady();
        return this.activePage;
    }
    /** Find an existing open tab matching the given URL in the connected window. */
    async findTabByUrl(targetUrl) {
        for (const p of this.getOpenPages()) {
            if (urlsMatchForTabLookup(p.url(), targetUrl)) {
                return p;
            }
        }
        return null;
    }
    /**
     * Locate a tab already displaying targetUrl in the current Chrome window;
     * if not found, reuse an unused blank tab or open a new tab in the same window.
     */
    async openOrSwitchUrl(targetUrl, opts) {
        const context = await this.ensureConnected();
        await this.ensureRoutesReady();
        if (opts?.currentTab) {
            const page = await this.ensurePage();
            await page.bringToFront().catch(() => { });
            return { page, action: 'current-tab' };
        }
        const existing = await this.findTabByUrl(targetUrl);
        if (existing) {
            this.activePage = existing;
            this.attachPageListeners(existing);
            await existing.bringToFront().catch(() => { });
            return { page: existing, action: 'switched' };
        }
        if (this.activePage &&
            !this.activePage.isClosed() &&
            isBlankTabUrl(this.activePage.url())) {
            this.attachPageListeners(this.activePage);
            await this.activePage.bringToFront().catch(() => { });
            return { page: this.activePage, action: 'reused-blank' };
        }
        const page = await context.newPage();
        this.activePage = page;
        this.attachPageListeners(page);
        await page.bringToFront().catch(() => { });
        return { page, action: 'new-tab' };
    }
    async listTabs() {
        if (!this.isConnected()) {
            return [];
        }
        const pages = this.getOpenPages();
        const tabs = [];
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            let title = '';
            try {
                title = await p.title();
            }
            catch {
                title = '';
            }
            tabs.push({
                index: i,
                title,
                url: p.url(),
                active: p === this.activePage,
            });
        }
        return tabs;
    }
    async assertSafePage(page) {
        const blocked = this.consumeBlockedNavigation(page);
        if (blocked) {
            await page.goto('about:blank').catch(() => { });
            throw new CuaError('SafetyBlocked', blocked);
        }
        await assertSafeLandedPage(page);
    }
    async newTab(url, timeoutMs = 25000) {
        await this.ensurePage();
        if (!this.context) {
            throw new CuaError('BrowserUnavailable', 'Browser context unavailable.');
        }
        const page = await this.context.newPage();
        this.activePage = page;
        this.attachPageListeners(page);
        if (url) {
            const safe = validateNavigationUrl(url);
            try {
                await page.goto(safe, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            }
            catch (err) {
                const blocked = this.consumeBlockedNavigation(page);
                if (blocked || isBlockedNetworkError(err)) {
                    await page.goto('about:blank').catch(() => { });
                    throw new CuaError('SafetyBlocked', blocked || `Blocked redirect or unsafe navigation from ${safe}`, { url: safe });
                }
                throw new CuaError('NavigationFailed', `Failed to navigate new tab to ${safe}: ${err instanceof Error ? err.message : String(err)}`);
            }
            await this.assertSafePage(page);
        }
        await page.bringToFront().catch(() => { });
        return page;
    }
    async switchTab(matcher) {
        await this.ensurePage();
        const pages = this.getOpenPages();
        if (pages.length === 0) {
            throw new CuaError('BrowserUnavailable', 'No open browser tabs available.');
        }
        let target;
        if (typeof matcher === 'number') {
            target = pages[matcher];
        }
        else {
            const needle = matcher.toLowerCase();
            for (const p of pages) {
                const title = (await p.title().catch(() => '')).toLowerCase();
                if (p.url().toLowerCase().includes(needle) || title.includes(needle)) {
                    target = p;
                    break;
                }
            }
        }
        if (!target) {
            throw new CuaError('InvalidArgument', `Tab matching ${JSON.stringify(matcher)} was not found.`);
        }
        this.activePage = target;
        this.attachPageListeners(target);
        await target.bringToFront().catch(() => { });
        return target;
    }
    async closeTab(index) {
        if (!this.isConnected())
            return;
        const pages = this.getOpenPages();
        const target = typeof index === 'number' ? pages[index] : (this.activePage ?? pages[0]);
        if (!target)
            return;
        await target.close().catch(() => { });
        if (this.activePage === target) {
            this.activePage = this.pickBestPage();
        }
    }
    getActivePage() {
        return this.activePage && !this.activePage.isClosed() ? this.activePage : null;
    }
    getCursorPos() {
        return this.lastCursorPos;
    }
    setCursorPos(x, y) {
        if (Number.isFinite(x) && Number.isFinite(y)) {
            this.lastCursorPos = { x: Math.round(x), y: Math.round(y) };
        }
    }
    clearHudIdleTimer() {
        if (this.hudIdleTimer) {
            clearTimeout(this.hudIdleTimer);
            this.hudIdleTimer = null;
        }
    }
    /** Configure the HUD inactivity auto-hide timeout (primarily for tests). */
    setHudIdleAutoHideMs(ms) {
        this.hudIdleAutoHideMs = Math.max(0, ms);
    }
    setHudActive(active) {
        this.hudActive = active;
        if (active) {
            this.clearHudIdleTimer();
        }
    }
    /**
     * Keep the HUD cursor visible while an active browser task pauses between tool calls,
     * and auto-hide it if no new browser activity arrives within `hudIdleAutoHideMs`.
     */
    async setActiveHudIdle(text = 'Active') {
        if (!this.isConnected())
            return;
        this.hudActive = true;
        this.clearHudIdleTimer();
        const page = this.getActivePage();
        if (!page || page.isClosed())
            return;
        await hudSetIdle(page, this.lastCursorPos, text);
        if (this.hudIdleAutoHideMs > 0) {
            this.hudIdleTimer = setTimeout(() => {
                this.hudIdleTimer = null;
                this.hudActive = false;
                void this.hideAllHuds().catch(() => { });
            }, this.hudIdleAutoHideMs);
            this.hudIdleTimer.unref?.();
        }
    }
    /** Hide visual HUD overlays on all currently open pages. */
    async hideAllHuds() {
        const pages = this.getOpenPages();
        if (pages.length === 0)
            return;
        await Promise.allSettled(pages.map((p) => hudHideTransient(p)));
    }
    /** Clear cached element refs on all open pages and invalidate snapshot generation. */
    async clearRefs() {
        invalidateSnapshotRefs();
        const pages = this.getOpenPages();
        if (pages.length === 0)
            return;
        await Promise.allSettled(pages.map((p) => p
            .evaluate(() => {
            const win = window;
            delete win.__agyCuaRefs;
            delete win.__agyCuaSnapshotId;
        })
            .catch(() => { })));
    }
    /**
     * Release visual control indicators cleanly for human handoff or turn completion.
     * For explicit CDP URLs, disconnect the CDP client so automation state resets;
     * for Chrome's built-in remote-debugging channel, keep the authorized socket alive
     * across turns (while hiding HUDs) so Chrome does not re-prompt for permission.
     */
    async releaseControl() {
        const previousMode = this.mode;
        this.hudActive = false;
        this.clearHudIdleTimer();
        this.lastCursorPos = null;
        await this.hideAllHuds();
        if (this.mode === 'attached-cdp') {
            if (this.cdpChannelKind === 'explicit-url') {
                await this.disconnect({ preserveRefs: true });
            }
            return { released: true, mode: previousMode };
        }
        return { released: false, mode: previousMode };
    }
    async getStatus() {
        const tabs = await this.listTabs();
        return {
            mode: this.isConnected() ? this.mode : 'disconnected',
            endpoint: this.endpoint,
            diagnostic: this.diagnostic,
            tabs,
        };
    }
    async disconnect(opts) {
        const mode = this.mode;
        const browser = this.browser;
        const context = this.context;
        const routeCleanups = this.routeCleanups.splice(0, this.routeCleanups.length);
        try {
            if (this.isConnected()) {
                await Promise.allSettled(routeCleanups.map((fn) => fn()));
                await this.hideAllHuds();
                if (!opts?.preserveRefs) {
                    await this.clearRefs();
                }
            }
            else if (!opts?.preserveRefs) {
                invalidateSnapshotRefs();
            }
            if (mode === 'attached-cdp') {
                await browser?.close().catch(() => { });
            }
            else if (mode === 'managed-profile') {
                await context?.close().catch(() => { });
            }
        }
        finally {
            this.resetState();
        }
    }
}
//# sourceMappingURL=manager.js.map