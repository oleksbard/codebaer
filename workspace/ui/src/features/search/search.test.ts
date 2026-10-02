import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { view } from '#core/session';
import type { SearchFile, SearchHit, SearchMsg } from '#ipc/git';
import { notify, S } from '#kernel/store';
import { file, g, mountApp, status } from '#test-app';
import { tick } from '#test-setup';
import { openHit, resetSearch, runSearch, searchChanged, setQuery, showSearch } from './search';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

/** Each call to git.search, with the means to answer it as the backend would. */
type Call = { query: string; include: string; send(m: SearchMsg): void; end(e?: unknown): void };
let calls: Call[] = [];

const hit = (line: number, text: string, from: number, to: number): SearchHit =>
  ({ line, col: from, text, ranges: [[from, to]], cut: false });
const found = (path: string, ...hits: SearchHit[]): SearchFile => ({ path, hits });

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  calls = [];
  g.search!.mockImplementation((...args: never[]) => {
    const [query, include, onMsg] = args as unknown as [string, string, (m: SearchMsg) => void];
    return new Promise<void>((resolve, reject) => {
      calls.push({ query, include, send: onMsg, end: (e) => (e ? reject(e) : resolve()) });
    });
  });
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.ts');
  Object.assign(S, {
    tab: 'search', searchQuery: '', searchInclude: '', searchFiles: [], searchBusy: false, searchTruncated: false,
    searchError: null, searchCollapsed: new Set(), searchSelected: null, searchStale: false,
  });
  notify();
});

afterEach(() => {
  vi.useRealTimers();
  S.tab = 'changes';
  notify();
});

const side = (): HTMLElement => document.querySelector<HTMLElement>('.side')!;

