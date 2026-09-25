import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlameLine, Blob, FileText, Status } from './git';
import { tick } from './test-setup';

vi.mock('./git', async () => {
  const actual = await vi.importActual<typeof import('./git')>('./git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('./toast', async () => {
  const actual = await vi.importActual<typeof import('./toast')>('./toast');
  return { ...actual, confirmDialog: vi.fn() };
});
vi.mock('./terminal', async () => {
  const actual = await vi.importActual<typeof import('./terminal')>('./terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const { git } = await import('./git');
const { confirmDialog } = await import('./toast');
const { checkCwd } = await import('./terminal');
const g = git as unknown as Record<string, ReturnType<typeof vi.fn<(...args: never[]) => Promise<unknown>>>>;
const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

const blob = (text: string, oid: string | null = 'oid1'): Blob => ({ text, eol: 'lf', oid, exists: oid !== null });
const file = (text: string, exists = true): FileText => ({ text, eol: 'lf', exists });
const status = (path: string, x = '.', y = 'M', untracked = false, conflicted = false): Status =>
  ({
    head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0,
    files: [{ path, indexStatus: x, worktreeStatus: y, untracked, conflicted }],
  });

let m: typeof import('./app/controller');
let S: typeof import('./app/store').S;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  m = await import('./app/controller');
  S = (await import('./app/store')).S;
  await tick();
});

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  S.open = null;
  S.selected = null;
  S.openEpoch = 0;
  S.flushing = null;
  S.status = status('a.txt');
});

/** Opens `path` in the Unstaged view through the real open path. */
async function openUnstaged(path: string, index: Blob, disk: FileText): Promise<void> {
  g.readBlob!.mockResolvedValue(index);
  g.readFile!.mockResolvedValue(disk);
  g.status!.mockResolvedValue(S.status);
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
    expect(S.open!.dirty).toBe(true);
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });

    await m.guarded('stagePath', () => git.stagePath('a.txt'));

    expect(g.writeFile!).toHaveBeenCalledTimes(1);
    expect(g.stagePath!).not.toHaveBeenCalled();
    expect(S.open!.dirty).toBe(true);
    expect(S.open!.badge).toEqual(file('agent\n'));
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
    expect(S.open!.dirty).toBe(false);
  });
});

