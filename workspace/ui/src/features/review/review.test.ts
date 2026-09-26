import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRow, refresh, view } from '#core/session';
import { getOriginalDoc } from '#editor/editor';
import type { BlameLine, Blob } from '#ipc/git';
import { confirmDialog } from '#kernel/dialogs';
import { S } from '#kernel/store';
import { blob, file, g, mountApp, openUnstaged, status, type } from '#test-app';
import { tick } from '#test-setup';
import { accept, reject, unstageHunk } from './hunks';

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

  it('a file with no index entry confirms first and calls nothing when the answer is no', async () => {
    await openUnstaged('n.txt', blob('', null), file('new\n'));
    expect(S.open!.originalExists).toBe(false);

    await reject();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(g.revertPath!).not.toHaveBeenCalled();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});

describe('section header buttons', () => {
  it('Stage all runs stage_all; Unstage all is disabled while nothing is staged', async () => {
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();
    const stageAll = document.querySelector<HTMLButtonElement>('[data-all="stage"]')!;
    const unstageAll = document.querySelector<HTMLButtonElement>('[data-all="unstage"]')!;
    expect(stageAll.disabled).toBe(false);
    expect(unstageAll.disabled).toBe(true);

    stageAll.click();

    await vi.waitFor(() => expect(g.stageAll!).toHaveBeenCalledTimes(1));
    expect(g.unstageAll!).not.toHaveBeenCalled();
  });

  it('Unstage all runs unstage_all once something is staged, and Stage all is then disabled', async () => {
    S.status = status('a.txt', 'M', '.');
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();
    const stageAll = document.querySelector<HTMLButtonElement>('[data-all="stage"]')!;
    const unstageAll = document.querySelector<HTMLButtonElement>('[data-all="unstage"]')!;
    expect(stageAll.disabled).toBe(true);
    expect(unstageAll.disabled).toBe(false);

    unstageAll.click();

    await vi.waitFor(() => expect(g.unstageAll!).toHaveBeenCalledTimes(1));
    expect(g.stageAll!).not.toHaveBeenCalled();
  });

  it('Enter on a focused header button does not also activate the selected row', async () => {
    g.status!.mockResolvedValue(S.status);
    await refresh();
    await tick();
    const row = document.querySelector<HTMLElement>('.row')!;
    row.click();
    await vi.waitFor(() => expect(S.open?.path).toBe('a.txt'));
    g.readBlob!.mockClear();
    const stageAll = document.querySelector<HTMLButtonElement>('[data-all="stage"]')!;

    stageAll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();

    expect(g.readBlob!).not.toHaveBeenCalled();
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

  it('counts the hunk and offers Reject and Accept for an unstaged record', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    await tick();
    expect(document.querySelector('.tbar .pos')!.textContent).toBe('hunk 1 of 1');
    expect(document.querySelector('.tbar .mode')!.textContent).toBe('index → working tree');
    const btns = [...document.querySelectorAll<HTMLButtonElement>('.tbar .right .btn')];
    expect(btns.map((b) => b.textContent)).toEqual(['Reject ⌘N', 'Accept ⌘Y']);

    g.stageContent!.mockResolvedValue({ oid: 'oid2' });
    btns[1]!.click();

    await vi.waitFor(() => expect(g.stageContent!).toHaveBeenCalledTimes(1));
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
    expect(S.blame).toBe('9081303 · Ada · 2026-09-17 · second');

    late(line('1111111111111111111111111111111111111111', 'first'));
    await tick();
    expect(S.blame).toBe('9081303 · Ada · 2026-09-17 · second');
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
