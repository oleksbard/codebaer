import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPlain, refresh } from '#core/session';
import { confirmDialog, promptDialog } from '#kernel/dialogs';
import { S } from '#kernel/store';
import { file, g, mountApp, status } from '#test-app';
import { tick } from '#test-setup';
import { create, toggleDir } from './files';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn(), promptDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;
const promptMock = vi.mocked(promptDialog);

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
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
    g.listFiles!.mockResolvedValue({ files: ['a.txt'], ignored: ['node_modules/'], empty: [] });
    await refresh();
  }

  it('reads an ignored directory on demand and re-reads it on the next refresh', async () => {
    g.listDir!.mockResolvedValue(['node_modules/pkg/', 'node_modules/x.js']);
    await filesTab();
    expect(S.ignored).toEqual(['node_modules/']);

    toggleDir('node_modules', true, true);
    await tick();
    expect(g.listDir!).toHaveBeenCalledWith('node_modules');
    expect(S.ignored).toEqual(['node_modules/', 'node_modules/pkg/', 'node_modules/x.js']);

    // the contents came from disk rather than git's listing, so a refresh has to ask again
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await refresh();
    expect(S.ignored).toEqual(['node_modules/', 'node_modules/x.js']);
  });

  it('reads once when a directory is reopened before the first read lands', async () => {
    let settle: (v: string[]) => void = () => {};
    g.listDir!.mockReturnValue(new Promise<string[]>((r) => { settle = r; }));
    await filesTab();

    toggleDir('node_modules', true, true);
    toggleDir('node_modules', false);
    toggleDir('node_modules', true, true);
    settle(['node_modules/x.js']);
    await tick();

    expect(g.listDir!).toHaveBeenCalledTimes(1);
    expect(S.ignored).toEqual(['node_modules/', 'node_modules/x.js']);
  });

  it('drops a directory that has gone rather than re-reading it on every refresh', async () => {
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await filesTab();
    toggleDir('node_modules', true, true);
    await tick();

    g.listFiles!.mockResolvedValue({ files: ['a.txt'], ignored: [], empty: [] });
    g.listDir!.mockRejectedValue({ kind: 'InvalidPath', detail: 'gone' });
    await refresh();
    expect(S.ignoredKids.size).toBe(0);
    expect(S.ignored).toEqual([]);

    g.listDir!.mockClear();
    await refresh();
    expect(g.listDir!).not.toHaveBeenCalled();
  });

  it('keeps a directory opened while a refresh was in flight', async () => {
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await filesTab();
    toggleDir('node_modules', true, true);
    await tick();

    const pending = new Map<string, (v: string[]) => void>();
    g.listFiles!.mockResolvedValue({ files: ['a.txt'], ignored: ['node_modules/', 'dist/'], empty: [] });
    g.listDir!.mockImplementation(((p: string) => new Promise<string[]>((r) => { pending.set(p, r); })) as never);
    const inFlight = refresh();
    await tick();

    toggleDir('dist', true, true);
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
    toggleDir('node_modules', true, true);
    await tick();
    expect(S.ignored).toContain('node_modules/keep.js');

    // force-added from a terminal: git lists it now, the directory on disk still holds it
    g.listFiles!.mockResolvedValue({ files: ['a.txt', 'node_modules/keep.js'], ignored: ['node_modules/'], empty: [] });
    await refresh();
    expect(S.files).toContain('node_modules/keep.js');
    expect(S.ignored).not.toContain('node_modules/keep.js');
  });

  it('stops re-reading a directory once it is collapsed', async () => {
    g.listDir!.mockResolvedValue(['node_modules/x.js']);
    await filesTab();
    toggleDir('node_modules', true, true);
    await tick();

    toggleDir('node_modules', false);
    g.listDir!.mockClear();
    await refresh();
    expect(g.listDir!).not.toHaveBeenCalled();
    expect(S.ignored).toEqual(['node_modules/']);
  });
});

