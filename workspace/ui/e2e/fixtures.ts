import { test as base, expect, type Page } from '@playwright/test';
import type { AppError } from '../src/ipc/git';
import type { MenuItem } from '../src/mock/backend';
import type { Snapshot } from '../src/mock/repo';

/** `window.__mock`, driven from the test side. */
export type Mock = {
  idle(): Promise<void>;
  state(): Promise<Snapshot>;
  remotePush(upstream: string, n: number): Promise<void>;
  agentEdit(path: string, text: string | null, opts?: { watcher?: boolean }): Promise<void>;
  emit(event: string): Promise<void>;
  fail(cmd: string, error: AppError): Promise<void>;
  hold(cmd: string): Promise<void>;
  release(cmd: string): Promise<void>;
  menu(item: MenuItem, path?: string): Promise<void>;
  quit(): Promise<void>;
  exited(): Promise<boolean>;
  /** The names of the commands invoked so far, in order. */
  calls(): Promise<string[]>;
  terminalText(id?: number): Promise<string>;
  terminalWrite(text: string, id?: number): Promise<void>;
};

const mockOf = (page: Page): Mock => ({
  idle: () => page.evaluate(() => globalThis.__mock!.idle()),
  state: () => page.evaluate(() => globalThis.__mock!.state()),
  remotePush: (upstream, n) => page.evaluate(([u, k]) => globalThis.__mock!.remotePush(u, k), [upstream, n] as const),
  agentEdit: (path, text, opts) =>
    page.evaluate(([p, t, o]) => globalThis.__mock!.agentEdit(p, t, o), [path, text, opts] as const),
  emit: (event) => page.evaluate((e) => globalThis.__mock!.emit(e), event),
  fail: (cmd, error) => page.evaluate(([c, e]) => globalThis.__mock!.fail(c, e), [cmd, error] as const),
  hold: (cmd) => page.evaluate((c) => globalThis.__mock!.hold(c), cmd),
  release: (cmd) => page.evaluate((c) => globalThis.__mock!.release(c), cmd),
  menu: (item, path) => page.evaluate(([i, p]) => globalThis.__mock!.menu(i, p), [item, path] as const),
  quit: () => page.evaluate(() => globalThis.__mock!.quit()),
  exited: () => page.evaluate(() => globalThis.__mock!.exited()),
  calls: () => page.evaluate(() => globalThis.__mock!.calls.map((c) => c.cmd)),
  terminalText: (id) => page.evaluate((i) => globalThis.__mock!.terminalText(i), id),
  terminalWrite: (text, id) => page.evaluate(([t, i]) => globalThis.__mock!.terminalWrite(t, i), [text, id] as const),
});

type Fixtures = {
  /** Opens mock.html on a scenario and waits for the app to settle. */
  open: (scenario?: string, params?: Record<string, string>) => Promise<Mock>;
  /** Console errors and uncaught exceptions; any left at the end fails the test, as in scripts/smoke.sh. */
  errors: string[];
};

export const test = base.extend<Fixtures>({
  errors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await use(errors);
    expect(errors, 'the page logged errors').toEqual([]);
  }, { auto: true }],

  open: async ({ page }, use) => {
    await use(async (scenario = 'review', params = {}) => {
      // motion: 'on' in params overrides this default and keeps the scenario's animations.
      await page.goto(`/mock.html?${new URLSearchParams({ scenario, slow: '0', motion: 'off', ...params })}`);
      await page.waitForSelector('html[data-mock-idle]', { state: 'attached' });
      const mock = mockOf(page);
      await mock.idle();
      return mock;
    });
  },
});

export { expect };

/** `open` params for a test of the heavy motion: on a Linux host the default platform is linux, whose `lite`
 *  level turns that motion off. The page then runs the macOS keymap, so a Mod key is `Meta`, not `ControlOrMeta`,
 *  which is Control on a Linux host. */
export const FULL_MOTION = { platform: 'macos', motion: 'on' };

/** The queue row for a path, in the Changes (`unstaged`) or Staged section. */
export const row = (page: Page, section: 'unstaged' | 'staged', path: string) =>
  page.locator(`.row[data-key="${section}:${path}"]`);

export type FadeFrame = { present: boolean; opacity: number };

/** Starts sampling `selector` on every animation frame, from before the action that may fade or remove it, so
 *  a check afterward reads what actually happened instead of racing a fixed sleep against the real animation
 *  (which a slow run can blow through, or a broken, instant implementation can already be done by). Call the
 *  returned function once the element is gone (or enough time has passed) to get the recorded frames. */
export async function recordFade(page: Page, selector: string, ms = 1000): Promise<() => Promise<FadeFrame[]>> {
  await page.evaluate(([sel, duration]) => {
    const frames: FadeFrame[] = [];
    (window as unknown as { __fade: FadeFrame[] }).__fade = frames;
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector(sel);
      frames.push({ present: el !== null, opacity: el ? Number(getComputedStyle(el).opacity) : 0 });
      if (performance.now() - t0 < duration) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selector, ms] as const);
  return () => page.evaluate(() => (window as unknown as { __fade: FadeFrame[] }).__fade);
}

/** True once some sampled frame had the element present with a sub-1 opacity: proof an exit animation ran,
 *  not an instant removal (which jumps from opacity 1 straight to absent). */
export const fadedOut = (frames: FadeFrame[]): boolean => frames.some((f) => f.present && f.opacity < 1);
