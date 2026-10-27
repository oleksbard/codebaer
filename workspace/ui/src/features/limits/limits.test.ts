import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimitWindow } from '#ipc/git';
import { logInfo } from '#ipc/log';
import { DEFAULTS } from '#ipc/settings';
import { notify, S } from '#kernel/store';
import { g, mountApp } from '#test-app';
import { exitTick, tick, tipOf } from '#test-setup';
import { agoText, headline, meterWindows, refreshLimits, resetText, startLimits } from './limits';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});
vi.mock('#ipc/log', async () => {
  const actual = await vi.importActual<typeof import('#ipc/log')>('#ipc/log');
  return { ...actual, logInfo: vi.fn() };
});

const MIN = 60_000;
const win = (label: string, percent: number, weekly: boolean, resets: string | null = null): LimitWindow =>
  ({ label, percent, resets, resets_at: null, weekly });
const CLAUDE = [win('Session', 14, false, 'Oct 17 at 11:20pm'), win('Week (all models)', 86.4, true, 'Oct 20 at 9am')];
const CODEX = [win('5 hours', 31, false), win('Week', 40, true)];

const pills = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.head .limit-pill')];
const shown = (): string[] => pills().map((p) => `${p.dataset.provider}:${p.textContent}`);
const asked = (): unknown[] => g.usageLimits!.mock.calls.map((c) => c[0]);

let every = (): void => {};
/** Moves the clock on a minute at a time, the way the interval ticks. */
function wait(ms: number): void {
  for (let t = 0; t < ms; t += MIN) {
    vi.setSystemTime(Date.now() + MIN);
    every();
  }
}

async function settle(): Promise<void> {
  await tick();
  await tick();
  await exitTick();
}

describe('the windows the pill shows', () => {
  it('draws the fullest short window above the first weekly one', () => {
    const fable = win('Week (Fable)', 99, true);
    const labels = (ws: LimitWindow[]): string[] => meterWindows(ws).map((w) => w.label);
    expect(labels([...CLAUDE, fable])).toEqual(['Session', 'Week (all models)']);
    expect(labels([win('5 hours', 31, false), win('Day', 60, false)])).toEqual(['Day']);
    expect(labels([win('Day', 60, false), win('5 hours', 31, false)])).toEqual(['Day']);
    expect(labels([win('5 hours', 50, false), win('Day', 50, false)])).toEqual(['Day']);
    expect(labels([win('Week', 40, true)])).toEqual(['Week']);
    expect(labels([])).toEqual([]);
  });

  it('numbers the pill with the fuller of its meters, and the week on a tie', () => {
    expect(headline(CLAUDE)?.label).toBe('Week (all models)');
    expect(headline([win('Session', 100, false), win('Week (all models)', 81, true)])?.label).toBe('Session');
    expect(headline([win('Session', 100, false), win('Week (all models)', 100, true)])?.label)
      .toBe('Week (all models)');
    expect(headline([win('5 hours', 86.4, false), win('Week', 85.6, true)])?.label).toBe('Week');
    expect(headline([...CLAUDE, win('Week (Fable)', 99, true)])?.label).toBe('Week (all models)');
    expect(headline([win('5 hours', 31, false), win('Day', 60, false)])?.label).toBe('Day');
    expect(headline([win('Week', 40, true)])?.label).toBe('Week');
    expect(headline([])).toBeUndefined();
  });

  it('shortens claude\'s reset to today or tomorrow and drops the local time zone', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date(2026, 9, 17, 20, 0);
    const at = (text: string): string | null => resetText(win('Week', 1, true, text), now);
    expect(at(`Oct 17 at 11pm (${zone})`)).toBe('today at 11pm');
    expect(at(`Oct 18 at 9am (${zone})`)).toBe('tomorrow at 9am');
    expect(at('Oct 20 at 9am (Mars/Olympus)')).toBe('Oct 20 at 9am (Mars/Olympus)');
    expect(resetText(win('Week', 1, true), now)).toBeNull();
  });

  it('says codex\'s reset as today, tomorrow or a weekday, with the time', () => {
    const now = new Date(2026, 9, 17, 20, 0);
    const at = (d: Date): string | null =>
      resetText({ ...win('Week', 1, true), resets_at: d.getTime() / 1000 }, now);
    expect(at(new Date(2026, 9, 17, 22, 30))).toMatch(/^today at 10:30/);
    expect(at(new Date(2026, 9, 18, 1, 0))).toMatch(/^tomorrow at 1:00/);
    expect(at(new Date(2026, 9, 21, 9, 0))).toMatch(/^Wed at 9:00/);
  });

  it('says how long ago the limits were read', () => {
    expect(agoText(0, 30_000)).toBe('just now');
    expect(agoText(0, 5 * MIN)).toBe('5 min ago');
    expect(agoText(0, 125 * MIN)).toBe('2 h ago');
  });
});

