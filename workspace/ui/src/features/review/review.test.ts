import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPlain, openRow, refresh, view } from '#core/session';
import { getOriginalDoc } from '#editor/editor';
import { isSideBySide } from '#editor/side-by-side';
import type { BlameLine, Blob, Status } from '#ipc/git';
import { confirmDialog } from '#kernel/dialogs';
import { S } from '#kernel/store';
import { blob, file, g, headerItem, mountApp, openUnstaged, status, type } from '#test-app';
import { tick } from '#test-setup';
import { accept, acceptFile, discardAll, reject, rejectFile, unstageHunk } from './hunks';
import { applyDiffLayout } from './index';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
});

describe('the two special reject cases', () => {
  it('a deleted file is restored with revert_path, without a write and without a confirmation', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('', false));
    expect(S.open!.baseline).toBe(null);

    await reject();

    expect(g.revertPath!).toHaveBeenCalledWith('a.txt');
    expect(g.writeFile!).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('a deleted file with unsaved text asks first, since the restore drops the text', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('', false));
    type('typed\n');

    await reject();

    expect(confirmMock).toHaveBeenCalledWith('Restore a.txt?\nYour unsaved changes to a.txt are discarded too.');
    expect(g.revertPath!).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('typed\n');
  });

  it('a file with no index entry confirms first and calls nothing when the answer is no', async () => {
    await openUnstaged('n.txt', blob('', null), file('new\n'));
    expect(S.open!.originalExists).toBe(false);

    await reject();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(g.revertPath!).not.toHaveBeenCalled();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});

describe('whole-file actions on a file with unsaved changes', () => {
  beforeEach(async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
  });

  it('Accept file saves it first and stages only after the write', async () => {
    const order: string[] = [];
    g.writeFile!.mockImplementation(async () => { order.push('write'); });
    g.stagePath!.mockImplementation(async () => { order.push('stage'); });

    await acceptFile('a.txt');

    expect(order).toEqual(['write', 'stage']);
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.open!.dirty).toBe(false);
  });

  it('Accept file stages nothing when that save comes back Stale', async () => {
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });

    await acceptFile('a.txt');

    expect(g.stagePath!).not.toHaveBeenCalled();
    expect(S.open!.dirty).toBe(true);
    expect(S.open!.badge).toEqual(file('agent\n'));
  });

  it('Accept file on another file leaves this one unsaved', async () => {
    await acceptFile('b.txt');
    expect(g.stagePath!).toHaveBeenCalledWith('b.txt');
    expect(g.writeFile!).not.toHaveBeenCalled();
    expect(S.open!.dirty).toBe(true);
  });

  it('Reject file says the unsaved changes go too, and drops them without writing', async () => {
    confirmMock.mockResolvedValue(true);
    g.readFile!.mockResolvedValue(file('disk\n'));

    await rejectFile('a.txt');

    expect(confirmMock).toHaveBeenCalledWith('Discard unstaged changes in a.txt?\nAccepted hunks stay staged.'
      + '\nYour unsaved changes to a.txt are discarded too.');
    expect(g.revertPath!).toHaveBeenCalledWith('a.txt');
    expect(g.writeFile!).not.toHaveBeenCalled();
    expect(S.open!.dirty).toBe(false);
  });

  it('Discard all keeps them when the answer is no', async () => {
    await discardAll();

    expect(confirmMock.mock.calls[0]![0]).toContain('Your unsaved changes to a.txt are discarded too.');
    expect(g.discardAll!).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('mine\n');
    expect(S.open!.dirty).toBe(true);
  });
});

