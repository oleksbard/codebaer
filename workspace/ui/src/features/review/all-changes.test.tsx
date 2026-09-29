import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { openPlain, openRepo, refresh } from '#core/session';
import type { Blob, FileEntry, FileText, Status } from '#ipc/git';
import { confirmDialog } from '#kernel/dialogs';
import { run } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { blob, file, g, headerItem, mountApp } from '#test-app';
import { tick } from '#test-setup';
import { checkCwd } from '#ipc/terminal';
import { dropPage, LARGE, LARGE_TEXT, rethemeAllChanges } from './all-changes';

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

/** jsdom has no IntersectionObserver; this one reports nothing until a test scrolls with seeAll(). */
const observers: FakeObserver[] = [];
class FakeObserver {
  els = new Set<Element>();
  root: Element | null;
  constructor(public cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.root = opts?.root instanceof Element ? opts.root : null;
    observers.push(this);
  }
  observe(el: Element): void { this.els.add(el); }
  unobserve(el: Element): void { this.els.delete(el); }
  disconnect(): void { this.els.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
vi.stubGlobal('IntersectionObserver', FakeObserver);

/** Every file on the page comes near the screen, as a scroll through it would. */
function seeAll(): void {
  for (const o of observers) {
    if (!o.root?.classList.contains('stack')) continue;
    o.cb([...o.els].map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry),
      o as unknown as IntersectionObserver);
  }
}

const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const button = (path: string, text: string): HTMLButtonElement =>
  [...sec(path)!.querySelectorAll('button')].find((b) => b.textContent === text)!;

type Seed = { index?: Blob; disk?: FileText | { fail: object }; entry?: Partial<FileEntry> };
let repo: Record<string, Seed>;
let status: Status;

function seed(files: Record<string, Seed>): void {
  repo = files;
  status = {
    head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, stash: 0,
    files: Object.entries(files).map(([path, f]) => ({
      path, indexStatus: '.', worktreeStatus: 'M', untracked: false, conflicted: false, ...f.entry,
    })),
  };
}

const sec = (path: string) => document.querySelector<HTMLElement>(`.fsec[data-path="${path}"]`);
const editorOf = (path: string): EditorView | null => {
  const el = sec(path)?.querySelector<HTMLElement>('.cm-editor');
  return el ? EditorView.findFromDOM(el) : null;
};

async function openPage(): Promise<void> {
  await refresh();
  await tick();
  (await headerItem('unstaged', 'show')).click();
  await vi.waitFor(() => expect(document.querySelector('.stack')).not.toBe(null));
}

async function openAndRead(...paths: string[]): Promise<void> {
  await openPage();
  seeAll();
  await vi.waitFor(() => { for (const p of paths) expect(editorOf(p)).not.toBe(null); });
}

beforeAll(mountApp);

beforeEach(async () => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  dropPage();
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.toasts = [];
  seed({
    'a.txt': { index: blob('one\ntwo\nthree\n', 'ia'), disk: file('ONE\ntwo\nthree\n') },
    'b.txt': { index: blob('x\ny\n', 'ib'), disk: file('x\nY\n') },
  });
  g.status!.mockImplementation(async () => status);
  g.readBlob!.mockImplementation(async (_rev: unknown, path: string) => repo[path]?.index ?? blob('', null));
  g.readFile!.mockImplementation(async (path: string) => {
    const d = repo[path]?.disk;
    if (d && 'fail' in d) throw d.fail;
    return d ?? file('', false);
  });
  g.stageContent!.mockResolvedValue({ oid: 'staged' });
  notify();
  await tick();
});

