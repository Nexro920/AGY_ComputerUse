import { CuaError } from '../errors.js';
import { hudClickRipple, hudMoveCursor, hudShowStatus } from './hud.js';
import { getLatestSnapshotId } from './perception.js';
import { autoSettle } from './settle.js';
const REF_PATTERN = /^e\d+$/;
function describeTarget(target) {
    if (typeof target === 'string')
        return target;
    if ('x' in target)
        return `(${target.x}, ${target.y})`;
    if ('ref' in target)
        return target.ref;
    return target.selector;
}
async function resolveElementRefOrText(page, query) {
    const expectedSnapshotId = getLatestSnapshotId();
    const res = await page.evaluate(({ ref, selector, text, expectedSnapshotId: expectedSnapId }) => {
        const HUD_ID = '__agy_chrome_use_hud__';
        const deepElementFromPoint = (x, y) => {
            let el = document.elementFromPoint(x, y);
            let depth = 0;
            while (el && el.shadowRoot && depth < 16) {
                const inner = el.shadowRoot.elementFromPoint(x, y);
                if (!inner || inner === el)
                    break;
                el = inner;
                depth += 1;
            }
            return el;
        };
        const isShadowOrDomContains = (ancestor, node) => {
            if (ancestor === node || ancestor.contains(node))
                return true;
            let cur = node;
            let hops = 0;
            while (cur && hops < 32) {
                if (cur === ancestor)
                    return true;
                const root = cur.getRootNode?.();
                if (root instanceof ShadowRoot) {
                    if (root.host === ancestor || ancestor.contains(root.host)) {
                        return true;
                    }
                    cur = root.host;
                }
                else {
                    break;
                }
                hops += 1;
            }
            return false;
        };
        const isSameControlOverlay = (targetEl, topEl) => {
            if (!topEl)
                return false;
            if (topEl.id === HUD_ID)
                return true;
            if (isShadowOrDomContains(targetEl, topEl) || isShadowOrDomContains(topEl, targetEl)) {
                return true;
            }
            const sharedWrapper = targetEl.closest('.el-select, .el-select__wrapper, .el-input__wrapper, .el-date-editor, label');
            return Boolean(sharedWrapper && isShadowOrDomContains(sharedWrapper, topEl));
        };
        const describeBlocker = (topEl) => {
            if (!topEl)
                return 'viewport-outside';
            return (topEl.tagName.toLowerCase() +
                (topEl.id ? `#${topEl.id}` : '') +
                (typeof topEl.className === 'string' && topEl.className
                    ? `.${topEl.className.trim().split(/\s+/).slice(0, 2).join('.')}`
                    : ''));
        };
        const findUnobstructedPoint = (targetEl) => {
            const r = targetEl.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const visLeft = Math.max(0, r.left);
            const visTop = Math.max(0, r.top);
            const visRight = Math.min(vw, r.right);
            const visBottom = Math.min(vh, r.bottom);
            const visW = visRight - visLeft;
            const visH = visBottom - visTop;
            const fallbackX = Math.round(r.left + r.width / 2);
            const fallbackY = Math.round(r.top + r.height / 2);
            if (visW < 1 || visH < 1) {
                return {
                    inViewport: false,
                    occluded: false,
                    blocker: 'viewport-outside',
                    x: fallbackX,
                    y: fallbackY,
                };
            }
            const clampPoint = (px, py) => [
                Math.max(0, Math.min(vw - 1, Math.round(px))),
                Math.max(0, Math.min(vh - 1, Math.round(py))),
            ];
            const probes = [
                clampPoint(visLeft + visW / 2, visTop + visH / 2),
                clampPoint(visLeft + visW * 0.25, visTop + visH * 0.25),
                clampPoint(visLeft + visW * 0.75, visTop + visH * 0.25),
                clampPoint(visLeft + visW * 0.25, visTop + visH * 0.75),
                clampPoint(visLeft + visW * 0.75, visTop + visH * 0.75),
            ];
            let firstBlocker = '';
            for (const [px, py] of probes) {
                const topEl = deepElementFromPoint(px, py);
                if (isSameControlOverlay(targetEl, topEl)) {
                    return { inViewport: true, occluded: false, blocker: '', x: px, y: py };
                }
                if (!firstBlocker) {
                    firstBlocker = describeBlocker(topEl);
                }
            }
            return {
                inViewport: true,
                occluded: true,
                blocker: firstBlocker || 'unknown-overlay',
                x: probes[0][0],
                y: probes[0][1],
            };
        };
        let el = null;
        if (ref) {
            const win = window;
            const snapId = win.__agyCuaSnapshotId;
            if (expectedSnapId > 0 && snapId !== expectedSnapId) {
                return {
                    ok: false,
                    code: 'ElementNotFound',
                    message: `Ref "${ref}" is from a stale snapshot, another tab, or reset session. Run cua.snapshot() on the active page first.`,
                };
            }
            const refs = win.__agyCuaRefs;
            const found = refs?.get(ref) ?? null;
            if (!found) {
                return {
                    ok: false,
                    code: 'ElementNotFound',
                    message: `Ref "${ref}" not found in latest snapshot. Run cua.snapshot() first.`,
                };
            }
            if (!found.isConnected) {
                return {
                    ok: false,
                    code: 'ElementDetached',
                    message: `Ref "${ref}" is detached from the DOM. Refresh snapshot and retry.`,
                };
            }
            el = found;
        }
        else if (selector) {
            try {
                el = document.querySelector(selector);
            }
            catch (err) {
                return {
                    ok: false,
                    code: 'InvalidArgument',
                    message: `Invalid CSS selector "${selector}": ${err instanceof Error ? err.message : String(err)}`,
                };
            }
            if (!el) {
                return {
                    ok: false,
                    code: 'ElementNotFound',
                    message: `No element matched selector "${selector}".`,
                };
            }
        }
        else if (text) {
            const needle = text.trim().toLowerCase();
            const CANDIDATE_SELECTOR = 'a, button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="slider"], [role="spinbutton"], summary, [tabindex], [onclick], [contenteditable="true"]';
            const collectCandidates = (root, out, depth = 0) => {
                if (depth > 8)
                    return;
                const matched = root.querySelectorAll(CANDIDATE_SELECTOR);
                for (let i = 0; i < matched.length; i++) {
                    const node = matched[i];
                    if (node.id !== HUD_ID)
                        out.push(node);
                }
                const all = root.querySelectorAll('*');
                for (let i = 0; i < all.length; i++) {
                    const node = all[i];
                    if (node.id !== HUD_ID && node.shadowRoot) {
                        collectCandidates(node.shadowRoot, out, depth + 1);
                    }
                }
            };
            const candidates = [];
            if (document.body) {
                collectCandidates(document.body, candidates);
            }
            else {
                collectCandidates(document, candidates);
            }
            let best = null;
            for (const node of candidates) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden')
                    continue;
                const rect = node.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2)
                    continue;
                const aria = node.getAttribute('aria-label')?.trim().toLowerCase() || '';
                const placeholder = node.placeholder?.trim().toLowerCase() || '';
                const title = node.getAttribute('title')?.trim().toLowerCase() || '';
                const txt = (node.innerText || node.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();
                let score = 0;
                if (aria === needle || txt === needle || placeholder === needle) {
                    score = 1000;
                }
                else if (aria.includes(needle) ||
                    txt.includes(needle) ||
                    placeholder.includes(needle) ||
                    title.includes(needle)) {
                    score = 100 - Math.min(40, Math.abs(txt.length - needle.length));
                }
                if (score > 0) {
                    const probe = findUnobstructedPoint(node);
                    if (probe.inViewport) {
                        score += 50;
                        if (!probe.occluded) {
                            score += 200;
                        }
                    }
                    if (!best || score > best.score) {
                        best = { node, score };
                    }
                }
            }
            if (!best) {
                return {
                    ok: false,
                    code: 'ElementNotFound',
                    message: `No visible interactive element matched text "${text}".`,
                };
            }
            el = best.node;
        }
        if (!el) {
            return {
                ok: false,
                code: 'ElementNotFound',
                message: 'Target element could not be resolved.',
            };
        }
        el.scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'instant',
        });
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) {
            return {
                ok: false,
                code: 'ElementNotFound',
                message: 'Target element has zero visible dimensions.',
            };
        }
        const probe = findUnobstructedPoint(el);
        if (!probe.inViewport) {
            return {
                ok: false,
                code: 'ElementNotFound',
                message: 'Target element is outside the visible viewport after scrolling.',
            };
        }
        if (probe.occluded) {
            return {
                ok: false,
                code: 'Occluded',
                message: `Target at (${probe.x}, ${probe.y}) is occluded by "${probe.blocker}".`,
            };
        }
        const label = el.getAttribute('aria-label')?.trim() ||
            el.innerText?.trim().slice(0, 32) ||
            el.placeholder?.trim() ||
            el.tagName.toLowerCase();
        return {
            ok: true,
            x: probe.x,
            y: probe.y,
            box: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            },
            label,
        };
    }, { ...query, expectedSnapshotId });
    if (!res.ok) {
        throw new CuaError(res.code, res.message);
    }
    return {
        x: res.x,
        y: res.y,
        box: res.box,
        label: res.label,
    };
}
export async function resolveTarget(page, target) {
    if (typeof target === 'object' && target !== null && 'x' in target && 'y' in target) {
        if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
            throw new CuaError('InvalidArgument', `Coordinates must be finite numbers, got (${String(target.x)}, ${String(target.y)}).`);
        }
        const rx = Math.round(target.x);
        const ry = Math.round(target.y);
        const vp = await page
            .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
            .catch(() => null);
        if (vp && (rx < 0 || ry < 0 || rx >= vp.w || ry >= vp.h)) {
            throw new CuaError('InvalidArgument', `Coordinates (${rx}, ${ry}) are outside viewport bounds (${vp.w}x${vp.h}).`);
        }
        return {
            x: rx,
            y: ry,
            label: `(${rx}, ${ry})`,
        };
    }
    if (typeof target === 'object' && target !== null && 'ref' in target) {
        return resolveElementRefOrText(page, { ref: target.ref });
    }
    if (typeof target === 'object' && target !== null && 'selector' in target) {
        return resolveElementRefOrText(page, { selector: target.selector });
    }
    if (typeof target === 'string') {
        const trimmed = target.trim();
        if (!trimmed) {
            throw new CuaError('InvalidArgument', 'Target string cannot be empty.');
        }
        if (REF_PATTERN.test(trimmed)) {
            return resolveElementRefOrText(page, { ref: trimmed });
        }
        if (trimmed.startsWith('css=')) {
            return resolveElementRefOrText(page, { selector: trimmed.slice(4) });
        }
        return resolveElementRefOrText(page, { text: trimmed });
    }
    throw new CuaError('InvalidArgument', `Unsupported target specification: ${describeTarget(target)}`);
}
export async function humanClick(page, target, opts) {
    const resolved = await resolveTarget(page, target);
    await hudShowStatus(page, `Clicking ${resolved.label}`);
    await hudMoveCursor(page, resolved.x, resolved.y, resolved.box);
    await page.mouse.move(resolved.x, resolved.y, { steps: 10 });
    await hudClickRipple(page, resolved.x, resolved.y);
    const button = opts?.button ?? 'left';
    const clickCount = opts?.clickCount ?? 1;
    await page.mouse.click(resolved.x, resolved.y, {
        button,
        clickCount,
        delay: 35,
    });
    await autoSettle(page);
    return resolved;
}
export async function humanHover(page, target) {
    const resolved = await resolveTarget(page, target);
    await hudShowStatus(page, `Hovering ${resolved.label}`);
    await hudMoveCursor(page, resolved.x, resolved.y, resolved.box);
    await page.mouse.move(resolved.x, resolved.y, { steps: 10 });
    await autoSettle(page, { quietMs: 100, maxWaitMs: 600 });
    return resolved;
}
export async function humanType(page, target, text, opts) {
    const resolved = await humanClick(page, target);
    await hudShowStatus(page, `Typing into ${resolved.label}`);
    if (opts?.clear !== false) {
        const selectAllKey = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
        await page.keyboard.press(selectAllKey);
        await page.keyboard.press('Backspace');
    }
    if (opts?.instant) {
        await page.keyboard.insertText(text);
    }
    else {
        await page.keyboard.type(text, { delay: opts?.delayMs ?? 18 });
    }
    if (opts?.submit) {
        await page.keyboard.press('Enter');
    }
    await autoSettle(page);
    return resolved;
}
export async function humanSelect(page, target, value) {
    const resolved = await resolveTarget(page, target);
    await hudShowStatus(page, `Selecting "${value}" on ${resolved.label}`);
    await hudMoveCursor(page, resolved.x, resolved.y, resolved.box);
    const nativeResult = await page.evaluate(({ x, y, val }) => {
        let el = document.elementFromPoint(x, y);
        while (el && el.shadowRoot) {
            const inner = el.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === el)
                break;
            el = inner;
        }
        const selectEl = el instanceof HTMLSelectElement ? el : el?.closest?.('select') ?? null;
        if (!selectEl)
            return { handled: false };
        const options = Array.from(selectEl.options);
        const needle = val.trim().toLowerCase();
        const match = options.find((o) => o.value === val || o.text.trim() === val) ??
            options.find((o) => o.value.toLowerCase() === needle ||
                o.text.trim().toLowerCase() === needle);
        if (!match) {
            return {
                handled: true,
                ok: false,
                message: `Option "${val}" not found in <select>.`,
            };
        }
        selectEl.value = match.value;
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return { handled: true, ok: true };
    }, { x: resolved.x, y: resolved.y, val: value });
    if (nativeResult.handled) {
        if (!nativeResult.ok) {
            throw new CuaError('ElementNotFound', nativeResult.message);
        }
        await autoSettle(page);
        return resolved;
    }
    await humanClick(page, target);
    const optionClicked = await page.evaluate((val) => {
        const needle = val.trim().toLowerCase();
        const candidates = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], .el-select-dropdown__item, .ant-select-item-option'));
        for (const node of candidates) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden')
                continue;
            const r = node.getBoundingClientRect();
            if (r.width < 2 || r.height < 2)
                continue;
            const txt = (node.innerText || node.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
            if (txt === val || txt.toLowerCase() === needle) {
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
        }
        return null;
    }, value);
    if (optionClicked) {
        await hudMoveCursor(page, optionClicked.x, optionClicked.y);
        await hudClickRipple(page, optionClicked.x, optionClicked.y);
        await page.mouse.click(optionClicked.x, optionClicked.y, { delay: 35 });
    }
    else {
        await page.keyboard.type(value, { delay: 20 });
        await page.keyboard.press('Enter');
    }
    await autoSettle(page);
    return resolved;
}
export async function humanScroll(page, directionOrDelta, amount = 520) {
    let dx = 0;
    let dy = 0;
    if (typeof directionOrDelta === 'string') {
        switch (directionOrDelta) {
            case 'down':
                dy = Math.abs(amount);
                break;
            case 'up':
                dy = -Math.abs(amount);
                break;
            case 'right':
                dx = Math.abs(amount);
                break;
            case 'left':
                dx = -Math.abs(amount);
                break;
        }
    }
    else {
        dx = directionOrDelta.dx ?? 0;
        dy = directionOrDelta.dy ?? 0;
    }
    await hudShowStatus(page, `Scrolling (${dx}, ${dy})`);
    const steps = 4;
    for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(dx / steps, dy / steps);
        await new Promise((r) => setTimeout(r, 35));
    }
    await autoSettle(page, { quietMs: 120, maxWaitMs: 800 });
    return { dx, dy };
}
export async function humanDrag(page, from, to) {
    const src = await resolveTarget(page, from);
    const dst = await resolveTarget(page, to);
    await hudShowStatus(page, `Dragging ${src.label} → ${dst.label}`);
    await hudMoveCursor(page, src.x, src.y, src.box);
    await page.mouse.move(src.x, src.y, { steps: 8 });
    await page.mouse.down();
    await hudMoveCursor(page, dst.x, dst.y, dst.box);
    await page.mouse.move(dst.x, dst.y, { steps: 14 });
    await page.mouse.up();
    await autoSettle(page);
    return { from: src, to: dst };
}
//# sourceMappingURL=actions.js.map