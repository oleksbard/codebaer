import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { exitTick, setValue, tick } from '#test-setup';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});

const { S } = await import('#kernel/store');
const { pick } = await import('#kernel/pick');
const { choiceDialog, confirmDialog, errorDialog, promptDialog, toast } = await import('#kernel/dialogs');
const { run } = await import('#kernel/registry');
const { OverlayHost } = await import('./OverlayHost');
await import('./bootstrap');

let root: Root;

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  S.palette = null; S.confirm = null; S.prompt = null; S.toasts = []; S.chord = false; S.sidebarHidden = false;
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<OverlayHost />));
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

describe('command palette', () => {
  it('lists items, filters on typing, Enter resolves the highlighted value and closes', async () => {
    const p = pick(
      [{ label: 'Git: Push', value: 'push' }, { label: 'Open Repository…', hint: '⌘O', value: 'open' }],
      'Type a command');
    await tick();
    const input = document.querySelector<HTMLInputElement>('.dialog.pal input')!;
    expect(input.placeholder).toBe('Type a command');
    expect([...document.querySelectorAll('.pal li')].map((l) => l.textContent))
      .toEqual(['Git: Push', 'Open Repository…⌘O']);
    setValue(input, 'open');
    await tick();
    expect([...document.querySelectorAll('.pal li')].map((l) => l.textContent)).toEqual(['Open Repository…⌘O']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBe('open');
    await tick();
    expect(document.querySelector('.pal')).toBeNull();
  });

  it('draws a hint as a keycap and a note as plain text', async () => {
    void pick([{ label: 'Open', hint: '⌘O', value: 1 }, { label: 'claude:1', note: 'last used', value: 2 }], 'x');
    await tick();
    const [key, note] = [...document.querySelectorAll('.pal li')];
    expect(key!.querySelector('kbd')!.textContent).toBe('⌘O');
    expect(note!.querySelector('kbd')).toBeNull();
    expect(note!.querySelector('.note')!.textContent).toBe('last used');
    document.querySelector<HTMLInputElement>('.pal input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('heads each group while nothing is typed and skips the headers in the highlight', async () => {
    const p = pick([
      { label: 'New', value: 0 }, { label: 'mine', group: 'Yours', value: 1 },
      { label: 'theirs', group: 'Others', dim: true, value: 2 },
    ], 'x');
    await tick();
    const input = document.querySelector<HTMLInputElement>('.pal input')!;
    const rows = () => [...document.querySelectorAll('.pal li')].map((l) => `${l.className}:${l.textContent}`);
    expect(rows()).toEqual(['on:New', 'group:Yours', ':mine', 'group:Others', 'dim:theirs']);
    setValue(input, 'i');
    await tick();
    expect(rows()).toEqual(['on:mine', 'dim:theirs']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBe(2);
  });

  it('ArrowDown moves the highlight, a click resolves that item', async () => {
    const p = pick([{ label: 'A', value: 1 }, { label: 'B', value: 2 }], 'x');
    await tick();
    const input = document.querySelector<HTMLInputElement>('.pal input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick();
    expect(document.querySelector('.pal li.on')!.textContent).toBe('B');
    document.querySelector<HTMLElement>('.pal li.on')!.click();
    await expect(p).resolves.toBe(2);
  });

  it('shows "No matching results" and Enter then resolves null', async () => {
    const p = pick([{ label: 'A', value: 1 }], 'x');
    await tick();
    const input = document.querySelector<HTMLInputElement>('.pal input')!;
    setValue(input, 'zzz');
    await tick();
    expect(document.querySelector('.pal li')!.textContent).toBe('No matching results');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it('Escape closes the palette and resolves null', async () => {
    const p = pick([{ label: 'A', value: 1 }], 'x');
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it('a second pick while one is open resolves the first with null', async () => {
    const first = pick([{ label: 'A', value: 1 }], 'x');
    await tick();
    const second = pick([{ label: 'B', value: 2 }], 'y');
    await expect(first).resolves.toBeNull();
    await tick();
    expect(document.querySelector<HTMLInputElement>('.pal input')!.placeholder).toBe('y');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(second).resolves.toBeNull();
  });
});

describe('confirm dialog', () => {
  it('splits the message into title and body, OK resolves true', async () => {
    const p = confirmDialog('Delete x?\nIts content is not in git.');
    await tick();
    expect(document.querySelector('.dialog-title')!.textContent).toBe('Delete x?');
    expect(document.querySelector('.dialog-body')!.textContent).toBe('Its content is not in git.');
    document.querySelector<HTMLButtonElement>('.dialog-actions .btn.primary')!.click();
    await expect(p).resolves.toBe(true);
    await exitTick();
    expect(document.querySelector('.dialog')).toBeNull();
  });

  it('a one-line message has no body, Cancel resolves false', async () => {
    const p = confirmDialog('Discard?');
    await tick();
    expect(document.querySelector('.dialog-title')!.textContent).toBe('Discard?');
    expect(document.querySelector('.dialog-body')).toBeNull();
    document.querySelector<HTMLButtonElement>('.dialog-actions .btn:not(.primary)')!.click();
    await expect(p).resolves.toBe(false);
  });

  it('Escape resolves false', async () => {
    const p = confirmDialog('Discard?');
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBe(false);
  });
});

describe('choice dialog', () => {
  // the live dialog's: the one an answer closed may still be in the DOM, inert, for its exit
  const buttons = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.dialog:not([inert]) .dialog-actions button')];

  it("puts the second answer first, then Cancel and the primary one, focused on Cancel", async () => {
    const p = choiceDialog('Save a.txt?\nYour changes will be lost.', 'Save', "Don't Save");
    await tick();
    expect(buttons().map((b) => b.textContent)).toEqual(["Don't Save", 'Cancel', 'Save']);
    expect(document.activeElement?.textContent).toBe('Cancel');
    buttons()[2]!.click();
    await expect(p).resolves.toBe('ok');
  });

  it("resolves 'alt' for the second answer and null for Cancel and Escape", async () => {
    let p = choiceDialog('Save a.txt?', 'Save', "Don't Save");
    await tick();
    buttons()[0]!.click();
    await expect(p).resolves.toBe('alt');
    // the answered dialog's unmount changes Radix's layer list, and the next dialog reads a stale place in it (so
    // ignores Escape) until Radix has re-rendered it
    await exitTick();
    await tick();

    p = choiceDialog('Save a.txt?', 'Save', "Don't Save");
    await tick();
    buttons()[1]!.click();
    await expect(p).resolves.toBe(null);
    await exitTick();
    await tick();

    p = choiceDialog('Save a.txt?', 'Save', "Don't Save");
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBe(null);
  });

  it('is cancelled by a dialog that replaces it', async () => {
    const p = choiceDialog('Save a.txt?', 'Save', "Don't Save");
    const next = confirmDialog('Discard?');
    await expect(p).resolves.toBe(null);
    await tick();
    buttons()[0]!.click();
    await expect(next).resolves.toBe(false);
  });
});

describe('error dialog', () => {
  it('shows the failure with no Cancel, and Close resolves it', async () => {
    const p = errorDialog('Push failed\nrejected: non-fast-forward');
    await tick();
    expect(document.querySelector('.dialog.error')).not.toBeNull();
    expect(document.querySelector('.dialog-title')!.textContent).toBe('Push failed');
    expect(document.querySelector('.dialog-body')!.textContent).toBe('rejected: non-fast-forward');
    expect(document.querySelector('.dialog-actions .btn:not(.primary):not(.copy)')).toBeNull();
    expect(document.querySelector('.ai-hint')).toBeNull();
    const close = document.querySelector<HTMLButtonElement>('.dialog-actions .btn.primary')!;
    expect(close.textContent).toBe('Close');
    expect(document.activeElement).toBe(close);
    close.click();
    await expect(p).resolves.toBeUndefined();
    await exitTick();
    expect(document.querySelector('.dialog')).toBeNull();
  });

  it('Copy puts the title and the whole log on the clipboard, and a failure shows as a toast', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const message = 'Commit failed\n✖ oxlint:\n  2 errors\nhusky - pre-commit script failed (code 1)';
    void errorDialog(message);
    await tick();
    const copy = document.querySelector<HTMLButtonElement>('.dialog-actions .copy')!;
    expect(copy.textContent).toBe('Copy');
    copy.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith(message);
    expect(copy.textContent).toBe('Copied');
    expect(document.querySelector('.dialog [role="status"]')!.textContent).toBe('Copied to the clipboard');

    writeText.mockRejectedValueOnce(new Error('denied'));
    copy.click();
    await tick();
    expect(copy.textContent).toBe('Copy');
    expect(S.toasts.map((t) => [t.message, t.kind])).toEqual([['Could not copy the error: Error: denied', 'err']]);
  });

  it('shows the AI reading the log, then its answer above the log, which Copy takes too', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let answer!: (hint: { tldr: string; fix: string }) => void;
    void errorDialog('Push failed\nrejected\nhint: pull first', () => new Promise((r) => { answer = r; }));
    await tick();
    const hint = document.querySelector('.ai-hint')!;
    expect(hint.querySelector('.ai-hint-phrase')!.textContent).toBe('Reading the log…');
    expect(hint.getAttribute('aria-busy')).toBe('true');
    document.querySelector<HTMLButtonElement>('.dialog-actions .copy')!.click();
    await tick();
    expect(writeText).toHaveBeenLastCalledWith('Push failed\nrejected\nhint: pull first');

    answer({ tldr: 'The remote has new commits.', fix: 'Pull, then push again.' });
    await tick();
    expect(document.querySelector('.ai-hint-busy')).toBeNull();
    expect(hint.getAttribute('aria-busy')).toBe('false');
    expect([...document.querySelectorAll('.ai-hint :is(dt, dd)')].map((d) => d.textContent))
      .toEqual(['TL;DR', 'The remote has new commits.', 'Fix', 'Pull, then push again.']);
    expect(hint.nextElementSibling!.className).toBe('dialog-body');
    document.querySelector<HTMLButtonElement>('.dialog-actions .copy')!.click();
    await tick();
    expect(writeText).toHaveBeenLastCalledWith('Push failed\n\nTL;DR: The remote has new commits.\n'
      + 'Fix: Pull, then push again.\n\nrejected\nhint: pull first');
  });

  it('steps through what the AI does while it reads, and stays on the last step', async () => {
    // only the phrase timer is faked: React's scheduler and the frames exitTick waits on stay real
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wait = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await exitTick(); };
    try {
      void errorDialog('Push failed\nrejected', () => new Promise(() => {}));
      await wait(0);
      const phrase = () => document.querySelector('.ai-hint-phrase')!.textContent;
      expect(phrase()).toBe('Reading the log…');
      await wait(1600);
      expect(phrase()).toBe('Finding what failed…');
      for (let i = 0; i < 5; i++) await wait(1600);
      expect(phrase()).toBe('Writing a fix…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why the AI gave no answer, with the last line of a long reason', async () => {
    void errorDialog('Push failed\nrejected',
      () => Promise.reject({ kind: 'Ai', detail: 'reading the log\nthinking\nerror: the model is overloaded\n' }));
    await tick();
    expect(document.querySelector('.ai-hint-failed')!.textContent)
      .toBe('No AI summary: error: the model is overloaded');
  });

  it('drops an answer that comes after another dialog took its place', async () => {
    let answer!: (hint: { tldr: string; fix: string }) => void;
    void errorDialog('Commit failed\nhook failed', () => new Promise((r) => { answer = r; }));
    const first = S.confirm!;
    void errorDialog('Pull failed\nconflict');
    answer({ tldr: 'late', fix: 'late' });
    await tick();
    expect(first.hint).toEqual({ state: 'busy' });
    expect(S.confirm!.hint).toBeUndefined();
    expect(document.querySelector('.ai-hint')).toBeNull();
  });

  it('a question has no Copy', async () => {
    void confirmDialog('Discard all changes?');
    await tick();
    expect(document.querySelector('.dialog-actions .copy')).toBeNull();
  });
});

describe('prompt dialog', () => {
  it('Create resolves the trimmed value and an empty one cannot be submitted', async () => {
    const p = promptDialog('New branch name');
    await tick();
    const input = document.querySelector<HTMLInputElement>('.dialog.prompt input')!;
    expect(input.placeholder).toBe('New branch name');
    const create = () => document.querySelector<HTMLButtonElement>('.prompt .btn.primary')!;
    expect(create().disabled).toBe(true);
    setValue(input, '  feat/x  ');
    await tick();
    create().click();
    await expect(p).resolves.toBe('feat/x');
    await exitTick();
    expect(document.querySelector('.prompt')).toBeNull();
  });

  it('Escape resolves null', async () => {
    const p = promptDialog('New branch name');
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBeNull();
  });
});

describe('keyboard while an overlay is open', () => {
  it('dispatch ignores actions until the overlay closes', async () => {
    const p = confirmDialog('Discard?');
    await tick();
    run('app.toggleSidebar');
    expect(S.sidebarHidden).toBe(false);
    document.querySelector<HTMLButtonElement>('.dialog-actions .btn:not(.primary)')!.click();
    await p;
    run('app.toggleSidebar');
    expect(S.sidebarHidden).toBe(true);
    S.sidebarHidden = false;
    localStorage.removeItem('codebaer.sidebarHidden');
  });
});

describe('toasts and chord hint', () => {
  it('toast renders with its kind, click removes it', async () => {
    toast('Committed', 'ok');
    await tick();
    const el = document.querySelector<HTMLElement>('.toasts .toast.ok')!;
    expect(el.textContent).toBe('Committed');
    el.click();
    await exitTick();
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('the chord hint follows S.chord', async () => {
    expect(document.querySelector('.chord')).toBeNull();
    S.chord = true;
    (await import('#kernel/store')).notify();
    await tick();
    expect(document.querySelector('.chord')!.textContent)
      .toBe('⌘K, then ⌘⌥S stage · ⌘R revert · ⌘N unstage · ⌘⌥C comment');
  });
});