describe('discard all', () => {
  const files = (...entries: Status['files']) => ({ ...status('a.txt'), files: entries });

  it('counts untracked files with the rest and warns that they are gone for good, without listing them', async () => {
    S.status = files(...status('a.txt').files, ...status('b.txt').files, ...status('new.txt', '.', '.', true).files);
    confirmMock.mockResolvedValue(true);

    await discardAll();

    expect(confirmMock).toHaveBeenCalledWith('Discard unstaged changes in 3 files?\nAccepted hunks stay staged.'
      + '\n1 untracked file is deleted and cannot be recovered.');
    expect(g.discardAll!).toHaveBeenCalledTimes(1);
  });

  it('says nothing about untracked files when there are none, and does nothing when nothing is left', async () => {
    await discardAll();
    expect(confirmMock).toHaveBeenCalledWith('Discard unstaged changes in 1 file?\nAccepted hunks stay staged.');
    expect(g.discardAll!).not.toHaveBeenCalled();

    confirmMock.mockClear();
    S.status = files();
    await discardAll();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe('section header menus', () => {
  const headerButtons = (sec: 'unstaged' | 'staged') =>
    document.querySelectorAll(`details[data-sec="${sec}"] summary [data-all]`).length;

  it('Stage all runs stage_all; the Staged header offers nothing while nothing is staged', async () => {
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();
    expect(headerButtons('staged')).toBe(0);
    const stageAll = await headerItem('unstaged', 'stage');

    stageAll.click();

    await vi.waitFor(() => expect(g.stageAll!).toHaveBeenCalledTimes(1));
    expect(g.unstageAll!).not.toHaveBeenCalled();
  });

  it('Unstage all runs unstage_all once something is staged, and the Changes header then offers nothing', async () => {
    S.status = status('a.txt', 'M', '.');
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();
    expect(headerButtons('unstaged')).toBe(0);
    const unstageAll = await headerItem('staged', 'unstage');

    unstageAll.click();

    await vi.waitFor(() => expect(g.unstageAll!).toHaveBeenCalledTimes(1));
    expect(g.stageAll!).not.toHaveBeenCalled();
  });

  it('Enter on a focused header menu button does not also activate the selected row', async () => {
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();
    const row = document.querySelector<HTMLElement>('.row')!;
    row.click();
    await vi.waitFor(() => expect(S.open?.path).toBe('a.txt'));
    g.readBlob!.mockClear();
    const menu = document.querySelector<HTMLButtonElement>('details[data-sec="unstaged"] [data-all="menu"]')!;

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();

    expect(g.readBlob!).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
  });
});

describe('the blank panel', () => {
  it('offers whole-file actions for a staged or unstaged panel and none in the plain view', async () => {
    const { notify } = await import('#kernel/store');
    S.open = {
      path: 'logo.png', view: 'plain', eol: 'lf', baseline: null, originalOid: null,
      originalExists: false, docOid: null, dirty: false, badge: null, panel: 'Binary', conflicted: false,
    };
    notify();
    await tick();
    expect(document.querySelector('.blank h2')!.textContent).toBe('binary file');
    expect(document.querySelector('.blank p')).toBeNull();

    S.open = { ...S.open, view: 'unstaged' };
    notify();
    await tick();
    expect([...document.querySelectorAll('.blank p')].map((p) => p.textContent))
      .toEqual(['Whole-file actions only.', 'Reject file Accept file']);
  });
});

describe('the title bar', () => {
  const pillButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.tbar .pill.warn button')];

  it('shows the changed-on-disk pill, reloads from disk, and writes the buffer on Keep mine', async () => {
    const { notify } = await import('#kernel/store');
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    S.open!.badge = file('agent\n');
    notify();
    await tick();
    expect(document.querySelector('.tbar .pill.warn')!.textContent).toBe('changed on diskReloadKeep mine');

    g.readFile!.mockResolvedValue(file('agent\n'));
    pillButtons()[0]!.click();
    await vi.waitFor(() => expect(g.readFile!).toHaveBeenCalledWith('a.txt'));
    expect(S.open!.badge).toBe(null);

    type('ours\n');
    S.open!.badge = file('agent\n');
    notify();
    await tick();
    pillButtons()[1]!.click();

    await vi.waitFor(() => expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'ours\n', 'lf', 'agent\n'));
    expect(S.open!.badge).toBe(null);
  });

  it('counts the hunks and offers Reject file and Accept file for an unstaged record', async () => {
    await openUnstaged('a.txt', blob('a\nb\nc\nd\ne\nf\ng\n'), file('A\nb\nc\nd\ne\nf\nG\n'));
    await tick();
    expect(document.querySelector('.tbar .pos')!.textContent).toBe('hunk 1 of 2');
    const btns = [...document.querySelectorAll<HTMLButtonElement>('.tbar .right .btn')];
    expect(btns.map((b) => b.textContent)).toEqual(['Reject file ⌘⇧N', 'Accept file ⌘⇧Y']);

    btns[1]!.click();
    await vi.waitFor(() => expect(g.stagePath!).toHaveBeenCalledExactlyOnceWith('a.txt'));
    expect(g.stageContent!).not.toHaveBeenCalled();

    confirmMock.mockResolvedValue(true);
    btns[0]!.click();
    await vi.waitFor(() => expect(g.revertPath!).toHaveBeenCalledExactlyOnceWith('a.txt'));
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});

describe('accept moves on to the next change', () => {
  const INDEX = 'a\nb\nc\nd\ne\nf\ng\n';
  const line = (): number => view.state.doc.lineAt(view.state.selection.main.head).number;

  beforeEach(() => {
    g.stageContent!.mockResolvedValue({ oid: 'oid2' });
  });

  it('scrolls to the next hunk while this file still has one', async () => {
    await openUnstaged('a.txt', blob(INDEX), file('A\nb\nc\nd\ne\nf\nG\n'));
    g.status!.mockResolvedValue(S.status);
    // the refresh after a stage re-reads the index, so it has to hold the accepted hunk
    g.readBlob!.mockResolvedValue(blob('A\nb\nc\nd\ne\nf\ng\n', 'oid2'));
    expect(line()).toBe(1);

    await accept();
    await tick();

    expect(line()).toBe(7);
  });

  it('opens the next file with changes once this one has none left', async () => {
    await openUnstaged('a.txt', blob(INDEX), file('A\nb\nc\nd\ne\nf\ng\n'));
    g.status!.mockResolvedValue(status('b.txt'));
    g.readBlob!.mockResolvedValue(blob('A\nb\nc\nd\ne\nf\ng\n', 'oid2'));

    await accept();
    await tick();
    await tick();

    expect(S.open?.path).toBe('b.txt');
  });
});

describe('accepting the whole file', () => {
  const three = (): Status => ({ ...status('a.txt'), files: ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
    path, indexStatus: '.', worktreeStatus: 'M', untracked: false, conflicted: false,
  })) });

  const left = (accepted: string): Status => ({ ...three(), files: three().files.filter((f) => f.path !== accepted) });

  it.each([
    ['a.txt', 'b.txt'],
    ['b.txt', 'a.txt'],
    ['c.txt', 'a.txt'],
  ])('opens the first file left in the queue after accepting %s, as accepting its last hunk does',
    async (accepted, next) => {
      S.status = three();
      await openUnstaged(accepted, blob('a\n'), file('A\n'));
      g.status!.mockResolvedValue(left(accepted));

      await acceptFile(accepted);

      expect(g.stagePath!).toHaveBeenCalledExactlyOnceWith(accepted);
      expect(S.open?.path).toBe(next);
    });

  it('moves on the same way while the refresh after the stage is still reading the status', async () => {
    S.status = three();
    await openUnstaged('a.txt', blob('a\n'), file('A\n'));
    let answer!: (s: Status) => void;
    g.status!.mockReturnValue(new Promise<Status>((done) => { answer = done; }));

    await acceptFile('a.txt');
    expect(S.open?.path).toBe('b.txt');

    answer(left('a.txt'));
    await tick();
    expect(S.open?.path).toBe('b.txt');
  });

  it('keeps a conflict marked resolved open', async () => {
    S.status = { ...three(), files: [{ ...three().files[0]!, indexStatus: 'U', worktreeStatus: 'U', conflicted: true },
      ...three().files.slice(1)] };
    g.status!.mockResolvedValue(S.status);
    g.readFile!.mockResolvedValue(file('resolved\n'));
    await openRow({ section: 'unstaged', path: 'a.txt', letter: '!', untracked: false, conflicted: true });
    expect(S.open?.conflicted).toBe(true);

    await acceptFile('a.txt');

    expect(g.stagePath!).toHaveBeenCalledWith('a.txt');
    expect(S.open?.path).toBe('a.txt');
  });

  it('stays on the file when git refuses the stage, or when no other file is left', async () => {
    await openUnstaged('a.txt', blob('a\n'), file('A\n'));
    g.stagePath!.mockRejectedValueOnce({ kind: 'Git', detail: 'index.lock exists' });
    await acceptFile('a.txt');
    expect(S.open?.path).toBe('a.txt');

    await acceptFile('a.txt');
    expect(g.stagePath!).toHaveBeenCalledTimes(2);
    expect(S.open?.path).toBe('a.txt');
    expect(S.toasts.at(-1)?.message).toBe('Nothing left to review');
  });

  it('keeps a file opened from the Files tab open', async () => {
    g.readFile!.mockResolvedValue(file('A\n'));
    await openPlain('a.txt');
    g.status!.mockResolvedValue(status('b.txt'));

    await acceptFile('a.txt');
    await tick();

    expect(g.stagePath!).toHaveBeenCalledWith('a.txt');
    expect(S.open?.path).toBe('a.txt');
    expect(S.open?.view).toBe('plain');
  });
});

describe('a hunk action on a file left while it ran', () => {
  it('leaves the file opened meanwhile alone when staging fails', async () => {
    await openUnstaged('a.txt', blob('a\n'), file('A\n'));
    let index!: (b: Blob) => void;
    g.stageContent!.mockRejectedValue({ kind: 'StaleIndex' });
    g.readBlob!.mockImplementation((_rev: unknown, path: unknown) => (path === 'a.txt'
      ? new Promise<Blob>((done) => { index = done; })
      : Promise.resolve(blob('b index\n', 'oidB'))));
    g.readFile!.mockResolvedValue(file('b disk\n'));
    g.status!.mockResolvedValue(status('b.txt'));

    const accepting = accept();
    await tick();
    await openRow({ section: 'unstaged', path: 'b.txt', letter: 'M', untracked: false, conflicted: false });
    index(blob('a staged\n', 'oidA2'));
    await accepting;

    expect(S.open?.path).toBe('b.txt');
    expect(getOriginalDoc(view.state).toString()).toBe('b index\n');
  });

  it('leaves the file opened meanwhile alone when unstaging fails', async () => {
    g.readBlob!.mockImplementation((rev: unknown) =>
      Promise.resolve(rev === 'head' ? blob('a\n') : blob('A\n', 'oidA')));
    await openRow({ section: 'staged', path: 'a.txt', letter: 'M', untracked: false, conflicted: false });
    let index!: (b: Blob) => void;
    g.stageContent!.mockRejectedValue({ kind: 'StaleIndex' });
    g.readBlob!.mockImplementation((rev: unknown, path: unknown) => (path === 'a.txt'
      ? new Promise<Blob>((done) => { index = done; })
      : Promise.resolve(blob(rev === 'head' ? 'b head\n' : 'b index\n', 'oidB'))));
    g.status!.mockResolvedValue(status('b.txt', 'M', '.'));

    const unstaging = unstageHunk();
    await tick();
    await openRow({ section: 'staged', path: 'b.txt', letter: 'M', untracked: false, conflicted: false });
    index(blob('A again\n', 'oidA2'));
    await unstaging;

    expect(S.open?.path).toBe('b.txt');
    expect(view.state.doc.toString()).toBe('b index\n');
  });
});

describe('the inline hunk buttons act on their own chunk', () => {
  it('accepts the second chunk when the second chunk button is clicked', async () => {
    await openUnstaged('a.txt', blob('a\nb\nc\nd\ne\nf\ng\n'), file('A\nb\nc\nd\ne\nf\nG\n'));
    g.stageContent!.mockResolvedValue({ oid: 'oid2' });
    g.status!.mockResolvedValue(S.status);
    g.readBlob!.mockResolvedValue(blob('a\nb\nc\nd\ne\nf\nG\n', 'oid2'));

    const widgets = view.dom.querySelectorAll('.cm-deletedChunk');
    expect(widgets).toHaveLength(2);
    widgets[1]!.querySelector<HTMLButtonElement>('button[name=accept]')!.click();
    await tick();

    // the cursor opens on chunk one, so a button that fails to move it stages 'A\n...\ng\n' instead
    expect(g.stageContent!.mock.calls[0]?.[1]).toBe('a\nb\nc\nd\ne\nf\nG\n');
  });
});

describe('side by side', () => {
  const host = (): Element => document.querySelector('.editor-host')!;
  const toggle = (): HTMLButtonElement | null => document.querySelector('.tbar [aria-label="Side by side"]');
  const sides = (): string[] =>
    [...host().children].map((c) => (c.classList.contains('cm-merge-a') ? 'left' : 'right'));
  afterEach(() => {
    S.settings = { ...S.settings, 'appearance.diff-layout': 'unified' };
    applyDiffLayout();
  });

  it('the file bar button switches the unstaged view, saves the choice, and keeps it for the next file', async () => {
    await openUnstaged('a.txt', blob('a\nb\nc\n'), file('a\nB\nc\n'));
    await tick();
    expect(sides()).toEqual(['right']);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');

    toggle()!.click();
    await tick();
    expect(g.saveSettings!)
      .toHaveBeenLastCalledWith(expect.objectContaining({ 'appearance.diff-layout': 'side-by-side' }));
    expect(host().classList.contains('split')).toBe(true);
    expect(sides()).toEqual(['left', 'right']);
    expect(host().querySelector('.cm-merge-a .cm-changedLine')!.textContent).toBe('b');
    // the lines it took out show on the left, not inline
    expect(view.dom.classList.contains('cm-side')).toBe(true);

    await openUnstaged('b.txt', blob('x\n'), file('y\n'));
    await tick();
    expect(isSideBySide(view)).toBe(true);
    expect(host().querySelector('.cm-merge-a')!.textContent).toContain('x');

    toggle()!.click();
    await tick();
    expect(g.saveSettings!).toHaveBeenLastCalledWith(expect.objectContaining({ 'appearance.diff-layout': 'unified' }));
    expect(sides()).toEqual(['right']);
    expect(isSideBySide(view)).toBe(false);
  });

  it('leaves the staged view unified', async () => {
    S.settings = { ...S.settings, 'appearance.diff-layout': 'side-by-side' };
    g.readBlob!.mockImplementation((rev: unknown) =>
      Promise.resolve(rev === 'head' ? blob('a\n') : blob('A\n', 'oidA')));
    await openRow({ section: 'staged', path: 'a.txt', letter: 'M', untracked: false, conflicted: false });
    await tick();
    expect(isSideBySide(view)).toBe(false);
    expect(sides()).toEqual(['right']);
    expect(toggle()).toBeNull();
  });
});

describe('changes-only survives the refresh path', () => {
  const lines = (mod: Record<number, string>): string =>
    Array.from({ length: 30 }, (_, i) => mod[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
  const INDEXED = lines({});
  const folds = async (): Promise<number> => {
    const { foldedRanges } = await import('@codemirror/language');
    let n = 0;
    foldedRanges(view.state).between(0, view.state.doc.length, () => { n++; });
    return n;
  };

  afterEach(() => { S.changesOnly = false; });

  it('re-folds after a refresh replaces the document under it', async () => {
    S.changesOnly = true;
    await openUnstaged('a.txt', blob(INDEXED), file(lines({ 2: 'two changed', 28: 'twentyeight changed' })));
    expect(await folds()).toBeGreaterThan(0);

    // an agent writing the open file is the path that reaches replaceDoc
    g.readFile!.mockResolvedValue(file(lines({ 2: 'two CHANGED', 28: 'twentyeight changed' })));
    g.readBlob!.mockResolvedValue(blob(INDEXED));
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();

    expect(await folds()).toBeGreaterThan(0);
  });
});

describe('blame in the file bar', () => {
  const line = (oid: string, summary: string): BlameLine => ({ oid, author: 'Ada', time: 1789629173, summary });
  /** Longer than the 150 ms debounce, so the queued git call has gone out. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 200));
  const moveTo = (lineNo: number): void =>
    view.dispatch({ selection: { anchor: view.state.doc.line(lineNo).from } });

  it('blames the cursor line and ignores an answer for a line the cursor has left', async () => {
    await openUnstaged('a.txt', blob('a\nb\nc\n'), file('a\nb\nc\n'));
    g.blame!.mockResolvedValue(line('9081303b08673ef3d8b67ebd7250f199e248a0db', 'second'));
    let late: (b: BlameLine) => void = () => {};
    g.blame!.mockImplementationOnce(() => new Promise<BlameLine>((r) => { late = r; }));

    moveTo(2);
    await settle();
    // the buffer on screen is always what gets blamed, never the file on disk
    expect(g.blame!).toHaveBeenLastCalledWith('a.txt', 2, 'a\nb\nc\n', 'lf');

    moveTo(3);
    await settle();
    expect(S.blame?.summary).toBe('second');

    late(line('1111111111111111111111111111111111111111', 'first'));
    await tick();
    expect(S.blame?.summary).toBe('second');
  });

  it('blames the edited buffer and shows nothing when git cannot blame', async () => {
    await openUnstaged('a.txt', blob('a\nb\nc\n'), file('a\nb\nc\n'));
    g.blame!.mockResolvedValue(line('9081303b08673ef3d8b67ebd7250f199e248a0db', 'x'));
    type('mine\nyours\n');
    moveTo(2);
    await settle();
    expect(g.blame!).toHaveBeenLastCalledWith('a.txt', 2, 'mine\nyours\n', 'lf');

    g.blame!.mockRejectedValue({ kind: 'Git', detail: "fatal: no such path 'a.txt' in HEAD" });
    moveTo(1);
    await settle();
    expect(S.blame).toBe(null);
  });
});
