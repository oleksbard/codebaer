import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Blob, FileText, Status } from '#ipc/git';
import type { Info } from '#ipc/terminal';
import { foldEffect, foldedRanges, unfoldAll } from '@codemirror/language';
import { mountApp } from '#test-app';
import { setValue, tick } from '#test-setup';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn() };
});
vi.mock('#kernel/pick', async () => {
  const actual = await vi.importActual<typeof import('#kernel/pick')>('#kernel/pick');
  return { ...actual, pick: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn(), input: vi.fn() };
});
// the terminal view mounts xterm when a send switches to it; none of that is under test here
vi.mock('#features/terminals', async () => ({
  ...(await vi.importActual<object>('#features/terminals')),
  Terminals: () => null,
}));

const { git } = await import('#ipc/git');
const { confirmDialog } = await import('#kernel/dialogs');
const { pick } = await import('#kernel/pick');
const term = await import('#ipc/terminal');
const g = git as unknown as Record<string, ReturnType<typeof vi.fn<(...args: never[]) => Promise<unknown>>>>;
const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;
const pickMock = pick as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
const inputMock = term.input as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

let m: typeof import('./actions');
let clipboard: typeof import('#kernel/clipboard');
let core: typeof import('#core/session');
let S: typeof import('#kernel/store').S;
let notify: typeof import('#kernel/store').notify;

const ROOT = '/Users/me/r';
const INDEX = 'one\ntwo\nthree\nfour\n';
const DISK = 'one\nTWO\nthree\nfour\n';
const blob = (text: string): Blob => ({ text, eol: 'lf', oid: 'oid1', exists: true });
const file = (text: string): FileText => ({ text, eol: 'lf', exists: true });
const status = (): Status => ({
  head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0,
  files: [{ path: 'a.ts', indexStatus: '.', worktreeStatus: 'M', untracked: false, conflicted: false }],
});
const session = (id: number, title: string, cwd = ROOT): Info =>
  ({ id, title, cwd, tier: 'marks', state: { t: 'Idle' } });

beforeAll(async () => {
  await mountApp();
  m = await import('./actions');
  clipboard = await import('#kernel/clipboard');
  core = await import('#core/session');
  ({ S, notify } = await import('#kernel/store'));
});

beforeEach(async () => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(true);
  pickMock.mockReset();
  inputMock.mockReset().mockResolvedValue(undefined);
  S.tab = 'changes';
  S.root = ROOT;
  S.comments = [];
  S.draft = null;
  S.lastTarget = null;
  S.toasts = [];
  S.flushing = null;
  S.terminals = [session(1, 'zsh'), session(2, 'claude'), session(3, 'claude', '/Users/me/other')];
  S.status = status();
  g.readBlob!.mockResolvedValue(blob(INDEX));
  g.readFile!.mockResolvedValue(file(DISK));
  g.status!.mockResolvedValue(S.status);
  await core.openRow({ section: 'unstaged', path: 'a.ts', letter: 'M', untracked: false, conflicted: false });
  await tick();
});

const select = (fromLine: number, toLine: number) => {
  const doc = core.view.state.doc;
  core.view.dispatch({ selection: { anchor: doc.line(fromLine).from, head: doc.line(toLine).to } });
};

const box = () => document.querySelector<HTMLTextAreaElement>('.comment-box textarea');

async function comment(fromLine: number, toLine: number, text: string): Promise<void> {
  select(fromLine, toLine);
  m.startComment();
  await tick();
  setValue(box()!, text);
  box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await tick();
}

