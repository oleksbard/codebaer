import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { setValue, tick } from '#test-setup';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});

const { S } = await import('#kernel/store');
const { pick } = await import('#kernel/pick');
const { confirmDialog, errorDialog, promptDialog, toast } = await import('#kernel/dialogs');
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
    await tick();
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

describe('error dialog', () => {
  it('shows the failure with no Cancel, and Close resolves it', async () => {
    const p = errorDialog('Push failed\nrejected: non-fast-forward');
    await tick();
    expect(document.querySelector('.dialog.error')).not.toBeNull();
    expect(document.querySelector('.dialog-title')!.textContent).toBe('Push failed');
    expect(document.querySelector('.dialog-body')!.textContent).toBe('rejected: non-fast-forward');
    expect(document.querySelector('.dialog-actions .btn:not(.primary)')).toBeNull();
    const close = document.querySelector<HTMLButtonElement>('.dialog-actions .btn.primary')!;
    expect(close.textContent).toBe('Close');
    close.click();
    await expect(p).resolves.toBeUndefined();
    await tick();
    expect(document.querySelector('.dialog')).toBeNull();
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
    await tick();
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
    await tick();
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