describe('the Files tree', () => {
  afterEach(() => {
    // S.ignored is derived, never written to directly; a direct write is how duplicate rows got in
    const tracked = new Set(S.files);
    expect(S.ignored).toEqual([S.ignoredBase, ...S.ignoredKids.values()].flat().filter((p) => !tracked.has(p)));
    S.tab = 'changes';
    S.files = [];
    S.ignored = [];
    S.ignoredBase = [];
    S.ignoredKids = new Map();
    S.filesOpen = new Set();
  });

  /** Puts the Files tab on a repo whose only ignored entry is a collapsed `node_modules/`. */
  async function filesTab(): Promise<void> {
    S.tab = 'files';
    g.status!.mockResolvedValue(S.status);
    g.listFiles!.mockResolvedValue({ files: ['a.txt'], ignored: ['node_modules/'] });
    await m.refresh();
  }

  it('reads an ignored directory on demand and re-reads it on the next refresh', async () => {
    g.listDir!.mockResolvedValue(['node_modules/pkg/', 'node_modules/x.js']);
    await filesTab();
    expect(S.ignored).toEqual(['node_modules/']);

    m.toggleDir('node_modules', true, true);
    await tick();
    expect(g.listDir!).toHaveBeenCalledWith('node_modules');
    expect(S.ignored).toEqual(['node_modules/', 'node_modules/pkg/', 'node_modules/x.js']);

    // the contents came from disk rather than git's listing, so a refresh has to ask again
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await m.refresh();
    expect(S.ignored).toEqual(['node_modules/', 'node_modules/x.js']);
  });

  it('reads once when a directory is reopened before the first read lands', async () => {
    let settle: (v: string[]) => void = () => {};
    g.listDir!.mockReturnValue(new Promise<string[]>((r) => { settle = r; }));
    await filesTab();

    m.toggleDir('node_modules', true, true);
    m.toggleDir('node_modules', false);
    m.toggleDir('node_modules', true, true);
    settle(['node_modules/x.js']);
    await tick();

    expect(g.listDir!).toHaveBeenCalledTimes(1);
    expect(S.ignored).toEqual(['node_modules/', 'node_modules/x.js']);
  });

  it('drops a directory that has gone rather than re-reading it on every refresh', async () => {
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await filesTab();
    m.toggleDir('node_modules', true, true);
    await tick();

    g.listFiles!.mockResolvedValue({ files: ['a.txt'], ignored: [] });
    g.listDir!.mockRejectedValue({ kind: 'InvalidPath', detail: 'gone' });
    await m.refresh();
    expect(S.ignoredKids.size).toBe(0);
    expect(S.ignored).toEqual([]);

    g.listDir!.mockClear();
    await m.refresh();
    expect(g.listDir!).not.toHaveBeenCalled();
  });

  it('keeps a directory opened while a refresh was in flight', async () => {
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await filesTab();
    m.toggleDir('node_modules', true, true);
    await tick();

    const pending = new Map<string, (v: string[]) => void>();
    g.listFiles!.mockResolvedValue({ files: ['a.txt'], ignored: ['node_modules/', 'dist/'] });
    g.listDir!.mockImplementation(((p: string) => new Promise<string[]>((r) => { pending.set(p, r); })) as never);
    const inFlight = m.refresh();
    await tick();

    m.toggleDir('dist', true, true);
    await tick();
    pending.get('node_modules')!(['node_modules/x.js']);
    pending.get('dist')!(['dist/app.js']);
    await inFlight;
    await tick();

    expect(S.ignoredKids.get('dist')).toEqual(['dist/app.js']);
    expect(S.ignored).toContain('dist/app.js');
  });

  it('shows a path git has started tracking as a file, not also as an ignored row', async () => {
    g.listDir!.mockResolvedValue(['node_modules/keep.js']);
    await filesTab();
    m.toggleDir('node_modules', true, true);
    await tick();
    expect(S.ignored).toContain('node_modules/keep.js');

    // force-added from a terminal: git lists it now, the directory on disk still holds it
    g.listFiles!.mockResolvedValue({ files: ['a.txt', 'node_modules/keep.js'], ignored: ['node_modules/'] });
    await m.refresh();
    expect(S.files).toContain('node_modules/keep.js');
    expect(S.ignored).not.toContain('node_modules/keep.js');
  });

  it('stops re-reading a directory once it is collapsed', async () => {
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await filesTab();
    m.toggleDir('node_modules', true, true);
    await tick();

    m.toggleDir('node_modules', false);
    g.listDir!.mockClear();
    await m.refresh();
    expect(g.listDir!).not.toHaveBeenCalled();
    expect(S.ignored).toEqual(['node_modules/']);
  });
});

describe('a paneled record', () => {
  it('is reopened by the next refresh into an editor that still arms autosave', async () => {
    S.status = status('n.txt', '.', '.', true);
    g.status!.mockResolvedValue(S.status);
    g.readBlob!.mockRejectedValueOnce({ kind: 'Io', detail: 'boom' });
    await m.openRow({ section: 'unstaged', path: 'n.txt', letter: 'U', untracked: true, conflicted: false });
    expect(S.open!.panel).toBe('Io');

    g.readBlob!.mockResolvedValue(blob('', null));
    g.readFile!.mockResolvedValue(file('new\n'));
    await m.refresh();

    expect(S.open!.panel).toBe(null);
    type('typed\n');
    expect(S.open!.dirty).toBe(true);
  });

  it('whose path became unmerged is reopened into the conflict view', async () => {
    g.status!.mockResolvedValue(S.status);
    g.readBlob!.mockRejectedValueOnce({ kind: 'Io', detail: 'boom' });
    await m.openRow({ section: 'unstaged', path: 'a.txt', letter: 'M', untracked: false, conflicted: false });
    expect(S.open!.panel).toBe('Io');

    g.status!.mockResolvedValue(status('a.txt', 'U', 'U', false, true));
    g.readBlob!.mockClear().mockRejectedValue({ kind: 'Conflicted' });
    g.readFile!.mockResolvedValue(file('<<<<<<< ours\n'));
    await m.refresh();

    expect(S.open!.conflicted).toBe(true);
    expect(g.readBlob!).not.toHaveBeenCalled();
  });
});

