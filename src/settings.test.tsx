import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { setValue, tick } from './test-setup';
import type { CustomCommand, Settings } from './settings';

vi.mock('./git', async () => {
  const actual = await vi.importActual<typeof import('./git')>('./git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});

const { git } = await import('./git');
const { S } = await import('./app/store');
const { DEFAULTS, SECTIONS } = await import('./settings');
const { dispatch, openSettings, setSetting, view } = await import('./app/controller');
const { buildState } = await import('./editor');
const { EditorView } = await import('@codemirror/view');
const { confirmDialog } = await import('./toast');
const { Overlays } = await import('./app/Overlays');

const KEY = 'general.headless-ai-provider';
const THEME = 'appearance.theme';
let root: Root;
/** What the backend holds; only a save that succeeds changes it. */
let disk: Settings;
let savedCommands: CustomCommand[];

beforeEach(() => {
  vi.clearAllMocks();
  delete document.documentElement.dataset.theme;
  localStorage.removeItem('codebaer.theme');
  document.body.innerHTML = '<div id="host"></div>';
  S.palette = null; S.confirm = null; S.prompt = null; S.orphans = null; S.toasts = []; S.sidebarHidden = false;
  S.settings = { ...DEFAULTS };
  S.settingsOpen = false;
  disk = { ...DEFAULTS };
  savedCommands = [];
  S.root = '/Users/me/projects/app';
  vi.mocked(git.settings).mockImplementation(() => Promise.resolve({ ...disk }));
  vi.mocked(git.saveSettings).mockImplementation((s) => { disk = { ...s }; return Promise.resolve(); });
  vi.mocked(git.commands).mockImplementation(() => Promise.resolve(savedCommands.map((c) => ({ ...c }))));
  vi.mocked(git.saveCommands).mockImplementation((c) => { savedCommands = c; return Promise.resolve(); });
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
    expect([...d.querySelectorAll('[role="tab"]')].map((t) => t.textContent))
      .toEqual(['General', 'Appearance', 'Commands']);
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
    disk = { ...DEFAULTS, [KEY]: 'claude' };
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
    expect(git.saveSettings).toHaveBeenCalledExactlyOnceWith({ [KEY]: 'claude', [THEME]: 'codebaer' });
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

describe('appearance', () => {
  const cards = () => [...document.querySelectorAll<HTMLButtonElement>('.settings [role="radio"]')];
  const name = (c: Element) => c.querySelector('.theme-name')!.textContent;
  const card = (label: string) => cards().find((c) => name(c) === label)!;
  const checked = () => cards().filter((c) => c.getAttribute('aria-checked') === 'true').map(name);
  const group = (title: string) => {
    const g = [...document.querySelectorAll<HTMLElement>('.settings [role="group"]')]
      .find((e) => e.querySelector('.theme-group-title')!.textContent === title)!;
    return [...g.querySelectorAll('[role="radio"]')].map(name);
  };

  async function openAppearance() {
    await openSettings();
    await tick();
    const tab = [...document.querySelectorAll<HTMLElement>('.settings [role="tab"]')]
      .find((t) => t.textContent === 'Appearance')!;
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await tick();
  }

  it('offers every theme as a card, dark and light apart, with the saved one checked', async () => {
    await openAppearance();
    expect(cards()).toHaveLength(19);
    expect(group('Dark')).toHaveLength(11);
    expect(group('Dark')[0]).toBe('CodeBär');
    expect(group('Light')).toEqual([
      'GitHub Light', 'One Light', 'Catppuccin Latte', 'Tokyo Night Day',
      'Gruvbox Light', 'Solarized Light', 'Ayu Light', 'Rosé Pine Dawn',
    ]);
    expect(checked()).toEqual(['CodeBär']);
  });

  it('paints each preview in its own theme, whatever the app is in', async () => {
    await openAppearance();
    expect(card('Nord').querySelector('.theme-preview')!.getAttribute('data-theme')).toBe('nord');
    expect(card('CodeBär').querySelector('.theme-preview')!.getAttribute('data-theme')).toBe('codebaer');
  });

  it('applies a picked theme at once and saves it', async () => {
    await openAppearance();
    card('Catppuccin Latte').click();
    await tick();
    expect(document.documentElement.dataset.theme).toBe('catppuccin-latte');
    expect(localStorage.getItem('codebaer.theme')).toBe('catppuccin-latte');
    expect(git.saveSettings).toHaveBeenCalledExactlyOnceWith({ [KEY]: 'off', [THEME]: 'catppuccin-latte' });
    expect(checked()).toEqual(['Catppuccin Latte']);
  });

  it('switches the open editor between its light and dark styles', async () => {
    view.setState(await buildState('plain', 'a.ts', 'const a = 1;\n', null, () => {}));
    await openAppearance();
    card('GitHub Light').click();
    await tick();
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    card('Dracula').click();
    await tick();
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  });

  it('goes back to the saved theme when the save fails', async () => {
    vi.mocked(git.saveSettings).mockRejectedValue({ kind: 'Io', detail: 'disk full' });
    await openAppearance();
    card('Nord').click();
    await tick();
    await tick();
    expect(document.documentElement.dataset.theme).toBe('codebaer');
    expect(checked()).toEqual(['CodeBär']);
    expect(S.toasts.map((t) => t.kind)).toEqual(['err']);
  });

  it('applies the theme the file holds when it is read', async () => {
    disk = { ...DEFAULTS, [THEME]: 'gruvbox-light' };
    await openAppearance();
    expect(document.documentElement.dataset.theme).toBe('gruvbox-light');
    expect(checked()).toEqual(['Gruvbox Light']);
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

describe('commands', () => {
  const HERE = '/Users/me/projects/app';
  const cmd = (name: string, command: string, repo: string | null): CustomCommand => ({ name, command, repo });
  const groups = () => [...document.querySelectorAll<HTMLElement>('.settings .cmd-group')].map((g) => [
    g.querySelector('.theme-group-title')!.textContent,
    [...g.querySelectorAll('.cmd-name')].map((n) => n.textContent),
  ]);
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.settings button')]
      .find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
  const field = (label: string) =>
    [...document.querySelectorAll<HTMLLabelElement>('.settings .cmd-field')]
      .find((l) => l.querySelector('span')!.textContent === label)!.querySelector('input')!;

  it('opens on the section it is asked for', async () => {
    await openSettings('commands');
    await tick();
    expect(document.querySelector('.settings [role="tab"][data-state="active"]')!.textContent).toBe('Commands');
  });

  it('groups this repo first, then the global ones, then every other repo under its path', async () => {
    savedCommands = [
      cmd('Deploy', './deploy.sh', null), cmd('Build', 'make', '/Users/me/projects/lib'), cmd('', 'pnpm test', HERE),
    ];
    await openSettings('commands');
    await tick();
    expect(groups()).toEqual([
      ['This repository~/projects/app', ['pnpm test']],
      ['Every repository', ['Deploy']],
      ['~/projects/lib', ['Build']],
    ]);
  });

  it('saves a new command for this repo, trimmed, and keeps every other repo\'s', async () => {
    savedCommands = [cmd('Build', 'make', '/Users/me/projects/lib')];
    await openSettings('commands');
    await tick();
    button('Add command').click();
    await tick();
    setValue(field('Name'), ' Test ');
    setValue(field('Command'), '  pnpm test  ');
    await tick();
    button('Save').click();
    await tick();
    expect(savedCommands).toEqual([cmd('Build', 'make', '/Users/me/projects/lib'), cmd('Test', 'pnpm test', HERE)]);
    expect(groups()[0]).toEqual(['This repository~/projects/app', ['Test']]);
  });

  it('refuses a command with nothing to run', async () => {
    await openSettings('commands');
    await tick();
    button('Add command').click();
    await tick();
    setValue(field('Command'), '   ');
    await tick();
    expect(button('Save').disabled).toBe(true);
  });

  it('moves a command to every repository and deletes another', async () => {
    savedCommands = [cmd('Lint', 'pnpm lint', HERE), cmd('Old', 'rm -rf dist', HERE)];
    await openSettings('commands');
    await tick();
    button('Edit Lint').click();
    await tick();
    [...document.querySelectorAll<HTMLButtonElement>('.cmd-form .seg-item')]
      .find((b) => b.textContent === 'Every repository')!.click();
    await tick();
    button('Save').click();
    await tick();
    expect(savedCommands).toEqual([cmd('Lint', 'pnpm lint', null), cmd('Old', 'rm -rf dist', HERE)]);
    button('Delete Old').click();
    await tick();
    expect(savedCommands).toEqual([cmd('Lint', 'pnpm lint', null)]);
  });

  it('puts the list back and says why when the save fails', async () => {
    savedCommands = [cmd('Lint', 'pnpm lint', HERE)];
    vi.mocked(git.saveCommands).mockRejectedValue({ kind: 'Io', detail: 'disk full' });
    await openSettings('commands');
    await tick();
    button('Delete Lint').click();
    await tick();
    await tick();
    expect(S.commands).toEqual([cmd('Lint', 'pnpm lint', HERE)]);
    expect(groups()[0]).toEqual(['This repository~/projects/app', ['Lint']]);
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['err', expect.stringContaining('disk full')]]);
  });
});
