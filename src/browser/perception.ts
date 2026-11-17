import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { SCREENSHOT_DIR } from '../config.js';

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  box: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; width: number; height: number };
  nodes: SnapshotNode[];
  formatted: string;
  textExcerpt?: string;
}

export interface SnapshotOptions {
  viewportOnly?: boolean;
  maxNodes?: number;
  includeText?: boolean;
  maxTextChars?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: 'jpeg' | 'png';
  quality?: number;
}

export interface CapturedScreenshot {
  base64: string;
  mimeType: 'image/jpeg' | 'image/png';
  filePath: string;
}

let latestSnapshotId = 0;

export function getLatestSnapshotId(): number {
  return latestSnapshotId;
}

export function invalidateSnapshotRefs(): void {
  latestSnapshotId += 1;
}

export async function captureSnapshot(
  page: Page,
  opts?: SnapshotOptions,
): Promise<PageSnapshot> {
  const viewportOnly = opts?.viewportOnly ?? true;
  const maxNodes = opts?.maxNodes ?? 150;
  const includeText = opts?.includeText ?? false;
  const maxTextChars = opts?.maxTextChars ?? 2000;
  latestSnapshotId += 1;
  const snapshotId = latestSnapshotId;

  const raw = await page.evaluate(
    ({
      viewportOnly: vpOnly,
      maxNodes: limit,
      includeText: withText,
      maxTextChars: textCap,
      snapshotId: snapId,
    }) => {
      const HUD_ID = '__agy_chrome_use_hud__';
      const refs = new Map<string, Element>();
      (window as unknown as Record<string, unknown>).__agyCuaRefs = refs;
      (window as unknown as Record<string, unknown>).__agyCuaSnapshotId = snapId;

      const vpW = window.innerWidth;
      const vpH = window.innerHeight;

      const INTERACTIVE_TAGS = new Set([
        'A',
        'BUTTON',
        'INPUT',
        'TEXTAREA',
        'SELECT',
        'SUMMARY',
      ]);
      const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
      const INTERACTIVE_ROLES = new Set([
        'button',
        'link',
        'textbox',
        'searchbox',
        'combobox',
        'checkbox',
        'radio',
        'switch',
        'tab',
        'menuitem',
        'option',
        'slider',
        'spinbutton',
      ]);

      const isVisible = (el: Element): DOMRect | null => {
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity || '1') === 0
        ) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return null;
        if (vpOnly) {
          if (
            rect.bottom < 0 ||
            rect.top > vpH ||
            rect.right < 0 ||
            rect.left > vpW
          ) {
            return null;
          }
        }
        return rect;
      };

      const inferRole = (el: Element): string => {
        const explicit = el.getAttribute('role')?.trim().toLowerCase();
        if (explicit) return explicit;
        const tag = el.tagName;
        if (tag === 'A' && el.hasAttribute('href')) return 'link';
        if (tag === 'BUTTON') return 'button';
        if (tag === 'TEXTAREA') return 'textbox';
        if (tag === 'SELECT') return 'combobox';
        if (tag === 'SUMMARY') return 'button';
        if (HEADING_TAGS.has(tag)) return `heading(${tag.toLowerCase()})`;
        if (tag === 'INPUT') {
          const type = (el as HTMLInputElement).type?.toLowerCase() || 'text';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit' || type === 'button' || type === 'reset') {
            return 'button';
          }
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        return 'generic';
      };

      const isCandidate = (el: Element): boolean => {
        if (el.id === HUD_ID) return false;
        const tag = el.tagName;
        if (INTERACTIVE_TAGS.has(tag) || HEADING_TAGS.has(tag)) {
          if (tag === 'INPUT' && (el as HTMLInputElement).type === 'hidden') {
            return false;
          }
          return true;
        }
        const role = el.getAttribute('role')?.trim().toLowerCase();
        if (role && INTERACTIVE_ROLES.has(role)) return true;
        if (el.hasAttribute('onclick')) return true;
        if (el.getAttribute('contenteditable') === 'true') return true;
        const tabIdx = el.getAttribute('tabindex');
        if (tabIdx !== null && tabIdx.trim() !== '' && !Number.isNaN(Number(tabIdx)) && Number(tabIdx) >= 0) {
          return true;
        }
        const style = window.getComputedStyle(el);
        if (
          style.cursor === 'pointer' &&
          el.children.length <= 2 &&
          (el.textContent?.trim().length ?? 0) > 0 &&
          (el.textContent?.trim().length ?? 0) <= 80
        ) {
          return true;
        }
        return false;
      };

      const getAccessibleName = (el: Element): string => {
        const ariaLabel = el.getAttribute('aria-label')?.trim();
        if (ariaLabel) return ariaLabel;
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim())
            .filter(Boolean);
          if (parts.length) return parts.join(' ');
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.id) {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (label?.textContent?.trim()) return label.textContent.trim();
          }
          if (el.type === 'submit' || el.type === 'button') {
            return el.value?.trim() || el.placeholder?.trim() || '';
          }
          return el.placeholder?.trim() || el.name?.trim() || '';
        }
        const title = el.getAttribute('title')?.trim();
        const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || '';
        const clean = text.replace(/\s+/g, ' ').slice(0, 80);
        return clean || title || el.getAttribute('alt')?.trim() || '';
      };

      const nodes: SnapshotNode[] = [];
      let counter = 0;

      const walk = (root: ParentNode) => {
        const children = root.children;
        for (let i = 0; i < children.length; i++) {
          if (nodes.length >= limit) return;
          const el = children[i];
          if (el.id === HUD_ID) continue;

          if (isCandidate(el)) {
            const rect = isVisible(el);
            if (rect) {
              counter += 1;
              const ref = `e${counter}`;
              refs.set(ref, el);

              const role = inferRole(el);
              const name = getAccessibleName(el);
              const box = {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
              const center = {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };

              const node: SnapshotNode = {
                ref,
                role,
                name,
                tag: el.tagName.toLowerCase(),
                box,
                center,
              };

              if (el instanceof HTMLInputElement) {
                const inputType = el.type?.toLowerCase();
                if (inputType === 'password') {
                  node.value = el.value ? '***' : '';
                } else if (inputType === 'checkbox' || inputType === 'radio') {
                  node.checked = el.checked;
                } else if (el.value) {
                  node.value = el.value.slice(0, 80);
                }
                if (el.placeholder) node.placeholder = el.placeholder.slice(0, 60);
                if (el.disabled) node.disabled = true;
              } else if (el instanceof HTMLTextAreaElement) {
                if (el.value) node.value = el.value.slice(0, 80);
                if (el.placeholder) node.placeholder = el.placeholder.slice(0, 60);
                if (el.disabled) node.disabled = true;
              } else if (el instanceof HTMLSelectElement) {
                node.value = el.options[el.selectedIndex]?.text?.slice(0, 60) || el.value;
                if (el.disabled) node.disabled = true;
              } else if (el instanceof HTMLButtonElement && el.disabled) {
                node.disabled = true;
              } else if (el.getAttribute('aria-disabled') === 'true') {
                node.disabled = true;
              }

              if (el instanceof HTMLAnchorElement && el.href) {
                node.href = el.href.slice(0, 120);
              }

              nodes.push(node);
            }
          }

          if (el.shadowRoot) {
            walk(el.shadowRoot);
          }
          walk(el);
        }
      };

      if (document.body) {
        walk(document.body);
      }

      const textExcerpt = withText
        ? (document.body?.innerText || '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, textCap)
        : undefined;

      return {
        url: window.location.href,
        title: document.title,
        viewport: { width: vpW, height: vpH },
        scroll: {
          x: Math.round(window.scrollX),
          y: Math.round(window.scrollY),
          width: Math.round(document.documentElement.scrollWidth),
          height: Math.round(document.documentElement.scrollHeight),
        },
        nodes,
        textExcerpt,
      };
    },
    { viewportOnly, maxNodes, includeText, maxTextChars, snapshotId },
  );

  const lines: string[] = [
    `Page: ${raw.title || '(untitled)'} — ${raw.url}`,
    `Viewport: ${raw.viewport.width}x${raw.viewport.height} | Scroll: (${raw.scroll.x}, ${raw.scroll.y}) of ${raw.scroll.width}x${raw.scroll.height} | Elements: ${raw.nodes.length}`,
  ];

  for (const n of raw.nodes) {
    const parts: string[] = [`[${n.ref}]`, n.role];
    if (n.name) parts.push(`"${n.name}"`);
    if (n.value !== undefined) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.checked !== undefined) parts.push(`checked=${n.checked}`);
    if (n.disabled) parts.push('disabled');
    parts.push(`@(${n.center.x},${n.center.y} ${n.box.width}x${n.box.height})`);
    lines.push(parts.join(' '));
  }

  if (raw.textExcerpt) {
    lines.push('--- Text Excerpt ---');
    lines.push(raw.textExcerpt);
  }

  return {
    ...raw,
    formatted: lines.join('\n'),
  };
}