describe('the two special reject cases', () => {
  it('a deleted file is restored with revert_path, without a write and without a confirmation', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('', false));
    expect(S.open!.baseline).toBe(null);

    await m.reject();

    expect(g.revertPath!).toHaveBeenCalledWith('a.txt');
    expect(g.writeFile!).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('a file with no index entry confirms first and calls nothing when the answer is no', async () => {
    await openUnstaged('n.txt', blob('', null), file('new\n'));
    expect(S.open!.originalExists).toBe(false);

    await m.reject();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(g.revertPath!).not.toHaveBeenCalled();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});

describe('section header buttons', () => {
  it('Stage all runs stage_all; Unstage all is disabled while nothing is staged', async () => {
    g.status!.mockResolvedValue(S.status);
    await m.refresh();
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
    await m.refresh();
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
    await m.refresh();
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

describe('sidebar resize', () => {
  // jsdom drives requestAnimationFrame off its own ~16ms clock, which no tick() can wait for
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  // jsdom lays nothing out: the sidebar's left edge is 0, so clientX is the width, and the
  // frame is given the width layout would have
  const frameWidth = 1000;
  const maxWidth = frameWidth - 400;
  beforeAll(() => {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0));
    globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
    const frame = document.querySelector('.frame')!;
    Object.defineProperty(frame, 'clientWidth', { value: frameWidth, configurable: true });
  });
  afterAll(() => {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
    delete (document.querySelector('.frame') as { clientWidth?: number } | null)?.clientWidth;
  });

  it('follows the pointer between 180px and the frame width less 400px, and stores the width on release',
    async () => {
    const gutter = document.getElementById('gutter')!;
    const shell = document.getElementById('shell')!;
    const ev = (kind: string, clientX = 0) =>
      gutter.dispatchEvent(new PointerEvent(kind, { pointerId: 1, clientX, bubbles: true }));
    ev('pointerdown', 272);
    ev('pointermove', 340);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe('340px');
    ev('pointermove', 20);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe('180px');
    ev('pointermove', 5000);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe(`${maxWidth}px`);
    ev('pointerup');
    expect(localStorage.getItem('codebaer.sideWidth')).toBe(String(maxWidth));
    ev('pointermove', 300);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe(`${maxWidth}px`);
  });

  it('coalesces the moves inside one frame into a single render of the last width', async () => {
    const { subscribe } = await import('./app/store');
    const gutter = document.getElementById('gutter')!;
    const shell = document.getElementById('shell')!;
    const ev = (kind: string, clientX = 0) =>
      gutter.dispatchEvent(new PointerEvent(kind, { pointerId: 1, clientX, bubbles: true }));
    let notifies = 0;
    const off = subscribe(() => { notifies++; });
    ev('pointerdown', 272);
    ev('pointermove', 300);
    ev('pointermove', 420);
    await tick();
    off();

    expect(notifies).toBe(1);
    expect(shell.style.getPropertyValue('--side-w')).toBe('420px');
    ev('pointerup');
    expect(localStorage.getItem('codebaer.sideWidth')).toBe('420');
  });
});

describe('the blank panel', () => {
  it('offers whole-file actions for a staged or unstaged panel and none in the plain view', async () => {
    const { notify } = await import('./app/store');
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

describe('the Files tree', () => {
  it('expands every directory above a file it opens, and closes one on demand', async () => {
    g.readFile!.mockResolvedValue(file('x\n'));
    await m.openPlain('src/app/api/q.ts');

    expect([...S.filesOpen]).toEqual(['src', 'src/app', 'src/app/api']);
    expect(S.selected).toBe('plain:src/app/api/q.ts');

    S.filesOpen.add('docs');
    m.toggleDir('docs', false);
    expect(S.filesOpen.has('docs')).toBe(false);
  });
});

describe('closing the open file', () => {
  it('writes a pending edit, clears the record, and blanks the editor', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');

    document.querySelector<HTMLButtonElement>('.tbar [aria-label="Close file"]')!.click();
    await vi.waitFor(() => expect(S.open).toBeNull());
    await tick();

    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.selected).toBeNull();
    expect(m.view.state.doc.toString()).toBe('');
    expect(document.querySelector('.blank')).not.toBeNull();
  });
});

describe('a failed commit', () => {
  it('reports in a dialog rather than a toast, and stops the button spinning', async () => {
    S.toasts = [];
    S.commitMessage = 'a message';
    g.commit!.mockRejectedValue({ kind: 'Git', detail: 'pre-commit hook failed' });

    await m.commit();

    expect(S.toasts).toEqual([]);
    expect(S.confirm?.message).toBe('Commit failed\npre-commit hook failed');
    expect(S.confirm?.error).toBe(true);
    expect(S.committing).toBe(false);
    expect(S.commitMessage).toBe('a message');
    S.confirm!.resolve(false);
    S.confirm = null;
  });
});

describe('the title bar and the branch row', () => {
  const pillButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.tbar .pill.warn button')];

  it('shows the changed-on-disk pill, reloads from disk, and writes the buffer on Keep mine', async () => {
    const { notify } = await import('./app/store');
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
    expect(document.querySelector('.tbar .pill')!.textContent).toBe('index → working tree');
    const btns = [...document.querySelectorAll<HTMLButtonElement>('.tbar .right .btn')];
    expect(btns.map((b) => b.textContent)).toEqual(['Reject ⌘N', 'Accept ⌘Y']);

    g.stageContent!.mockResolvedValue({ oid: 'oid2' });
    btns[1]!.click();

    await vi.waitFor(() => expect(g.stageContent!).toHaveBeenCalledTimes(1));
  });

  it('withBusy keeps a fast operation off the spinner', async () => {
    await m.withBusy(() => Promise.resolve());
    await new Promise((r) => setTimeout(r, 200));
    expect(S.busy).toBe(false);
  });

  it('withBusy shows the spinner once an operation outlives the delay', async () => {
    let release!: () => void;
    const slow = m.withBusy(() => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 200));
    expect(S.busy).toBe(true);
    release();
    await slow;
    expect(S.busy).toBe(false);
  });

  it('marks the ahead and behind counts only when there is something to push or pull', async () => {
    const { notify } = await import('./app/store');
    const tracked = (ahead: number, behind: number) => ({ ...status('a.txt'), upstream: 'origin/main', ahead, behind });

    S.status = tracked(2, 0);
    notify();
    await tick();
    let counts = [...document.querySelectorAll('.commit .ab span')];
    expect(counts.map((c) => c.textContent)).toEqual(['↑2', '↓0']);
    expect(counts.map((c) => c.className)).toEqual(['on', '']);

    S.status = tracked(0, 3);
    notify();
    await tick();
    counts = [...document.querySelectorAll('.commit .ab span')];
    expect(counts.map((c) => c.textContent)).toEqual(['↑0', '↓3']);
    expect(counts.map((c) => c.className)).toEqual(['', 'on']);

    S.status = status('a.txt');
    notify();
    await tick();
    expect(document.querySelector('.commit .ab')).toBeNull();
    expect(document.querySelector('.commit .branch .co')!.textContent).toBe('mainno upstream');
  });

  it('shows a spinner while busy, and Cancel only when the operation can be cancelled', async () => {
    const { notify } = await import('./app/store');
    S.busy = true;
    notify();
    await tick();
    expect(document.querySelector('.commit .branch .spinner')).not.toBeNull();
    expect(document.querySelector('.commit .branch .btn')).toBeNull();

    S.cancellable = true;
    notify();
    await tick();
    const cancel = document.querySelector<HTMLButtonElement>('.commit .branch .btn')!;
    expect(cancel.textContent).toBe('Cancel');

    cancel.click();

    expect(g.cancel!).toHaveBeenCalledTimes(1);
    S.busy = false;
    S.cancellable = false;
    notify();
    await tick();
    expect(document.querySelector('.commit .branch .spinner')).toBeNull();
  });
});

describe('accept moves on to the next change', () => {
  const INDEX = 'a\nb\nc\nd\ne\nf\ng\n';
  const line = (): number => m.view.state.doc.lineAt(m.view.state.selection.main.head).number;

  beforeEach(() => {
    g.stageContent!.mockResolvedValue({ oid: 'oid2' });
  });

  it('scrolls to the next hunk while this file still has one', async () => {
    await openUnstaged('a.txt', blob(INDEX), file('A\nb\nc\nd\ne\nf\nG\n'));
    g.status!.mockResolvedValue(S.status);
    // the refresh after a stage re-reads the index, so it has to hold the accepted hunk
    g.readBlob!.mockResolvedValue(blob('A\nb\nc\nd\ne\nf\ng\n', 'oid2'));
    expect(line()).toBe(1);

    await m.accept();
    await tick();

    expect(line()).toBe(7);
  });

  it('opens the next file with changes once this one has none left', async () => {
    await openUnstaged('a.txt', blob(INDEX), file('A\nb\nc\nd\ne\nf\ng\n'));
    g.status!.mockResolvedValue(status('b.txt'));
    g.readBlob!.mockResolvedValue(blob('A\nb\nc\nd\ne\nf\ng\n', 'oid2'));

    await m.accept();
    await tick();
    await tick();

    expect(S.open?.path).toBe('b.txt');
  });
});

describe('the inline hunk buttons act on their own chunk', () => {
  it('accepts the second chunk when the second chunk button is clicked', async () => {
    await openUnstaged('a.txt', blob('a\nb\nc\nd\ne\nf\ng\n'), file('A\nb\nc\nd\ne\nf\nG\n'));
    g.stageContent!.mockResolvedValue({ oid: 'oid2' });
    g.status!.mockResolvedValue(S.status);
    g.readBlob!.mockResolvedValue(blob('a\nb\nc\nd\ne\nf\nG\n', 'oid2'));

    const widgets = m.view.dom.querySelectorAll('.cm-deletedChunk');
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
    foldedRanges(m.view.state).between(0, m.view.state.doc.length, () => { n++; });
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
    await m.refresh();
    await tick();

    expect(await folds()).toBeGreaterThan(0);
  });
});

describe('blame in the file bar', () => {
  const line = (oid: string, summary: string): BlameLine => ({ oid, author: 'Ada', time: 1789629173, summary });
  /** Longer than the 150 ms debounce, so the queued git call has gone out. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 200));
  const moveTo = (lineNo: number): void =>
    m.view.dispatch({ selection: { anchor: m.view.state.doc.line(lineNo).from } });

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

describe('switching repos', () => {
  it('asks the terminal host to re-read every folder against the new root', async () => {
    const check = checkCwd as unknown as ReturnType<typeof vi.fn>;
    check.mockReset().mockResolvedValue(undefined);
    g.openRepo!.mockResolvedValue({ root: '/Users/me/repos/other', label: '~/repos/other', title: 'other' });
    await m.openRepo('/Users/me/repos/other');
    expect(S.root).toBe('/Users/me/repos/other');
    expect(S.rootLabel).toBe('~/repos/other');
    expect(check).toHaveBeenCalledOnce();
  });
});