// startLimits keeps one timer and one subscription for the module, so these run in order on one start
describe('reading the limits', () => {
  beforeAll(async () => {
    await mountApp();
    // jsdom's animation frames run on setInterval, so only the module's own interval is caught
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 20, 0));
    vi.spyOn(globalThis, 'setInterval').mockImplementationOnce((fn) => {
      every = fn as () => void;
      return 0;
    });
    for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
    S.settings = { ...DEFAULTS, 'limits.codex': 'off' };
    g.usageLimits!.mockImplementation((p) => Promise.resolve(p === 'claude' ? CLAUDE : CODEX));
    startLimits();
    await settle();
  });
  afterAll(() => { vi.useRealTimers(); });
  beforeEach(() => {
    g.usageLimits!.mockClear();
    vi.mocked(logInfo).mockClear();
  });

  it('asks only the CLIs that are on, and shows the weekly percent', async () => {
    expect(shown()).toEqual(['claude:86%']);
    expect(pills()[0]!.getAttribute('aria-label')).toBe('Claude Code: 86% used, week (all models) limit');
    const meters = [...pills()[0]!.querySelectorAll<HTMLElement>('.limit-meter')];
    expect(meters.map((m) => [m.dataset.level, m.style.getPropertyValue('--used')])).toEqual([
      ['low', '0.14'], ['mid', '0.86'],
    ]);
    const tip = await tipOf(pills()[0]!);
    expect(tip).toContain('Week (all models)86%Resets Oct 20 at 9am');
    expect(tip).toContain('Session14%Resets today at 11:20pm');
    expect(tip).toContain('Updated just now · click to refresh');
  });

  it('asks a CLI as soon as it is turned on, and hides it as soon as it is turned off', async () => {
    S.settings = { ...S.settings, 'limits.codex': 'on' };
    notify();
    await settle();
    expect(asked()).toEqual(['codex']);
    expect(shown()).toEqual(['claude:86%', 'codex:40%']);
    S.settings = { ...S.settings, 'limits.claude': 'off' };
    notify();
    await settle();
    expect(shown()).toEqual(['codex:40%']);
    S.settings = { ...S.settings, 'limits.claude': 'on' };
    notify();
    await settle();
    expect(asked()).toEqual(['codex', 'claude']);
  });

  it('reads them again every five minutes while the window is visible', async () => {
    wait(4 * MIN);
    expect(asked()).toEqual([]);
    wait(MIN);
    await settle();
    expect(asked()).toEqual(['claude', 'codex']);
    g.usageLimits!.mockClear();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    wait(10 * MIN);
    expect(asked()).toEqual([]);
    hidden.mockRestore();
    wait(MIN);
    await settle();
    expect(asked()).toEqual(['claude', 'codex']);
  });

  it('keeps the last windows after a failed read, says why in the tip, and logs the reason once', async () => {
    g.usageLimits!.mockRejectedValue({ kind: 'Ai', detail: 'Not logged in' });
    pills()[0]!.click();
    await settle();
    pills()[0]!.click();
    await settle();
    expect(shown()).toEqual(['claude:86%', 'codex:40%']);
    expect(pills()[0]!.dataset.stale).toBe('true');
    expect(await tipOf(pills()[0]!)).toContain('Could not refresh: Not logged in');
    expect(vi.mocked(logInfo).mock.calls).toEqual([['claude limits: Not logged in']]);
  });

  it('drops a CLI that is not installed and asks it again only on a click or a settings change', async () => {
    g.usageLimits!.mockImplementation((p) => Promise.resolve(p === 'claude' ? CLAUDE : null));
    wait(5 * MIN);
    await settle();
    expect(shown()).toEqual(['claude:86%']);
    expect(pills()[0]!.dataset.stale).toBeUndefined();
    g.usageLimits!.mockClear();
    wait(5 * MIN);
    await settle();
    expect(asked()).toEqual(['claude']);
    g.usageLimits!.mockClear();
    await refreshLimits(true);
    expect(asked()).toEqual(['claude', 'codex']);
    g.usageLimits!.mockClear();
    S.settings = { ...S.settings, 'limits.codex': 'off' };
    notify();
    S.settings = { ...S.settings, 'limits.codex': 'on' };
    notify();
    await settle();
    expect(asked()).toEqual(['codex']);
  });

  it('shows no pill for a CLI that has never answered with windows, such as one on an API key', async () => {
    g.usageLimits!.mockImplementation((p) => (p === 'claude'
      ? Promise.resolve(CLAUDE)
      : Promise.reject({ kind: 'Ai', detail: 'chatgpt authentication required to read rate limits' })));
    await refreshLimits(true);
    await settle();
    expect(S.limits.codex?.error).toBe('chatgpt authentication required to read rate limits');
    expect(shown()).toEqual(['claude:86%']);
  });

  it('shows a full session over a week that is not full', async () => {
    g.usageLimits!.mockResolvedValueOnce([win('Session', 100, false), win('Week (all models)', 81, true)]);
    pills()[0]!.click();
    await settle();
    const pill = pills()[0]!;
    expect(shown()).toEqual(['claude:100%']);
    expect(pill.dataset.level).toBe('high');
    expect(pill.getAttribute('aria-label')).toBe('Claude Code: 100% used, session limit');
    const meters = [...pill.querySelectorAll<HTMLElement>('.limit-meter')];
    expect(meters.map((m) => m.dataset.level)).toEqual(['high', 'mid']);
  });
});
