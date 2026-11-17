---
name: cua-repl
description: >-
  Use this skill whenever interacting with Chrome web pages via the agy-chrome-use
  MCP server (cua_exec, cua_authorize, cua_status, cua_reset). Activate when the
  user provides a URL or asks to open, read, click, type, scroll, or inspect a
  web page without specifying another browser plugin.
---

# AGY Chrome Use (`cua_exec` REPL)

`agy-chrome-use` provides a stateful JavaScript REPL connected to Google Chrome.
It **prioritizes attaching to an already-open Chrome window** (via CDP on
`127.0.0.1:9222` or Chrome's remote debugging channel) and falls back to a
visible persistent Chrome profile when remote debugging is unavailable.

## 1. First-Use Authorization Flow

The first time `cua_exec` is called on a machine, it returns
`AUTHORIZATION_REQUIRED`:

1. Prompt the user directly in the session (preferring `ask_question` when available) explaining what `agy-chrome-use` will do (attach to open Chrome or open a managed Chrome window, and perform clicks, typing, and scrolling).
2. Once the user confirms, call `cua_authorize` with `{"confirm": true}` and immediately continue the task.
3. Authorization is persisted on disk; future turns and sessions will not prompt
   again.

## 2. MCP Tools

- `cua_exec`: Execute multi-step `async` JavaScript with `cua.*` and persistent `state`.
  - `code` *(string, required)*: Async function body (e.g. `await cua.goto("https://example.com");`).
  - `includeSnapshot` *(boolean, default `true`)*: Appends pruned interactive semantic tree.
  - `includeScreenshot` *(boolean, default `false`)*: Appends a compressed JPEG viewport screenshot.
  - `timeoutMs` *(number, default `30000`, max `120000`)*
- `cua_status`: Inspect authorization state, Chrome connection mode (`attached-cdp` vs `managed-profile`), and open tabs.
- `cua_reset`: Reset `scope: "repl" | "page" | "control" | "browser"` (`"control"` releases CDP banner / hides HUD without closing a managed Chrome window).
- `cua_authorize`: Persist one-time authorization (`{"confirm": true}`).

## 3. `cua.*` REPL SDK

Inside `cua_exec`, `cua`, `state` (persists across calls), `console`, and
`sleep(ms)` are available (`fs`, `process`, and `child_process` are blocked):

### Navigation & Tabs
- `await cua.goto(url, { reload?: false, currentTab?: false })` — Searches open tabs in the attached/current Chrome window for `url` first and switches to it if found; otherwise opens a new tab in the same window (or reuses an active blank tab) and navigates. Set `currentTab: true` to force navigating the active tab in place.
- `await cua.back()` / `await cua.forward()` / `await cua.reload()`
- `await cua.tabs()` — List open tabs (`index`, `title`, `url`, `active`).
- `await cua.newTab(url?)` / `await cua.switchTab(indexOrText)` / `await cua.closeTab(index?)`
- `await cua.attach(cdpUrl?)` — Explicitly attach to a running Chrome CDP endpoint (`"chrome"` or loopback/configured CDP URL).

### Perception
- `await cua.snapshot({ viewportOnly?: true, maxNodes?: 150, includeText?: false })` — Returns pruned interactive tree with `[e1]` refs and `(x, y)` center coordinates. Password fields are always masked as `***`.
- `await cua.screenshot({ fullPage?: false, format?: "jpeg" | "png" })` — Captures and attaches a screenshot.
- `await cua.text()` — Returns cleaned visible page text (up to 8,000 chars).
- `await cua.url()` / `await cua.title()`

### Human-Like Actions (with live visual HUD)
- `await cua.click(target, { button?: "left" | "right" | "middle", clickCount?: 1 })` — `target` can be a ref (`"e12"` or `{ ref: "e12" }`), visible text/label (`"Sign in"`), CSS selector (`"css=..."` or `{ selector: "css" }`), or `{ x, y }`. Scrolls into view, checks occlusion (including Shadow DOM), moves virtual cursor, clicks via real mouse events, and waits for DOM settle.
- `await cua.clickAt(x, y)` / `await cua.dblclick(target)` / `await cua.hover(target)`
- `await cua.type(target, text, { clear?: true, delayMs?: 18, submit?: false, instant?: false })`
- `await cua.press(key)` — e.g. `"Enter"`, `"Escape"`, `"Tab"`, `"Control+l"`.
- `await cua.scroll("down" | "up" | "left" | "right" | { dx, dy }, amount?)`
- `await cua.drag(fromTarget, toTarget)`
- `await cua.select(target, value)` — Selects matching `<option>` on native `<select>` elements or opens custom dropdowns and selects/types matching options.

### Synchronization
- `await cua.waitText(text, timeoutMs?)`
- `await cua.waitUrl(substring, timeoutMs?)`
- `await sleep(ms)`

## 4. Best Practices & Failure Recovery

1. **Batch actions per call**: Combine `goto` + `waitText` + `snapshot`, or `type` + `click` + `waitUrl` in one `cua_exec` script.
2. **Use `snapshot()` first, `screenshot` when visual context is needed**: Keep `includeScreenshot: false` for routine DOM flows; set `includeScreenshot: true` for layout checks, charts, canvas, or icon-only controls.
3. **Structured errors**:
   - `[ElementDetached]` / `[ElementNotFound]`: Re-run `await cua.snapshot()` to refresh refs, or switch to text/coordinate click.
   - `[Occluded]`: A modal/banner is blocking the element — dismiss it or scroll first.
4. **Human handoff & clean release**: Stop immediately, call `cua_reset` with `{"scope": "control"}` (which releases `attached-cdp` banner while keeping `managed-profile` windows open), and ask the user to take over in Chrome if a CAPTCHA, 2FA challenge, login password entry, or payment confirmation appears. Visual HUD overlays auto-hide after each `cua_exec`, and the plugin's `Stop` hook also automatically releases `attached-cdp` control when the turn ends.