describe('the Files tree follows the open file', () => {
  it('expands every directory above a file it opens, and closes one on demand', async () => {
    g.readFile!.mockResolvedValue(file('x\n'));
    await openPlain('src/app/api/q.ts');

    expect([...S.filesOpen]).toEqual(['src', 'src/app', 'src/app/api']);
    expect(S.selected).toBe('plain:src/app/api/q.ts');

    S.filesOpen.add('docs');
    toggleDir('docs', false);
    expect(S.filesOpen.has('docs')).toBe(false);
  });
});

describe('creating from a folder in the Files tree', () => {
  beforeEach(() => {
    S.filesOpen = new Set();
    S.toasts = [];
  });

  it('writes an empty new file, makes the folders a slash names, expands them and opens the file', async () => {
    promptMock.mockResolvedValue(' lib/util.ts ');
    g.readFile!.mockResolvedValue(file(''));
    await create('src', 'file');

    expect(g.writeFile!).toHaveBeenCalledExactlyOnceWith('src/lib/util.ts', '', 'lf', null);
    expect([...S.filesOpen]).toEqual(expect.arrayContaining(['src', 'src/lib']));
    expect(S.open?.path).toBe('src/lib/util.ts');
  });

  it('makes a folder and expands it, and opens nothing', async () => {
    promptMock.mockResolvedValue('a/b/');
    await create('src', 'folder');

    expect(g.createDir!).toHaveBeenCalledExactlyOnceWith('src/a/b');
    expect([...S.filesOpen]).toEqual(['src', 'src/a', 'src/a/b']);
    expect(S.open).toBeNull();
  });

  it('drops . and empty segments from the name, as the backend does, so the file opens at its path', async () => {
    promptMock.mockResolvedValue('./a//b.ts');
    g.readFile!.mockResolvedValue(file(''));
    await create('src', 'file');
    expect(g.writeFile!).toHaveBeenCalledExactlyOnceWith('src/a/b.ts', '', 'lf', null);
    expect(S.open?.path).toBe('src/a/b.ts');
  });

  it('reads an ignored folder and each new folder under it again, so the new one shows', async () => {
    S.ignoredBase = ['node_modules/'];
    S.ignored = ['node_modules/'];
    S.ignoredKids = new Map();
    g.listDir!.mockImplementation((d: string) =>
      Promise.resolve({ node_modules: ['node_modules/a/'], 'node_modules/a': ['node_modules/a/b/'] }[d] ?? []));
    promptMock.mockResolvedValue('a/b');
    await create('node_modules', 'folder');

    expect(g.listDir!.mock.calls).toEqual([['node_modules'], ['node_modules/a'], ['node_modules/a/b']]);
    expect(S.ignored).toContain('node_modules/a/b/');
    S.ignoredBase = []; S.ignored = []; S.ignoredKids = new Map();
  });

  it('says the name is taken for a folder at the file name, and creates nothing after a repo switch', async () => {
    promptMock.mockResolvedValue('a');
    g.writeFile!.mockRejectedValue({ kind: 'Special' });
    await create('src', 'file');
    expect(S.toasts.map((t) => t.message)).toEqual(['src/a already exists']);

    const root = S.root;
    promptMock.mockImplementation(() => { S.root = '/other'; return Promise.resolve('b'); });
    await create('src', 'folder');
    expect(g.createDir!).not.toHaveBeenCalled();
    S.root = root;
  });

  it('says the name is taken when the file is already there, and does nothing on a cancelled prompt', async () => {
    promptMock.mockResolvedValue('a.txt');
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('x\n') });
    await create('src', 'file');
    expect(S.toasts.map((t) => t.message)).toEqual(['src/a.txt already exists']);
    expect(S.open).toBeNull();

    promptMock.mockResolvedValue(null);
    await create('src', 'folder');
    expect(g.createDir!).not.toHaveBeenCalled();
  });
});