describe('writing comments', () => {
  it('opens a box under the selection with a diff quote; Add folds it into a card and the pending pill', async () => {
    select(2, 3);
    m.startComment();
    await tick();
    expect(document.activeElement).toBe(box());
    expect(document.querySelector('.comment-head')!.textContent).toBe('Comment on a.ts:2-3');

    setValue(box()!, 'Why uppercase?');
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await tick();

    expect(box()).toBeNull();
    expect(S.comments).toMatchObject([{ path: 'a.ts', side: 'work', from: 2, to: 3, text: 'Why uppercase?',
      quote: { t: 'diff', text: '-two\n+TWO\n three' } }]);
    expect(document.querySelector('.comment-card .txt')!.textContent).toBe('Why uppercase?');
    expect(document.querySelector('.pill.pending')!.textContent).toBe('✎ 1 pending ▾');
  });

  it('keeps a comment on its lines when a refresh rewrites the file above it', async () => {
    await comment(4, 4, 'Rename four.');
    g.readFile!.mockResolvedValue(file('zero\none\nTWO\nthree\nfour\n'));
    await core.refresh();
    expect(S.comments[0]).toMatchObject({ from: 5, to: 5, moved: false });
  });

  it('marks a comment moved when its lines are gone, and a jump puts it back at its old lines', async () => {
    await comment(4, 4, 'Rename four.');
    g.readFile!.mockResolvedValue(file('one\nTWO\nthree\n'));
    await core.refresh();
    expect(S.comments[0]!.moved).toBe(true);
    expect(document.querySelector('.comment-card')).toBeNull();

    await m.jumpToComment(S.comments[0]!.id);
    await tick();
    expect(S.comments[0]).toMatchObject({ from: 4, to: 4, moved: false });
    expect(document.querySelector('.comment-card')).not.toBeNull();
  });

  it('asks before Escape throws away a comment that has text', async () => {
    select(1, 1);
    m.startComment();
    await tick();
    setValue(box()!, 'half a thought');
    confirmMock.mockResolvedValue(false);
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(confirmMock).toHaveBeenCalledWith('Discard this comment?');
    expect(S.draft?.text).toBe('half a thought');
  });
});

