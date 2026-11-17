import type { Page } from 'playwright';

export interface HudBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HUD_HOST_ID = '__agy_chrome_use_hud__';
const HUD_EVAL_TIMEOUT_MS = 1500;

type HudCommand =
  | { type: 'status'; text: string }
  | { type: 'move'; x: number; y: number; box: HudBox | null }
  | { type: 'ripple'; x: number; y: number }
  | { type: 'hide' };

async function runHudOp(page: Page, cmd: HudCommand): Promise<void> {
  if (page.isClosed()) return;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evalPromise = page.evaluate(
      ({ hostId, command }) => {
        const ensureHud = (): ShadowRoot | null => {
          let host = document.getElementById(hostId);
          if (!host) {
            const container = document.documentElement || document.body;
            if (!container) return null;
            host = document.createElement('div');
            host.id = hostId;
            host.style.cssText =
              'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
            container.appendChild(host);
          }

          let shadow = host.shadowRoot;
          if (!shadow) {
            shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .root {
          position: fixed; inset: 0; pointer-events: none;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .pill {
          position: fixed; top: 12px; right: 12px;
          max-width: 320px; padding: 6px 12px; border-radius: 999px;
          background: rgba(15, 23, 42, 0.88); color: #f8fafc;
          font-size: 12px; line-height: 1.4; font-weight: 500;
          box-shadow: 0 4px 14px rgba(0,0,0,0.28);
          border: 1px solid rgba(56, 189, 248, 0.45);
          backdrop-filter: blur(6px);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          opacity: 0; transition: opacity 160ms ease;
        }
        .pill.visible { opacity: 1; }
        .highlight {
          position: fixed; border-radius: 6px;
          border: 2px solid #38bdf8;
          background: rgba(56, 189, 248, 0.12);
          box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
          transition: all 140ms cubic-bezier(0.22, 1, 0.36, 1);
          opacity: 0;
        }
        .highlight.visible { opacity: 1; }
        .cursor {
          position: fixed; width: 22px; height: 22px;
          transform: translate(-2px, -2px);
          transition: left 180ms cubic-bezier(0.22, 1, 0.36, 1), top 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease;
          opacity: 0; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.45));
        }
        .cursor.visible { opacity: 1; }
        .ripple {
          position: fixed; width: 28px; height: 28px; border-radius: 999px;
          border: 2.5px solid #0ea5e9; background: rgba(14, 165, 233, 0.22);
          transform: translate(-50%, -50%) scale(0.3);
          opacity: 0;
        }
        .ripple.animate {
          animation: agy-ripple 420ms ease-out forwards;
        }
        @keyframes agy-ripple {
          0% { transform: translate(-50%, -50%) scale(0.35); opacity: 0.95; }
          100% { transform: translate(-50%, -50%) scale(1.7); opacity: 0; }
        }
      </style>
      <div class="root">
        <div class="highlight" id="hl"></div>
        <div class="ripple" id="rp"></div>
        <div class="cursor" id="cur">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <path d="M4 2L19 11.5L11.5 13.5L8.5 21L4 2Z" fill="#0ea5e9" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="pill" id="pill"></div>
      </div>
    `;
          }
          return shadow;
        };

        if (command.type === 'hide') {
          const shadow = document.getElementById(hostId)?.shadowRoot;
          if (!shadow) return;
          shadow.getElementById('hl')?.classList.remove('visible');
          shadow.getElementById('pill')?.classList.remove('visible');
          shadow.getElementById('cur')?.classList.remove('visible');
          shadow.getElementById('rp')?.classList.remove('animate');
          return;
        }

        const shadow = ensureHud();
        if (!shadow) return;

        if (command.type === 'status') {
          const pill = shadow.getElementById('pill');
          if (pill) {
            pill.textContent = `AGY Chrome · ${command.text}`;
            pill.classList.add('visible');
          }
          return;
        }

        if (command.type === 'move') {
          const cur = shadow.getElementById('cur') as HTMLElement | null;
          if (cur) {
            cur.style.left = `${command.x}px`;
            cur.style.top = `${command.y}px`;
            cur.classList.add('visible');
          }
          const hl = shadow.getElementById('hl') as HTMLElement | null;
          if (hl) {
            if (command.box) {
              hl.style.left = `${command.box.x}px`;
              hl.style.top = `${command.box.y}px`;
              hl.style.width = `${command.box.width}px`;
              hl.style.height = `${command.box.height}px`;
              hl.classList.add('visible');
            } else {
              hl.classList.remove('visible');
            }
          }
          return;
        }

        if (command.type === 'ripple') {
          const rp = shadow.getElementById('rp') as HTMLElement | null;
          if (rp) {
            rp.style.left = `${command.x}px`;
            rp.style.top = `${command.y}px`;
            rp.classList.remove('animate');
            void rp.offsetWidth;
            rp.classList.add('animate');
          }
        }
      },
      { hostId: HUD_HOST_ID, command: cmd },
    );
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HUD_EVAL_TIMEOUT_MS);
    });
    await Promise.race([evalPromise.catch(() => {}), timeoutPromise]);
    if (timer) clearTimeout(timer);
  } catch {
    // Visual HUD is best-effort; never fail an action due to navigation or closed page.
  }
}

export async function hudShowStatus(page: Page, text: string): Promise<void> {
  await runHudOp(page, { type: 'status', text });
}

export async function hudMoveCursor(
  page: Page,
  x: number,
  y: number,
  box?: HudBox,
): Promise<void> {
  await runHudOp(page, { type: 'move', x, y, box: box ?? null });
}

export async function hudClickRipple(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await runHudOp(page, { type: 'ripple', x, y });
}

export async function hudHideTransient(page: Page): Promise<void> {
  await runHudOp(page, { type: 'hide' });
}

