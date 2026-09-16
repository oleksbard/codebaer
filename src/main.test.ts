import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Blob, FileText, Status } from './git';

// jsdom implements no Range geometry, and CodeMirror measures the document
// whenever a dispatch asks to scroll a chunk into view
const rangeProto = Range.prototype as unknown as Record<string, unknown>;
rangeProto.getClientRects = () => [];
rangeProto.getBoundingClientRect = () => new DOMRect();

vi.mock('./git', async () => {
  const actual = await vi.importActual<typeof import('./git')>('./git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});

const { git } = await import('./git');
const g = git as unknown as Record<string, ReturnType<typeof vi.fn>>;

const blob = (text: string, oid: string | null = 'oid1'): Blob => ({ text, eol: 'lf', oid, exists: oid !== null });
const file = (text: string, exists = true): FileText => ({ text, eol: 'lf', exists });
const status = (path: string, x = '.', y = 'M', untracked = false, conflicted = false): Status =>
  ({ head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, files: [{ path, indexStatus: x, worktreeStatus: y, untracked, conflicted }] });

let m: typeof import('./main');
let confirmSpy: MockInstance<(message?: string) => boolean>;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  m = await import('./main');
});

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
  m.S.open = null;
  m.S.selected = null;
  m.S.openEpoch = 0;
  m.S.flushing = null;
  m.S.status = status('a.txt');
});

afterEach(() => {
  confirmSpy.mockRestore();
});

/** Opens `path` in the Unstaged view through the real open path. */
async function openUnstaged(path: string, index: Blob, disk: FileText): Promise<void> {
  g.readBlob!.mockResolvedValue(index);
  g.readFile!.mockResolvedValue(disk);
  g.status!.mockResolvedValue(m.S.status);
  await m.openRow({ section: 'unstaged', path, letter: 'M', untracked: false, conflicted: false });
  g.readBlob!.mockClear();
  g.readFile!.mockClear();
}

function type(text: string): void {
  m.view.dispatch({ changes: { from: 0, to: m.view.state.doc.length, insert: text } });
}

describe('autosave flush before a flush-set command', () => {
  it('abandons the command when the pre-flush comes back Stale', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    expect(m.S.open!.dirty).toBe(true);
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });

    await m.guarded('stagePath', () => git.stagePath('a.txt'));

    expect(g.writeFile!).toHaveBeenCalledTimes(1);
    expect(g.stagePath!).not.toHaveBeenCalled();
    expect(m.S.open!.dirty).toBe(true);
    expect(m.S.open!.badge).toEqual(file('agent\n'));
  });

  it('writes the doc text first and runs the command only after the write resolves', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    const order: string[] = [];
    g.writeFile!.mockImplementation(async () => { order.push('write'); });
    g.stagePath!.mockImplementation(async () => { order.push('stage'); });

    await m.guarded('stagePath', () => git.stagePath('a.txt'));

    expect(order).toEqual(['write', 'stage']);
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(m.S.open!.dirty).toBe(false);
  });
});

describe('a paneled record', () => {
  it('is reopened by the next refresh into an editor that still arms autosave', async () => {
    m.S.status = status('n.txt', '.', '.', true);
    g.status!.mockResolvedValue(m.S.status);
    g.readBlob!.mockRejectedValueOnce({ kind: 'Io', detail: 'boom' });
    await m.openRow({ section: 'unstaged', path: 'n.txt', letter: 'U', untracked: true, conflicted: false });
    expect(m.S.open!.panel).toBe('Io');

    g.readBlob!.mockResolvedValue(blob('', null));
    g.readFile!.mockResolvedValue(file('new\n'));
    await m.refresh();

    expect(m.S.open!.panel).toBe(null);
    type('typed\n');
    expect(m.S.open!.dirty).toBe(true);
  });

  it('whose path became unmerged is reopened into the conflict view', async () => {
    g.status!.mockResolvedValue(m.S.status);
    g.readBlob!.mockRejectedValueOnce({ kind: 'Io', detail: 'boom' });
    await m.openRow({ section: 'unstaged', path: 'a.txt', letter: 'M', untracked: false, conflicted: false });
    expect(m.S.open!.panel).toBe('Io');

    g.status!.mockResolvedValue(status('a.txt', 'U', 'U', false, true));
    g.readBlob!.mockClear().mockRejectedValue({ kind: 'Conflicted' });
    g.readFile!.mockResolvedValue(file('<<<<<<< ours\n'));
    await m.refresh();

    expect(m.S.open!.conflicted).toBe(true);
    expect(g.readBlob!).not.toHaveBeenCalled();
  });
});

describe('section header buttons', () => {
  it('Stage all runs stage_all; Unstage all is disabled while nothing is staged', async () => {
    g.status!.mockResolvedValue(m.S.status);
    await m.refresh();
    const stageAll = document.querySelector<HTMLButtonElement>('[data-all="stage"]')!;
    const unstageAll = document.querySelector<HTMLButtonElement>('[data-all="unstage"]')!;
    expect(stageAll.disabled).toBe(false);
    expect(unstageAll.disabled).toBe(true);

    stageAll.click();

    await vi.waitFor(() => expect(g.stageAll!).toHaveBeenCalledTimes(1));
    expect(g.unstageAll!).not.toHaveBeenCalled();
  });

  it('Unstage all runs unstage_all once something is staged, and Stage all is then disabled', async () => {
    m.S.status = status('a.txt', 'M', '.');
    g.status!.mockResolvedValue(m.S.status);
    await m.refresh();
    const stageAll = document.querySelector<HTMLButtonElement>('[data-all="stage"]')!;
    const unstageAll = document.querySelector<HTMLButtonElement>('[data-all="unstage"]')!;
    expect(stageAll.disabled).toBe(true);
    expect(unstageAll.disabled).toBe(false);

    unstageAll.click();

    await vi.waitFor(() => expect(g.unstageAll!).toHaveBeenCalledTimes(1));
    expect(g.stageAll!).not.toHaveBeenCalled();
  });

  it('Enter on a focused header button does not also activate the selected row', async () => {
    g.status!.mockResolvedValue(m.S.status);
    await m.refresh();
    const row = document.querySelector<HTMLElement>('.row')!;
    row.click();
    await vi.waitFor(() => expect(m.S.open?.path).toBe('a.txt'));
    g.readBlob!.mockClear();
    const stageAll = document.querySelector<HTMLButtonElement>('[data-all="stage"]')!;

    stageAll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(g.readBlob!).not.toHaveBeenCalled();
  });
});

describe('the two special reject cases', () => {
  it('a deleted file is restored with revert_path, without a write and without a confirmation', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('', false));
    expect(m.S.open!.baseline).toBe(null);

    await m.reject();

    expect(g.revertPath!).toHaveBeenCalledWith('a.txt');
    expect(g.writeFile!).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('a file with no index entry confirms first and calls nothing when the answer is no', async () => {
    await openUnstaged('n.txt', blob('', null), file('new\n'));
    expect(m.S.open!.originalExists).toBe(false);

    await m.reject();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(g.revertPath!).not.toHaveBeenCalled();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});