describe('editing and showing comments', () => {
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.comment-actions button')].find((b) => b.textContent === label)!;

  it('saves an edit from the card, and deletes from the edit box', async () => {
    await comment(1, 1, 'Old.');
    const id = S.comments[0]!.id;
    document.querySelector<HTMLButtonElement>('.comment-open')!.click();
    await tick();
    expect(box()!.value).toBe('Old.');
    setValue(box()!, 'New.');
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await tick();
    expect(S.comments).toMatchObject([{ id, text: 'New.', from: 1 }]);

    m.editComment(id);
    await tick();
    button('Delete').click();
    await tick();
    expect(S.comments).toEqual([]);
    expect(S.draft).toBeNull();
    expect(document.querySelector('.comment-box, .comment-card')).toBeNull();
  });

  it('moves a card being edited with the refresh, so Cancel puts it back on its own line', async () => {
    await comment(4, 4, 'Rename four.');
    const id = S.comments[0]!.id;
    m.editComment(id);
    await tick();
    g.readFile!.mockResolvedValue(file('zero\none\nTWO\nthree\nfour\n'));
    await core.refresh();
    await m.cancelDraft();
    await tick();
    expect(S.comments[0]).toMatchObject({ from: 5, to: 5, anchor: 'four', text: 'Rename four.' });
    expect(document.querySelector('.comment-card')).not.toBeNull();
  });

  it('keeps focus in the box when a refresh rewrites the file under it', async () => {
    select(4, 4);
    m.startComment();
    await tick();
    expect(document.activeElement).toBe(box());
    g.readFile!.mockResolvedValue(file('zero\none\nTWO\nthree\nfour\n'));
    await core.refresh();
    expect(document.activeElement).toBe(box());
  });

  it('keeps an edited card moved when its lines leave the file, instead of binding it to other text', async () => {
    await comment(4, 4, 'Rename four.');
    const id = S.comments[0]!.id;
    m.editComment(id);
    await tick();
    g.readFile!.mockResolvedValue(file('one\nTWO\nsomething else\n'));
    await core.refresh();
    setValue(box()!, 'Rename four, wherever it went.');
    m.saveDraft();
    expect(S.comments[0]).toMatchObject({ id, moved: true, anchor: 'four', text: 'Rename four, wherever it went.' });
    expect(S.toasts.at(-1)!.message).toContain('moved');
  });

  it('refuses to send while an edited card is blank, and to start a comment from the Terminals tab', async () => {
    await comment(1, 1, 'Keep.');
    m.editComment(S.comments[0]!.id);
    await tick();
    setValue(box()!, '  ');
    await m.sendComments();
    expect(pickMock).not.toHaveBeenCalled();
    expect(S.comments[0]!.text).toBe('Keep.');
    await m.cancelDraft();

    S.tab = 'terminals';
    select(2, 2);
    m.startComment();
    expect(S.draft).toBeNull();
  });

  it('turns a staged comment into a working-tree one when a jump finds no staged changes', async () => {
    S.comments = [{
      id: 98, path: 'a.ts', side: 'index', from: 3, to: 3, anchor: 'three',
      quote: { t: 'code', lang: 'ts', text: 'three' }, text: 'Was staged.', moved: false,
    }];
    await core.closeFile();
    await m.jumpToComment(98);
    await tick();
    expect(S.open?.view).toBe('plain');
    expect(S.comments[0]).toMatchObject({ side: 'work', from: 3, moved: false });
    expect(document.querySelector('.comment-card .txt')!.textContent).toBe('Was staged.');
  });

  it('puts a card being edited back on its lines after its file was closed and changed', async () => {
    await comment(4, 4, 'Rename four.');
    const id = S.comments[0]!.id;
    m.editComment(id);
    await tick();
    g.readFile!.mockResolvedValueOnce(file('other\n'));
    await core.openPlain('b.ts');
    g.readFile!.mockResolvedValue(file('zero\none\nTWO\nthree\nfour\n'));
    await core.openRow({ section: 'unstaged', path: 'a.ts', letter: 'M', untracked: false, conflicted: false });
    await m.cancelDraft();
    await tick();
    expect(S.comments[0]).toMatchObject({ id, from: 5, to: 5, anchor: 'four', moved: false });
  });

  it('keeps comments unfolded in Changes only, and the box focused through a refresh', async () => {
    const long = (edit: Record<number, string>) =>
      `${Array.from({ length: 40 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;
    S.changesOnly = true;
    S.comments = [{
      id: 97, path: 'a.ts', side: 'work', from: 20, to: 20, anchor: 'line 20',
      quote: { t: 'code', lang: 'ts', text: 'line 20' }, text: 'Far from the hunk.', moved: false,
    }];
    g.readBlob!.mockResolvedValue(blob(long({})));
    g.readFile!.mockResolvedValue(file(long({ 2: 'changed' })));
    await core.openRow({ section: 'unstaged', path: 'a.ts', letter: 'M', untracked: false, conflicted: false });
    await tick();
    const folded = (line: number) => {
      const at = core.view.state.doc.line(line).from;
      let hit = false;
      foldedRanges(core.view.state).between(at, at, () => { hit = true; });
      return hit;
    };
    expect(folded(30)).toBe(true);
    expect(folded(20)).toBe(false);
    expect(document.querySelector('.comment-card .txt')!.textContent).toBe('Far from the hunk.');

    select(2, 2);
    m.startComment();
    await tick();
    setValue(box()!, 'typing');
    g.readFile!.mockResolvedValue(file(long({ 2: 'changed', 35: 'agent wrote this' })));
    await core.refresh();
    await tick();
    expect(document.activeElement).toBe(box());
    expect(box()!.value).toBe('typing');
    S.changesOnly = false;
  });

  it('folds nothing in Changes only for a file with comments but no changes', async () => {
    S.changesOnly = true;
    const long = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
    S.comments = [{
      id: 96, path: 'a.ts', side: 'work', from: 15, to: 15, anchor: 'line 15',
      quote: { t: 'code', lang: 'ts', text: 'line 15' }, text: 'Plain.', moved: false,
    }];
    g.readFile!.mockResolvedValue(file(long));
    await core.openPlain('a.ts');
    await core.refresh();
    let folds = 0;
    foldedRanges(core.view.state).between(0, core.view.state.doc.length, () => { folds++; });
    expect(folds).toBe(0);
    S.changesOnly = false;
  });

  it('does not take focus back from where the owner went while the box was folded away', async () => {
    select(2, 2);
    m.startComment();
    await tick();
    expect(document.activeElement).toBe(box());
    const doc = core.view.state.doc;
    core.view.dispatch({ effects: foldEffect.of({ from: doc.line(1).to, to: doc.line(3).to }) });
    await tick();
    expect(box()).toBeNull();
    const commit = document.querySelector<HTMLTextAreaElement>('#commit-message')!;
    commit.focus();
    unfoldAll(core.view);
    await tick();
    expect(box()).not.toBeNull();
    expect(document.activeElement).toBe(commit);
  });

  it('keeps the caret where it was when a refresh rebuilds the box', async () => {
    const long = (edit: Record<number, string>) =>
      `${Array.from({ length: 40 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;
    S.changesOnly = true;
    g.readBlob!.mockResolvedValue(blob(long({})));
    g.readFile!.mockResolvedValue(file(long({ 2: 'changed' })));
    await core.openRow({ section: 'unstaged', path: 'a.ts', letter: 'M', untracked: false, conflicted: false });
    select(2, 2);
    m.startComment();
    await tick();
    setValue(box()!, 'hello world');
    box()!.setSelectionRange(5, 5);
    // React derives onSelect from the key and mouse events that move a caret, not the native event
    box()!.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    g.readFile!.mockResolvedValue(file(long({ 2: 'changed', 35: 'agent' })));
    await core.refresh();
    await tick();
    expect(document.activeElement).toBe(box());
    expect(box()!.selectionStart).toBe(5);
    S.changesOnly = false;
  });

  it('ignores Send while the box is blank', async () => {
    await comment(1, 1, 'Pending.');
    select(4, 4);
    m.startComment();
    await tick();
    expect(button('Send 2 ⌘⇧↩').disabled).toBe(true);
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true }));
    await tick();
    expect(pickMock).not.toHaveBeenCalled();
    expect(S.draft).not.toBeNull();
  });

  it('shows a staged comment only in the staged view of its file', async () => {
    S.comments = [{
      id: 99, path: 'a.ts', side: 'index', from: 1, to: 1, anchor: 'one',
      quote: { t: 'code', lang: 'ts', text: 'one' }, text: 'Staged note.', moved: false,
    }];
    await core.openRow({ section: 'unstaged', path: 'a.ts', letter: 'M', untracked: false, conflicted: false });
    await tick();
    expect(document.querySelector('.comment-card')).toBeNull();
    await core.openRow({ section: 'staged', path: 'a.ts', letter: 'M', untracked: false, conflicted: false });
    await tick();
    expect(document.querySelector('.comment-card .txt')!.textContent).toBe('Staged note.');
  });

  it('shows the Comment chip for a selection, and hides it while a draft is open anywhere', async () => {
    select(1, 1);
    await tick();
    expect(document.querySelector('.comment-chip')).not.toBeNull();
    S.draft = {
      path: 'b.ts', side: 'work', from: 1, to: 1, anchor: '', quote: { t: 'code', lang: 'ts', text: '' },
      text: 'elsewhere', editing: null, focus: false, caret: null, lost: false,
    };
    notify();
    await tick();
    expect(document.querySelector('.comment-chip')).toBeNull();
  });
});

