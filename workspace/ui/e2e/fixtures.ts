import { test as base, expect, type Page } from '@playwright/test';
import type { AppError } from '../src/ipc/git';
import type { MenuItem } from '../src/mock/backend';
import type { Snapshot } from '../src/mock/repo';

/** `window.__mock`, driven from the test side. */
export type Mock = {
  idle(): Promise<void>;
  state(): Promise<Snapshot>;
  agentEdit(path: string, text: string | null, opts?: { watcher?: boolean }): Promise<void>;
  emit(event: string): Promise<void>;
  fail(cmd: string, error: AppError): Promise<void>;
  menu(item: MenuItem, path?: string): Promise<void>;
  /** The names of the commands invoked so far, in order. */
  calls(): Promise<string[]>;
  terminalText(id?: number): Promise<string>;
};

const mockOf = (page: Page): Mock => ({
  idle: () => page.evaluate(() => globalThis.__mock!.idle()),
  state: () => page.evaluate(() => globalThis.__mock!.state()),
  agentEdit: (path, text, opts) =>
    page.evaluate(([p, t, o]) => globalThis.__mock!.agentEdit(p, t, o), [path, text, opts] as const),
  emit: (event) => page.evaluate((e) => globalThis.__mock!.emit(e), event),
  fail: (cmd, error) => page.evaluate(([c, e]) => globalThis.__mock!.fail(c, e), [cmd, error] as const),
  menu: (item, path) => page.evaluate(([i, p]) => globalThis.__mock!.menu(i, p), [item, path] as const),
  calls: () => page.evaluate(() => globalThis.__mock!.calls.map((c) => c.cmd)),
  terminalText: (id) => page.evaluate((i) => globalThis.__mock!.terminalText(i), id),
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
      await page.goto(`/mock.html?${new URLSearchParams({ scenario, slow: '0', ...params })}`);
      await page.waitForSelector('html[data-mock-idle]', { state: 'attached' });
      const mock = mockOf(page);
      await mock.idle();
      return mock;
    });
  },
});

export { expect };

/** The queue row for a path, in the Changes (`unstaged`) or Staged section. */
export const row = (page: Page, section: 'unstaged' | 'staged', path: string) =>
  page.locator(`.row[data-key="${section}:${path}"]`);