let shotSeq = 0;

function extractShotTimestamp(name: string): number {
  const match = /^shot-(\d+)/.exec(name);
  return match ? Number(match[1]) : 0;
}

async function pruneOldScreenshots(maxKeep = 20): Promise<void> {
  try {
    const entries = await fs.readdir(SCREENSHOT_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && /\.(jpe?g|png)$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const ta = extractShotTimestamp(a);
        const tb = extractShotTimestamp(b);
        return ta !== tb ? ta - tb : a.localeCompare(b);
      });
    if (files.length <= maxKeep) return;
    const toDelete = files.slice(0, files.length - maxKeep);
    await Promise.all(
      toDelete.map((name) =>
        fs.unlink(path.join(SCREENSHOT_DIR, name)).catch(() => {}),
      ),
    );
  } catch {
    // Ignore cleanup errors.
  }
}

export async function captureScreenshot(
  page: Page,
  opts?: ScreenshotOptions,
): Promise<CapturedScreenshot> {
  const format = opts?.format ?? 'jpeg';
  const quality = format === 'jpeg' ? (opts?.quality ?? 72) : undefined;

  const buffer = await page.screenshot({
    type: format,
    quality,
    fullPage: Boolean(opts?.fullPage),
  });

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const ext = format === 'png' ? 'png' : 'jpg';
  shotSeq = (shotSeq + 1) % 10000;
  const seq = String(shotSeq).padStart(4, '0');
  const fileName = `shot-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  await fs.writeFile(filePath, buffer);
  void pruneOldScreenshots(20);

  return {
    base64: buffer.toString('base64'),
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    filePath,
  };
}