describe('sending', () => {
  it('offers repo terminals by label, pastes the batch, presses Enter for an agent and switches to it', async () => {
    await comment(1, 1, 'First.');
    await comment(4, 4, 'Second.');
    pickMock.mockResolvedValue(2);

    await m.sendComments();

    const items = pickMock.mock.calls[0]![0] as { label: string; note?: string; value: number }[];
    expect(items.map((i) => [i.label, i.note])).toEqual([['claude:1', undefined]]);
    expect(pickMock.mock.calls[0]![1]).toBe('Send 2 comments to…');
    const [paste, enter] = inputMock.mock.calls;
    expect(paste![0]).toBe(2);
    expect(paste![1]).toBe('\x1b[200~Review comments:\r\r'
      + '1. a.ts:1\r```ts\rone\r```\rFirst.\r\r'
      + '2. a.ts:4\r```ts\rfour\r```\rSecond.\x1b[201~');
    expect(enter).toEqual([2, '\r']);
    expect(S.comments).toEqual([]);
    expect(S.tab).toBe('terminals');
    expect(S.activeTerm).toBe(2);
    expect(S.lastTarget).toBe(2);
    expect(S.toasts.at(-1)).toMatchObject({ message: 'Sent 2 comments to claude:1', kind: 'ok' });
  });

  it('adds the open draft first when sent from its box', async () => {
    select(1, 1);
    m.startComment();
    await tick();
    setValue(box()!, 'Send me now.');
    pickMock.mockResolvedValue(2);
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true }));
    await vi.waitFor(() => expect(S.tab).toBe('terminals'));
    expect(inputMock).toHaveBeenCalledTimes(2);
    expect(inputMock.mock.calls[0]![1]).toContain('Send me now.');
    expect(S.comments).toEqual([]);
  });

  it('puts the last target first on the next send', async () => {
    S.terminals = [session(2, 'claude'), session(5, 'codex')];
    S.lastTarget = 5;
    await comment(1, 1, 'Again.');
    pickMock.mockResolvedValue(null);
    await m.sendComments();
    const items = pickMock.mock.calls[0]![0] as { label: string; note?: string }[];
    expect(items.map((i) => [i.label, i.note])).toEqual([['codex:1', 'last used'], ['claude:1', undefined]]);
    expect(S.comments).toHaveLength(1);
  });

  it('keeps everything pending when the paste fails or no terminal is in the repo', async () => {
    await comment(1, 1, 'Keep me.');
    pickMock.mockResolvedValue(2);
    inputMock.mockRejectedValue({ kind: 'Unknown', detail: 'host gone' });
    await m.sendComments();
    expect(S.comments).toHaveLength(1);
    expect(S.tab).toBe('changes');

    S.terminals = [session(3, 'claude', '/Users/me/other')];
    pickMock.mockClear();
    await m.sendComments();
    expect(pickMock).not.toHaveBeenCalled();
    expect(S.toasts.at(-1)).toMatchObject({ message: 'No claude or codex session is open in this repo.' });
    expect(S.comments).toHaveLength(1);
  });

  it('warns when the paste landed but Enter could not be pressed', async () => {
    await comment(1, 1, 'Half sent.');
    pickMock.mockResolvedValue(2);
    inputMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce({ kind: 'Unknown', detail: 'gone' });
    await m.sendComments();
    expect(S.comments).toEqual([]);
    expect(S.toasts.at(-1)).toMatchObject({ message: 'Pasted into claude:1 but could not press Enter', kind: 'warn' });
  });

  it('does not press Enter when the agent quit between the paste and the Enter', async () => {
    S.terminals = [{ ...session(4, 'zsh'), state: { t: 'Running', command: 'claude', since_ms: 0 } }];
    await comment(1, 1, 'Quick.');
    pickMock.mockResolvedValue(4);
    // quits after the paste has gone out, inside the wait before Enter
    inputMock.mockImplementationOnce(() => {
      setTimeout(() => { S.terminals = [session(4, 'zsh')]; }, 40);
      return Promise.resolve();
    });
    await m.sendComments();
    expect(inputMock).toHaveBeenCalledOnce();
    expect(S.toasts.at(-1)).toMatchObject({ kind: 'warn' });
  });

  it('sends nothing while the open file cannot be saved', async () => {
    await comment(1, 1, 'Needs the disk.');
    core.view.dispatch({ changes: { from: 0, insert: 'x' } });
    clearTimeout(S.saveTimer);
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });
    await m.sendComments();
    expect(pickMock).not.toHaveBeenCalled();
    expect(S.comments).toHaveLength(1);
    expect(S.toasts.at(-1)).toMatchObject({ kind: 'warn' });
    S.open!.dirty = false;
    S.open!.badge = null;
  });

  it('refuses a target that closed while the picker was open', async () => {
    await comment(1, 1, 'Late.');
    pickMock.mockImplementation(() => {
      S.terminals = S.terminals.filter((s) => s.id !== 2);
      return Promise.resolve(2);
    });
    await m.sendComments();
    expect(inputMock).not.toHaveBeenCalled();
    expect(S.comments).toHaveLength(1);
  });
});