describe('running a search', () => {
  it('waits for a pause in typing, then searches once with the last query', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setQuery('t');
    setQuery('to');
    setQuery('tot');
    vi.advanceTimersByTime(299);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls.map((c) => c.query)).toEqual(['tot']);
  });

  it('lists the files in path order as they arrive, and stops being busy on Done', async () => {
    S.searchQuery = 'total';
    S.searchInclude = 'src';
    void runSearch();
    expect(calls[0]!.include).toBe('src');
    expect(S.searchBusy).toBe(true);
    calls[0]!.send({ t: 'Files', files: [found('src/b.ts', hit(3, 'total', 0, 5))] });
    calls[0]!.send({ t: 'Files', files: [found('src/a.ts', hit(1, 'a total', 2, 7))] });
    expect(S.searchFiles.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(S.searchBusy).toBe(true);
    calls[0]!.send({ t: 'Done', truncated: true });
    expect([S.searchBusy, S.searchTruncated]).toEqual([false, true]);
    calls[0]!.end();
    await tick();

    expect(side().querySelector('[role=status]')!.textContent).toBe('2 results in 2 files');
    const rows = [...side().querySelectorAll<HTMLElement>('.sfile')];
    expect(rows.map((r) => r.dataset.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(side().querySelector('.row.hit mark')!.textContent).toBe('total');
    expect(side().textContent).toContain('Only the first 20,000 are listed');
  });

  it('keeps the results on screen while a run after a change is still in flight', () => {
    S.searchQuery = 'total';
    void runSearch();
    calls[0]!.send({ t: 'Files', files: [found('old.ts', hit(1, 'total', 0, 5))] });
    calls[0]!.send({ t: 'Done', truncated: false });

    searchChanged();
    calls[1]!.send({ t: 'Files', files: [found('new.ts', hit(1, 'total', 0, 5))] });
    expect(S.searchFiles.map((f) => f.path)).toEqual(['old.ts']);
    calls[1]!.send({ t: 'Done', truncated: false });
    expect(S.searchFiles.map((f) => f.path)).toEqual(['new.ts']);
  });

  it('lets a running search finish when files change, then runs once more', () => {
    S.searchQuery = 'total';
    void runSearch();
    calls[0]!.send({ t: 'Files', files: [found('a.ts', hit(1, 'total', 0, 5))] });
    searchChanged();
    searchChanged();
    expect(calls).toHaveLength(1);
    calls[0]!.send({ t: 'Files', files: [found('b.ts', hit(1, 'total', 0, 5))] });
    calls[0]!.send({ t: 'Done', truncated: false });
    expect(S.searchFiles.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(calls).toHaveLength(2);
    calls[1]!.send({ t: 'Done', truncated: false });
    expect(calls).toHaveLength(2);
  });

  it('drops what a search sends once a newer one started', () => {
    S.searchQuery = 'a';
    void runSearch();
    S.searchQuery = 'ab';
    void runSearch();
    calls[0]!.send({ t: 'Files', files: [found('stale.ts', hit(1, 'a', 0, 1))] });
    calls[0]!.send({ t: 'Done', truncated: false });
    expect(S.searchFiles).toEqual([]);
    expect(S.searchBusy).toBe(true);
  });

  it('shows why a search failed', async () => {
    S.searchInclude = 'src/{a';
    S.searchQuery = 'x';
    void runSearch();
    calls[0]!.end({ kind: 'InvalidPath', detail: 'unclosed alternate group' });
    await tick();
    expect(S.searchError).toContain('unclosed alternate group');
    expect(S.searchBusy).toBe(false);
  });

  it('clearing the query clears the list and stops the search before it', () => {
    S.searchQuery = 'a';
    void runSearch();
    calls[0]!.send({ t: 'Files', files: [found('a.ts', hit(1, 'a', 0, 1))] });
    setQuery('');
    void runSearch();
    expect(calls.at(-1)!.query).toBe('');
    expect(S.searchFiles).toEqual([]);
  });

  it('runs again after files change while the tab shows, and on the next show while it is hidden', () => {
    S.searchQuery = 'a';
    searchChanged();
    expect(calls).toHaveLength(1);

    S.tab = 'files';
    searchChanged();
    expect(calls).toHaveLength(1);
    expect(S.searchStale).toBe(true);
    showSearch();
    expect(calls).toHaveLength(2);
    expect(S.searchStale).toBe(false);
  });
});

describe('the results', () => {
  it('fold a file away and back with a click on its row', async () => {
    S.searchFiles = [found('a.ts', hit(1, 'x', 0, 1), hit(2, 'x', 0, 1))];
    notify();
    await tick();
    expect(side().querySelectorAll('.row.hit')).toHaveLength(2);
    side().querySelector<HTMLElement>('.sfile')!.click();
    await tick();
    expect(side().querySelectorAll('.row.hit')).toHaveLength(0);
    expect(side().querySelector('.sfile')!.getAttribute('aria-expanded')).toBe('false');
    side().querySelector<HTMLElement>('.sfile')!.click();
    await tick();
    expect(side().querySelectorAll('.row.hit')).toHaveLength(2);
  });

  it('walk with the arrows; Enter folds a file, Left steps from a hit to its file and then folds it', async () => {
    g.readFile!.mockResolvedValue(file('x\n'));
    S.searchFiles = [found('a.ts', hit(1, 'x', 0, 1), hit(2, 'x', 0, 1)), found('b.ts', hit(1, 'x', 0, 1))];
    notify();
    await tick();
    const list = side().querySelector<HTMLElement>('.vlist')!;
    const press = async (key: string) => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await tick();
    };
    const cur = () => side().querySelector<HTMLElement>('.cur');
    await press('ArrowDown');
    expect(cur()!.dataset.path).toBe('a.ts');
    await press('Enter');
    expect([...S.searchCollapsed]).toEqual(['a.ts']);
    await press('ArrowDown');
    await press('ArrowDown');
    expect(S.searchSelected).toBe('b.ts:1:0');
    await press('ArrowLeft');
    expect(cur()!.dataset.path).toBe('b.ts');
    await press('ArrowLeft');
    expect([...S.searchCollapsed]).toEqual(['a.ts', 'b.ts']);
  });

  it('Enter in a field searches at once', async () => {
    S.searchQuery = 'now';
    notify();
    await tick();
    side().querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls.map((c) => c.query)).toEqual(['now']);
  });
});

