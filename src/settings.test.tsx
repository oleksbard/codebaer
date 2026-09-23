import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from './test-setup';
import type { Settings } from './settings';

vi.mock('./git', async () => {
  const actual = await vi.importActual<typeof import('./git')>('./git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});

const { git } = await import('./git');
const { S } = await import('./app/store');
const { DEFAULTS, SECTIONS } = await import('./settings');
const { dispatch, openSettings, setSetting } = await import('./app/controller');
const { confirmDialog } = await import('./toast');
const { Overlays } = await import('./app/Overlays');

const KEY = 'general.headless-ai-provider';
let root: Root;
/** What the backend holds; only a save that succeeds changes it. */
let disk: Settings;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="host"></div>';
  S.palette = null; S.confirm = null; S.prompt = null; S.orphans = null; S.toasts = []; S.sidebarHidden = false;
  S.settings = { ...DEFAULTS };
  S.settingsOpen = false;
  disk = { ...DEFAULTS };
  vi.mocked(git.settings).mockImplementation(() => Promise.resolve({ ...disk }));
  vi.mocked(git.saveSettings).mockImplementation((s) => { disk = { ...s }; return Promise.resolve(); });
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<Overlays />));
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

const dialog = () => document.querySelector<HTMLElement>('.dialog.settings');
const choice = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.settings .seg-item')].find((b) => b.textContent === label)!;
const pressed = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.settings .seg-item')]
    .filter((b) => b.dataset.state === 'on').map((b) => b.textContent);

describe('the catalog', () => {
  it('prefixes every key with its section and offers its default as a choice', () => {
    for (const s of SECTIONS) {
      for (const o of s.options) {
        expect(o.key.startsWith(`${s.id}.`)).toBe(true);
        expect(o.description.length).toBeGreaterThan(0);
        expect(o.choices.map((c) => c.value)).toContain(DEFAULTS[o.key]);
      }
    }
  });

  it('turns AI commit messages off by default', () => {
    expect(DEFAULTS[KEY]).toBe('off');
  });
});

describe('settings dialog', () => {
  it('lists the sections and shows each option with its label, key and description', async () => {
    await openSettings();
    await tick();
    const d = dialog()!;
    expect([...d.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['General']);
    const row = d.querySelector<HTMLElement>('.setting')!;
    expect(row.querySelector('.setting-label')!.textContent).toBe('Headless AI provider');
    expect(row.querySelector('.setting-key')!.textContent).toBe(KEY);
    expect(row.querySelector('.setting-desc')!.textContent).toMatch(/commit message/i);
    expect(pressed()).toEqual(['Off']);
  });

  it('tabs from the section list straight to the options, not to the panel around them', async () => {
    await openSettings();
    await tick();
    expect(dialog()!.querySelector('[role="tabpanel"]')!.getAttribute('tabindex')).toBe('-1');
  });

  it('reads the file again on every opening', async () => {
    disk = { [KEY]: 'claude' };
    await openSettings();
    await tick();
    expect(git.settings).toHaveBeenCalledTimes(1);
    expect(pressed()).toEqual(['Claude']);
  });

  it('saves a click to disk right away and shows the choice', async () => {
    await openSettings();
    await tick();
    choice('Claude').click();
    await tick();
    expect(git.saveSettings).toHaveBeenCalledExactlyOnceWith({ [KEY]: 'claude' });
    expect(disk[KEY]).toBe('claude');
    expect(S.settings[KEY]).toBe('claude');
    expect(pressed()).toEqual(['Claude']);
  });

  it('keeps the choice when the pressed item is clicked again', async () => {
    await openSettings();
    await tick();
    choice('Off').click();
    await tick();
    expect(git.saveSettings).not.toHaveBeenCalled();
    expect(pressed()).toEqual(['Off']);
  });

  it('goes back to the previous value and says why when the save fails', async () => {
    vi.mocked(git.saveSettings).mockRejectedValue({ kind: 'Io', detail: 'disk full' });
    await openSettings();
    await tick();
    choice('Claude').click();
    await tick();
    await tick();
    expect(S.settings[KEY]).toBe('off');
    expect(pressed()).toEqual(['Off']);
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['err', expect.stringContaining('disk full')]]);
  });

  it('closes on Escape', async () => {
    await openSettings();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(S.settingsOpen).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('says so and stays closed when the file cannot be read', async () => {
    vi.mocked(git.settings).mockRejectedValue('ipc down');
    await openSettings();
    expect(S.settingsOpen).toBe(false);
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['err', expect.stringContaining('ipc down')]]);
  });

  it('does not open over an overlay that took the screen while the file was read', async () => {
    let done!: () => void;
    vi.mocked(git.settings).mockReturnValue(new Promise((r) => { done = () => r({ ...DEFAULTS }); }));
    const opening = openSettings();
    const confirm = confirmDialog('Discard?');
    done();
    await opening;
    expect(S.settingsOpen).toBe(false);
    S.confirm?.resolve(false);
    S.confirm = null;
    await confirm;
  });

  it('only the latest of two openings in flight shows, so Escape is not undone by the other', async () => {
    const reads: Array<() => void> = [];
    vi.mocked(git.settings).mockImplementation(() => new Promise((r) => { reads.push(() => r({ ...disk })); }));
    const first = openSettings();
    const second = openSettings();
    await tick();
    reads[0]!();
    await first;
    const shownEarly = S.settingsOpen;
    await tick();
    // settled before asserting: a read left pending would stall the settings queue for every later test
    reads[1]!();
    await second;
    expect(shownEarly).toBe(false);
    expect(S.settingsOpen).toBe(true);
  });

  it('reports a failed read once when two openings in flight both fail', async () => {
    vi.mocked(git.settings).mockRejectedValue('ipc down');
    await Promise.all([openSettings(), openSettings()]);
    expect(S.toasts).toHaveLength(1);
  });

  it('shortcuts do nothing while it is open', async () => {
    await openSettings();
    await tick();
    dispatch('toggleSidebar');
    expect(S.sidebarHidden).toBe(false);
  });
});