describe('the All changes page', () => {
  it('opens from the Changes header with a section per unstaged file, each read as it nears the screen', async () => {
    await openPage();
    expect((await headerItem('unstaged', 'show')).textContent).toMatch(/^Close all changes/);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect([...document.querySelectorAll<HTMLElement>('.fsec')].map((s) => s.dataset.path)).toEqual(['a.txt', 'b.txt']);
    expect(g.readFile!).not.toHaveBeenCalled();

    seeAll();

    await vi.waitFor(() => expect(editorOf('b.txt')).not.toBe(null));
    expect(g.readBlob!).toHaveBeenCalledWith('index', 'a.txt');
    expect(g.readFile!).toHaveBeenCalledWith('b.txt');
    expect(editorOf('a.txt')!.state.readOnly).toBe(true);
  });

  it('the toggle is gone with nothing to review, and pressing it again leaves for the file on the page', async () => {
    seed({});
    await refresh();
    await tick();
    expect(document.querySelector('details[data-sec="unstaged"] summary [data-all]')).toBe(null);

    seed({ 'a.txt': { index: blob('one\n', 'ia'), disk: file('ONE\n') } });
    await openPage();
    (await headerItem('unstaged', 'show')).click();

    await vi.waitFor(() => expect(S.open?.path).toBe('a.txt'));
    expect(document.querySelector('.stack')).toBe(null);
    expect(S.allChanges).toBe(null);
  });

  it('a hunk accepted with its button stages against the index it read, and the keys go on to the next', async () => {
    await openAndRead('a.txt', 'b.txt');
    g.stageContent!.mockImplementation(async (path: string) => {
      const f = status.files.find((x) => x.path === path)!;
      f.indexStatus = 'M';
      f.worktreeStatus = '.';
      return { oid: `staged-${path}` };
    });

    sec('a.txt')!.querySelector<HTMLButtonElement>('button[name="accept"]')!.click();

    await vi.waitFor(() => expect(sec('a.txt')!.classList.contains('done')).toBe(true));
    expect(g.stageContent!).toHaveBeenCalledWith('a.txt', 'ONE\ntwo\nthree\n', 'lf', 'ia');
    expect(sec('a.txt')!.textContent).toContain('accepted');

    run('review.accept');

    await vi.waitFor(() => expect(g.stageContent!).toHaveBeenCalledWith('b.txt', 'x\nY\n', 'lf', 'ib'));
  });

  it('a rejected hunk writes the file against the text it read; a stale write says so and re-diffs', async () => {
    await openAndRead('a.txt');
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\ntwo\nthree\n') });
    repo['a.txt']!.disk = file('agent\ntwo\nthree\n');

    sec('a.txt')!.querySelector<HTMLButtonElement>('button[name="reject"]')!.click();

    await vi.waitFor(() => expect(editorOf('a.txt')!.state.doc.toString()).toBe('agent\ntwo\nthree\n'));
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'one\ntwo\nthree\n', 'lf', 'ONE\ntwo\nthree\n');
    expect(S.toasts.map((t) => t.message)).toEqual(['a.txt changed on disk, your reject was dropped, re-diffed']);
  });

  it('a file git never had asks before its reject deletes it', async () => {
    seed({ 'n.txt': { disk: file('new\n'), entry: { worktreeStatus: '.', untracked: true } } });
    await openAndRead('n.txt');

    sec('n.txt')!.querySelector<HTMLButtonElement>('button[name="reject"]')!.click();

    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete n.txt?')));
    expect(g.revertPath!).not.toHaveBeenCalled();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });

  it('a binary file and a conflict get a note instead of a diff; a large diff waits behind Show diff', async () => {
    const big = Array.from({ length: LARGE + 1 }, (_, i) => `line ${i}`).join('\n');
    seed({
      'logo.png': { index: blob('', 'il'), disk: { fail: { kind: 'Binary' } } },
      'c.txt': { entry: { conflicted: true } },
      'big.txt': { index: blob('', 'ib'), disk: file(`${big}\n`) },
    });
    await openPage();
    seeAll();

    await vi.waitFor(() => expect(sec('big.txt')!.querySelector('.fnote')).not.toBe(null));
    expect(sec('logo.png')!.querySelector('.fnote')!.textContent).toBe('binary file, whole-file actions only');
    expect(sec('c.txt')!.querySelector('.fnote')!.textContent).toBe('conflict, open the file to resolve the markers');
    expect(sec('c.txt')!.textContent).not.toContain('Accept file');
    const body = sec('big.txt')!.querySelector<HTMLElement>('.fbody')!;
    expect(body.hidden).toBe(true);
    expect(sec('big.txt')!.querySelector('.fnote')!.textContent)
      .toContain(`${(LARGE + 1).toLocaleString()} changed lines`);

    [...sec('big.txt')!.querySelectorAll('button')].find((b) => b.textContent === 'Show diff')!.click();
    await tick();

    expect(body.hidden).toBe(false);
  });

  it('a file the agent writes joins the end, and the hunk keys walk across the files in page order', async () => {
    await openAndRead('a.txt', 'b.txt');
    seed({ ...repo, 'c.txt': { index: blob('p\n', 'ic'), disk: file('P\n') } });
    await refresh();
    await tick();
    expect([...document.querySelectorAll<HTMLElement>('.fsec')].map((s) => s.dataset.path))
      .toEqual(['a.txt', 'b.txt', 'c.txt']);
    seeAll();
    await vi.waitFor(() => expect(editorOf('c.txt')).not.toBe(null));

    run('review.nextHunk');
    await vi.waitFor(() => expect(editorOf('a.txt')!.state.selection.main.head).toBe(0));
    run('review.nextHunk');
    await vi.waitFor(() => expect(editorOf('b.txt')!.state.selection.main.head).toBe(2));
    run('review.prevHunk');
    await tick();
    run('review.prevHunk');
    await tick();
    run('review.accept');

    await vi.waitFor(() => expect(g.stageContent!).toHaveBeenCalledWith('c.txt', 'P\n', 'lf', 'ic'));
  });

  it('a queue row scrolls to its file instead of opening it, and an open anywhere else leaves the page', async () => {
    await openAndRead('a.txt', 'b.txt');
    g.readBlob!.mockClear();

    document.querySelector<HTMLElement>('.row[data-key="unstaged:b.txt"]')!.click();
    await tick();

    expect(S.open).toBe(null);
    expect(S.selected).toBe('unstaged:b.txt');
    expect(document.querySelector('.stack')).not.toBe(null);

    await openPlain('b.txt');
    await tick();

    expect(S.allChanges).toBe(null);
    expect(document.querySelector('.stack')).toBe(null);
  });

  it('Open takes the file to the one-file view on the hunk its section was on', async () => {
    seed({ 'a.txt': { index: blob('1\n2\n3\n4\n5\n6\n7\n8\n9\n', 'ia'), disk: file('1\nX\n3\n4\n5\n6\n7\n8\nY\n') } });
    await openAndRead('a.txt');
    const v = editorOf('a.txt')!;
    v.dispatch({ selection: { anchor: v.state.doc.line(9).from } });

    [...sec('a.txt')!.querySelectorAll('button')].find((b) => b.textContent === 'Open')!.click();

    await vi.waitFor(() => expect(S.open?.path).toBe('a.txt'));
    await vi.waitFor(() => expect(document.querySelector('.tbar .pos')!.textContent).toBe('hunk 2 of 2'));
  });

  it('a refresh during a reject write waits for it, so the next reject starts from the agent text', async () => {
    await openAndRead('a.txt');
    const write = deferred<void>();
    g.writeFile!.mockReturnValueOnce(write.promise);

    sec('a.txt')!.querySelector<HTMLButtonElement>('button[name="reject"]')!.click();
    await vi.waitFor(() => expect(g.writeFile!).toHaveBeenCalledTimes(1));
    repo['a.txt']!.disk = file('one\nAGENT\nthree\n');
    const refreshing = refresh();
    await tick();
    write.reject({ kind: 'Stale', detail: file('one\nAGENT\nthree\n') });
    await refreshing;
    await vi.waitFor(() => expect(editorOf('a.txt')!.state.doc.toString()).toBe('one\nAGENT\nthree\n'));

    g.writeFile!.mockResolvedValue(undefined);
    sec('a.txt')!.querySelector<HTMLButtonElement>('button[name="reject"]')!.click();

    await vi.waitFor(() => expect(g.writeFile!).toHaveBeenCalledTimes(2));
    expect(g.writeFile!).toHaveBeenLastCalledWith('a.txt', 'one\ntwo\nthree\n', 'lf', 'one\nAGENT\nthree\n');
  });

  it('an agent edit or an index change to a file on the page re-diffs it in place', async () => {
    await openAndRead('a.txt');
    repo['a.txt'] = { index: blob('ONE\ntwo\nthree\n', 'ia2'), disk: file('ONE\ntwo\nthree\nfour\n') };

    await refresh();

    const v = editorOf('a.txt')!;
    expect(v.state.doc.toString()).toBe('ONE\ntwo\nthree\nfour\n');
    expect(sec('a.txt')!.querySelectorAll('button[name="accept"]')).toHaveLength(1);
  });

  it('a file off screen at a refresh reads again only when it comes near', async () => {
    await openAndRead('a.txt', 'b.txt');
    const io = observers.find((o) => o.root?.classList.contains('stack'))!;
    io.cb([{ isIntersecting: false, target: sec('b.txt')! } as unknown as IntersectionObserverEntry],
      io as unknown as IntersectionObserver);
    g.readFile!.mockClear();

    await refresh();

    expect(g.readFile!.mock.calls).toEqual([['a.txt']]);
    seeAll();
    await vi.waitFor(() => expect(g.readFile!).toHaveBeenCalledWith('b.txt'));
  });

  it('the whole-file keys act on the file being read, and refuse a conflict the page cannot resolve', async () => {
    seed({ ...repo, 'c.txt': { entry: { conflicted: true } } });
    await openAndRead('a.txt', 'b.txt');
    document.querySelector<HTMLElement>('.row[data-key="unstaged:b.txt"]')!.click();
    await tick();

    run('review.stageFile');
    await vi.waitFor(() => expect(g.stagePath!).toHaveBeenCalledWith('b.txt'));

    document.querySelector<HTMLElement>('.row[data-key="unstaged:c.txt"]')!.click();
    await tick();
    g.stagePath!.mockClear();
    run('review.stageFile');
    await tick();

    expect(g.stagePath!).not.toHaveBeenCalled();
    expect(S.toasts.map((t) => t.message)).toContain('Put the cursor in a file still to review first');
  });

  it('the file keys stop at a diff behind Show diff without arming the hunk keys on it', async () => {
    const big = Array.from({ length: LARGE + 1 }, (_, i) => `line ${i}`).join('\n');
    seed({ 'a.txt': repo['a.txt']!, 'big.txt': { index: blob('', 'ib'), disk: file(`${big}\n`) } });
    await openAndRead('a.txt', 'big.txt');

    // back to back, so the first press is still waiting on its file when the second lands
    run('review.nextFile');
    run('review.nextFile');
    await tick();
    run('review.accept');
    await tick();

    expect(S.selected).toBe('unstaged:big.txt');
    expect(g.stageContent!).not.toHaveBeenCalled();
    expect(S.toasts.map((t) => t.message)).toContain('Put the cursor in a hunk first');
  });

  it('a file too big to diff waits for Show diff before it is diffed at all', async () => {
    seed({ 'huge.txt': { index: blob('x'.repeat(LARGE_TEXT), 'ih'), disk: file(`${'y'.repeat(10)}\n`) } });
    await openPage();
    seeAll();
    await vi.waitFor(() => expect(sec('huge.txt')!.querySelector('.fnote')?.textContent).toContain('large file'));
    expect(editorOf('huge.txt')).toBe(null);

    button('huge.txt', 'Show diff').click();

    await vi.waitFor(() => expect(editorOf('huge.txt')).not.toBe(null));
  });

  it('a file that fails to open elsewhere still ends the page', async () => {
    seed({ ...repo, 'logo.png': { disk: { fail: { kind: 'Binary' } } } });
    await openAndRead('a.txt');

    await openPlain('logo.png');
    await tick();

    expect(S.open?.panel).toBe('Binary');
    expect(S.allChanges).toBe(null);
  });

  it('the Terminals tab keeps the page, and its key comes back to it instead of building a new one', async () => {
    await openAndRead('a.txt');
    const page = S.allChanges;
    S.tab = 'terminals';
    notify();
    await tick();
    expect(document.querySelector('.stack')).toBe(null);
    g.readFile!.mockClear();

    run('review.allChanges');
    await tick();

    expect(S.tab).toBe('changes');
    expect(S.allChanges).toBe(page);
    expect(editorOf('a.txt')).not.toBe(null);
    expect(g.readFile!).not.toHaveBeenCalled();
  });

  it('a theme switch reaches the editors on the page, and a repo switch ends the page', async () => {
    await openAndRead('a.txt');
    rethemeAllChanges(false);
    expect(editorOf('a.txt')!.state.facet(EditorView.darkTheme)).toBe(false);
    (checkCwd as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    g.openRepo!.mockResolvedValue({ root: '/other', label: 'other', title: null });

    await openRepo('/other');

    expect(S.allChanges).toBe(null);
    expect(document.querySelector('.stack')).toBe(null);
  });

  it('a click queued behind a re-read that moves the text is dropped and says so, for accept and reject', async () => {
    seed({ 'a.txt': repo['a.txt']! });
    await openAndRead('a.txt');
    const cases = [['accept', g.stageContent!, 'staged'], ['reject', g.writeFile!, 'rejected']] as const;
    for (const [name, call, verb] of cases) {
      const read = deferred<FileText>();
      g.readFile!.mockReturnValueOnce(read.promise);
      const reads = g.readFile!.mock.calls.length;
      const refreshing = refresh();
      await vi.waitFor(() => expect(g.readFile!.mock.calls.length).toBe(reads + 1));
      call.mockClear();
      S.toasts = [];

      sec('a.txt')!.querySelector<HTMLButtonElement>(`button[name="${name}"]`)!.click();
      read.resolve(file(`agent ${name}\nONE\ntwo\nthree\n`));
      await refreshing;
      await vi.waitFor(() => expect(S.toasts.map((t) => t.message))
        .toEqual([`a.txt changed and was re-diffed, nothing was ${verb}`]));

      expect(call).not.toHaveBeenCalled();
      repo['a.txt']!.disk = file(`agent ${name}\nONE\ntwo\nthree\n`);
    }
  });
});
