import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '#test-setup';

vi.mock('./files', async () => ({ ...(await vi.importActual<object>('./files')), toggleDir: vi.fn() }));
vi.mock('#core/session', () => ({ openRow: vi.fn(), openPlain: vi.fn() }));
vi.mock('#kernel/clipboard', () => {
  const copyPath = vi.fn();
  return {
    copyPath, copyItem: (path: string) => ({ label: 'Copy relative path', onSelect: () => void copyPath(path) }),
  };
});

const { S, notify } = await import('#kernel/store');
const { Sidebar } = await import('#app/Sidebar');
const h = {
  toggleDir: (await import('./files')).toggleDir, openPlain: (await import('#core/session')).openPlain,
  copyPath: (await import('#kernel/clipboard')).copyPath,
} as unknown as Record<string, ReturnType<typeof vi.fn>>;

let root: Root;
let side: HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  document.body.innerHTML = '<div id="host"></div>';
  S.status = null; S.files = []; S.tab = 'changes'; S.selected = null; S.open = null;
  S.filesOpen = new Set(); S.aiBusy = false; S.committing = false; S.commitMessage = ''; S.ignored = [];
  S.ignoredKids = new Map(); S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<Sidebar />));
  side = document.querySelector<HTMLElement>('.side')!;
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

const openFile = (path: string) => ({
  path, view: 'plain', eol: 'lf', baseline: null, originalOid: null, originalExists: false,
  docOid: null, dirty: false, badge: null, panel: null, conflicted: false,
}) as NonNullable<typeof S.open>;

async function renderFiles(
  files: string[], active: string | null = null, open: string[] = [], ignored: string[] = [],
): Promise<void> {
  S.files = files;
  S.ignored = ignored;
  S.open = active ? openFile(active) : null;
  S.filesOpen = new Set(open);
  S.tab = 'files';
  notify();
  await tick();
}

