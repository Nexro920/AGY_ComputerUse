import type { Page } from 'playwright';

export interface SettleOptions {
  quietMs?: number;
  maxWaitMs?: number;
}

export async function autoSettle(
  page: Page,
  opts?: SettleOptions,
): Promise<void> {
  const quietMs = opts?.quietMs ?? 150;
  const maxWaitMs = opts?.maxWaitMs ?? 1200;

  try {
    await page
      .waitForLoadState('domcontentloaded', { timeout: Math.min(maxWaitMs, 800) })
      .catch(() => {});

    await page
      .evaluate(
        ({ qMs, mMs }) =>
          new Promise<void>((resolve) => {
            const root = document.body || document.documentElement;
            if (!root) {
              requestAnimationFrame(() => resolve());
              return;
            }

            let quietTimer: ReturnType<typeof setTimeout>;
            const hardTimer = setTimeout(() => {
              observer.disconnect();
              resolve();
            }, mMs);

            const finish = () => {
              clearTimeout(hardTimer);
              observer.disconnect();
              requestAnimationFrame(() => resolve());
            };

            const resetQuiet = () => {
              clearTimeout(quietTimer);
              quietTimer = setTimeout(finish, qMs);
            };

            const observer = new MutationObserver((records) => {
              const relevant = records.some((r) => {
                const target = r.target as Element | null;
                return !target?.closest?.('#__agy_chrome_use_hud__');
              });
              if (relevant) resetQuiet();
            });

            observer.observe(root, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });

            resetQuiet();
          }),
        { qMs: quietMs, mMs: maxWaitMs },
      )
      .catch(() => {});
  } catch {
    // Page closed or mid-navigation; ignore settle errors.
  }
}