describe('opening a hit', () => {
  it('opens the file with its match selected, and marks every match while the tab shows', async () => {
    S.searchQuery = 'needle';
    g.readFile!.mockResolvedValue(file('first line\nhay needle hay Needle\n'));
    await openHit('a.ts', hit(2, 'hay needle hay Needle', 4, 10));
    expect(S.open?.path).toBe('a.ts');
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe('needle');
    expect(S.searchSelected).toBe('a.ts:2:4');
    await tick();
    expect([...view.dom.querySelectorAll('.cm-searchMatch')].map((m) => m.textContent)).toEqual(['needle', 'Needle']);

    // a capital makes the query match case
    S.searchQuery = 'Needle';
    notify();
    await tick();
    expect([...view.dom.querySelectorAll('.cm-searchMatch')].map((m) => m.textContent)).toEqual(['Needle']);

    S.tab = 'changes';
    notify();
    await tick();
    expect(view.dom.querySelectorAll('.cm-searchMatch')).toHaveLength(0);
  });

  it('keeps the hit selected before when the user cancels the unsaved-changes question', async () => {
    g.readFile!.mockResolvedValue(file('one needle\n'));
    await openHit('a.ts', hit(1, 'one needle', 4, 10));
    S.open!.dirty = true;
    const opening = openHit('b.ts', hit(1, 'needle', 0, 6));
    await tick();
    expect(S.searchSelected).toBe('b.ts:1:0');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.dialog:not([inert]) .dialog-actions button')]
      .find((b) => b.textContent === 'Cancel')!;
    cancel.click();
    await opening;
    expect([S.open!.path, S.searchSelected]).toEqual(['a.ts', 'a.ts:1:4']);
    S.open!.dirty = false;
  });

  it('a hit in the open file, picked while another file still opens, wins over that open', async () => {
    g.readFile!.mockResolvedValue(file('one needle\ntwo needle\n'));
    await openHit('a.ts', hit(1, 'one needle', 4, 10));
    let land: (f: ReturnType<typeof file>) => void = () => {};
    g.readFile!.mockReturnValueOnce(new Promise((r) => { land = r; }));
    const toB = openHit('b.ts', hit(1, 'needle', 0, 6));
    await tick();
    await openHit('a.ts', hit(2, 'two needle', 4, 10));
    land(file('needle\n'));
    await toB;
    expect([S.open!.path, S.searchSelected]).toEqual(['a.ts', 'a.ts:2:4']);
    const sel = view.state.selection.main;
    expect(view.state.doc.lineAt(sel.from).number).toBe(2);
  });

  it('moves the selection in a file already open without reading it again', async () => {
    g.readFile!.mockResolvedValue(file('one needle\ntwo\nthree needle\n'));
    await openHit('a.ts', hit(1, 'one needle', 4, 10));
    await openHit('a.ts', hit(3, 'three needle', 6, 12));
    expect(g.readFile).toHaveBeenCalledTimes(1);
    const sel = view.state.selection.main;
    expect([view.state.doc.lineAt(sel.from).number, view.state.sliceDoc(sel.from, sel.to)]).toEqual([3, 'needle']);
  });
});

describe('a repo switch', () => {
  it('clears the results and stops the backend search, and runs the query again on the next show', () => {
    S.searchQuery = 'a';
    void runSearch();
    calls[0]!.send({ t: 'Files', files: [found('a.ts', hit(1, 'a', 0, 1))] });
    resetSearch();
    expect(calls.at(-1)!.query).toBe('');
    expect([S.searchFiles, S.searchBusy, S.searchStale]).toEqual([[], false, true]);
    calls[0]!.send({ t: 'Done', truncated: false });
    expect(S.searchFiles).toEqual([]);
  });
});