describe('row layout', () => {
  it('Files tab rows wrap the name in .name', async () => {
    await renderFiles(['src/a.ts'], null, ['src']);
    expect(side.querySelector('.row.f .path .name')!.textContent).toBe('a.ts');
  });

  it('Files tab lists an ignored file dimmed and an ignored directory as a dimmed directory', async () => {
    await renderFiles(['README.md', 'src/a.ts'], null, ['src'], ['.env', 'node_modules/', 'src/gen/']);
    const row = (p: string) => side.querySelector<HTMLElement>(`[data-key="plain:${p}"]`)!;
    const dir = (p: string) => side.querySelector<HTMLElement>(`[data-dir="${p}"]`)!;

    expect(row('.env').classList.contains('ignored')).toBe(true);
    expect(row('.env').getAttribute('role')).toBe('treeitem');
    expect(row('README.md').classList.contains('ignored')).toBe(false);

    expect(dir('node_modules').classList.contains('ignored')).toBe(true);
    expect(dir('src').classList.contains('ignored')).toBe(false);
    // an ignored directory nested under a listed one still lands inside it
    expect(dir('src').nextElementSibling).toBe(dir('src/gen'));
    expect(dir('src/gen').style.getPropertyValue('--depth')).toBe('1');
  });

  it('Files tab shows each changed file\'s git letter and a roll-up dot on the folders above it', async () => {
    S.status = {
      head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, stash: 0,
      files: [
        { path: 'src/app/a.ts', indexStatus: '.', worktreeStatus: 'M', untracked: false, conflicted: false },
        { path: 'README.md', indexStatus: 'A', worktreeStatus: '.', untracked: false, conflicted: false },
      ],
    };
    await renderFiles(['src/app/a.ts', 'src/b.ts', 'README.md'], null, ['src', 'src/app']);
    const row = (p: string) => side.querySelector<HTMLElement>(`[data-key="plain:${p}"]`)!;
    const dot = (p: string) => side.querySelector<HTMLElement>(`[data-dir="${p}"] .st-dot`);

    expect(row('src/app/a.ts').querySelector('.st')!.textContent).toBe('M');
    expect(row('src/app/a.ts').dataset.st).toBe('M');
    expect(row('README.md').querySelector('.st')!.textContent).toBe('A');
    expect(row('src/b.ts').querySelector('.st')).toBeNull();
    expect([dot('src')?.dataset.st, dot('src/app')?.dataset.st]).toEqual(['M', 'M']);
    expect(dot('src')!.textContent).toBe('Contains changes');
  });

  it('opening a directory git collapsed asks for its contents, an already listed one does not', async () => {
    await renderFiles(['src/a.ts'], null, [], ['node_modules/']);
    const toggle = (p: string) => side.querySelector<HTMLElement>(`[data-dir="${p}"]`)!.click();

    toggle('node_modules');
    expect(h.toggleDir!).toHaveBeenCalledWith('node_modules', true, true);
    toggle('src');
    expect(h.toggleDir!).toHaveBeenCalledWith('src', true, false);

    // once it has been read, an ignored directory is not asked for again, empty or not
    S.ignoredKids = new Map([['node_modules', []]]);
    await renderFiles(['src/a.ts'], null, [], ['node_modules/']);
    toggle('node_modules');
    expect(h.toggleDir!).toHaveBeenLastCalledWith('node_modules', true, false);

    // a subdirectory of one already read arrives collapsed in turn, and reads on its own open
    S.ignoredKids = new Map([['node_modules', ['node_modules/pkg/']]]);
    await renderFiles(['src/a.ts'], null, ['node_modules'], ['node_modules/', 'node_modules/pkg/']);
    h.toggleDir!.mockClear();
    toggle('node_modules/pkg');
    expect(h.toggleDir!.mock.calls).toEqual([['node_modules/pkg', true, true]]);

    // an open one closes
    toggle('node_modules');
    expect(h.toggleDir!).toHaveBeenLastCalledWith('node_modules', false, false);
  });

  it('Files tab nests a directory per segment and indents by depth', async () => {
    await renderFiles(['src/app/a.ts', 'README.md'], null, ['src', 'src/app']);
    const dirs = [...side.querySelectorAll<HTMLElement>('[data-dir]')];
    expect(dirs.map((d) => d.dataset.dir)).toEqual(['src', 'src/app']);
    expect(dirs.map((d) => d.style.getPropertyValue('--depth'))).toEqual(['0', '1']);
    expect(dirs.map((d) => d.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    const deep = side.querySelector<HTMLElement>('[data-key="plain:src/app/a.ts"]')!;
    expect(deep.style.getPropertyValue('--depth')).toBe('2');
    expect(side.querySelector<HTMLElement>('[data-key="plain:README.md"]')!
      .style.getPropertyValue('--depth')).toBe('0');
  });

  it('renders nothing below a collapsed directory, and the whole subtree once it is open', async () => {
    await renderFiles(['src/app/a.ts', 'src/app/b.ts', 'README.md']);
    expect([...side.querySelectorAll<HTMLElement>('[data-dir]')].map((d) => d.dataset.dir)).toEqual(['src']);
    expect(side.querySelectorAll('.row.f').length).toBe(1);

    side.querySelector<HTMLElement>('[data-dir="src"]')!.click();
    await tick();
    expect(h.toggleDir).toHaveBeenCalledWith('src', true, false);

    await renderFiles(['src/app/a.ts', 'src/app/b.ts', 'README.md'], null, ['src', 'src/app']);
    expect(side.querySelectorAll('.row.f').length).toBe(3);
  });

  it('marks the open file, whichever view opened it', async () => {
    // S.selected is the Changes-view key, so only S.open.path can mark the row here
    S.selected = 'unstaged:src/app/a.ts';
    await renderFiles(['src/app/a.ts', 'README.md'], 'src/app/a.ts', ['src', 'src/app']);
    const sel = [...side.querySelectorAll<HTMLElement>('.row.f.sel')];
    expect(sel.map((r) => r.dataset.path)).toEqual(['src/app/a.ts']);
  });

  it('draws only the rows in view of a folder as long as a monorepo package', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `pkg/f${String(i).padStart(4, '0')}.ts`);
    await renderFiles(many, null, ['pkg']);
    const rows = side.querySelectorAll('.row.f').length;
    expect(rows).toBeGreaterThan(10);
    expect(rows).toBeLessThan(100);
  });

  it('walks folders and files with the arrows; Enter, Right and Left fold a folder or step in and out', async () => {
    // rows: a, a/x.ts, b, b/y.ts, z.ts
    await renderFiles(['a/x.ts', 'b/y.ts', 'z.ts'], 'a/x.ts', ['a', 'b']);
    const list = side.querySelector<HTMLElement>('.list')!;
    const press = async (key: string) => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await tick();
    };
    const cur = () => side.querySelector<HTMLElement>('.cur')!.textContent;
    await press('ArrowDown');
    expect([cur(), h.openPlain!.mock.calls.length]).toEqual(['b', 0]);
    await press('ArrowDown');
    expect(h.openPlain).toHaveBeenLastCalledWith('b/y.ts');
    await press('ArrowLeft');
    expect(cur()).toBe('b');
    await press('ArrowLeft');
    expect(h.toggleDir).toHaveBeenLastCalledWith('b', false, false);
    await press('ArrowUp');
    await press('ArrowUp');
    expect(cur()).toBe('a');
    await press('Enter');
    expect(h.toggleDir).toHaveBeenLastCalledWith('a', false, false);
    await press('ArrowRight');
    expect(h.openPlain).toHaveBeenLastCalledWith('a/x.ts');
  });

  it('Right on an open folder with nothing listed in it stays there, not on the file after it', async () => {
    await renderFiles(['z.ts'], null, ['node_modules'], ['node_modules/']);
    const list = side.querySelector<HTMLElement>('.list')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await tick();
    expect(h.openPlain).not.toHaveBeenCalled();
    expect(side.querySelector('.cur')!.getAttribute('data-dir')).toBe('node_modules');
  });

  it('opens a closed folder with Right', async () => {
    await renderFiles(['a/x.ts'], null, []);
    const list = side.querySelector<HTMLElement>('.list')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(h.toggleDir).toHaveBeenLastCalledWith('a', true, false);
  });
});

describe('context menu', () => {
  const open = async (sel: string) => {
    side.querySelector<HTMLElement>(sel)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    return [...document.querySelectorAll<HTMLElement>('.menu-item')];
  };

  it('a file row in the Files tree offers Copy relative path, and a directory row offers nothing', async () => {
    await renderFiles(['src/a.ts'], null, ['src']);
    expect(await open('.sec.d')).toEqual([]);
    const items = await open('.row.f');
    expect(items.map((i) => i.textContent)).toEqual(['Copy relative path']);
    items[0]!.click();
    expect(h.copyPath).toHaveBeenCalledExactlyOnceWith('src/a.ts');
  });
});