describe('repo switch and copy path', () => {
  it('asks before a repo switch drops pending comments', async () => {
    await comment(1, 1, 'Pending.');
    confirmMock.mockResolvedValue(false);
    await core.openRepo('/Users/me/other');
    expect(confirmMock).toHaveBeenCalledWith('Discard 1 pending comment?');
    expect(g.openRepo).not.toHaveBeenCalled();
    expect(S.comments).toHaveLength(1);

    confirmMock.mockResolvedValue(true);
    vi.mocked(term.checkCwd).mockResolvedValue(undefined);
    g.openRepo!.mockResolvedValue({ root: ROOT, label: '~/r', title: 'r' });
    await core.openRepo(ROOT);
    expect(S.comments).toEqual([]);
    expect(S.draft).toBeNull();
  });

  it('copies a path to the clipboard and says so, or says why not', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await clipboard.copyPath('src/a.ts');
    expect(writeText).toHaveBeenCalledWith('src/a.ts');
    expect(S.toasts.at(-1)).toMatchObject({ message: 'Copied src/a.ts', kind: 'ok' });

    writeText.mockRejectedValue(new Error('denied'));
    await clipboard.copyPath('src/a.ts');
    expect(S.toasts.at(-1)).toMatchObject({ kind: 'err' });
  });
});