describe('setSetting', () => {
  type Save = { sent: Settings; ok(): void; fail(): void };
  let held: Save[] = [];
  // a save left pending by a failed assertion would stall the settings queue for every later test
  afterEach(async () => {
    // one at a time: settling a save is what lets the next queued one reach the backend
    for (let i = 0; i < held.length; i++) {
      held[i]!.fail();
      await tick();
    }
  });
  /** Saves that wait for the test to settle them, in the order they reached the backend. */
  function heldSaves(): Save[] {
    held = [];
    vi.mocked(git.saveSettings).mockImplementation((sent) => new Promise((resolve, reject) => {
      held.push({
        sent,
        ok: () => { disk = { ...sent }; resolve(); },
        fail: () => reject({ kind: 'Io', detail: 'read-only' }),
      });
    }));
    return held;
  }
  const click = async (label: string) => { choice(label).click(); await tick(); };
  const settle = async (s: Save | undefined, how: 'ok' | 'fail') => { s![how](); await tick(); await tick(); };

  it('saves one change at a time, so the file ends with the last choice', async () => {
    await openSettings();
    await tick();
    const held = heldSaves();
    await click('Claude');
    await click('Off');
    expect(held).toHaveLength(1);
    await settle(held[0], 'ok');
    expect(held).toHaveLength(2);
    await settle(held[1], 'ok');
    expect(disk[KEY]).toBe('off');
    expect(S.settings[KEY]).toBe('off');
  });

  it('ends on what the file holds when a save in a quick back-and-forth fails', async () => {
    await openSettings();
    await tick();
    const held = heldSaves();
    await click('Claude');
    await click('Off');
    await settle(held[0], 'fail');
    expect(disk[KEY]).toBe('off');
    expect(S.settings[KEY]).toBe('off');
    expect(pressed()).toEqual(['Off']);
    // the queued Off is what the file already holds, so it is not written, and cannot fail a second time
    expect(held).toHaveLength(1);
    expect(S.toasts).toHaveLength(1);
  });

  it('ends on what the file holds when a save after a good one fails', async () => {
    await openSettings();
    await tick();
    const held = heldSaves();
    await click('Claude');
    await settle(held[0], 'ok');
    await click('Off');
    await click('Claude');
    await settle(held[1], 'fail');
    expect(disk[KEY]).toBe('claude');
    expect(S.settings[KEY]).toBe('claude');
    expect(pressed()).toEqual(['Claude']);
    expect(held).toHaveLength(2);
    expect(S.toasts).toHaveLength(1);
  });

  it('can be retried after a failure', async () => {
    await openSettings();
    await tick();
    vi.mocked(git.saveSettings).mockRejectedValueOnce({ kind: 'Io', detail: 'read-only' });
    await setSetting(KEY, 'claude');
    expect(S.settings[KEY]).toBe('off');
    await setSetting(KEY, 'claude');
    expect(disk[KEY]).toBe('claude');
    expect(S.settings[KEY]).toBe('claude');
  });
});
