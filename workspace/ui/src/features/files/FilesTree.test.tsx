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
    const dir = (p: string) => side.querySelector<HTMLElement>(`details[data-dir="${p}"]`)!;

    expect(row('.env').classList.contains('ignored')).toBe(true);
    expect(row('.env').getAttribute('role')).toBe('button');
    expect(row('README.md').classList.contains('ignored')).toBe(false);

    expect(dir('node_modules').querySelector('summary')!.classList.contains('ignored')).toBe(true);
    expect(dir('src').querySelector('summary')!.classList.contains('ignored')).toBe(false);
    // an ignored directory nested under a listed one still lands inside it
    expect(dir('src/gen').parentElement).toBe(dir('src'));
  });

  it('Files tab shows each changed file\'s git letter and a roll-up dot on the folders above it', async () => {
    S.status = {
      head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0,
      files: [
        { path: 'src/app/a.ts', indexStatus: '.', worktreeStatus: 'M', untracked: false, conflicted: false },
        { path: 'README.md', indexStatus: 'A', worktreeStatus: '.', untracked: false, conflicted: false },
      ],
    };
    await renderFiles(['src/app/a.ts', 'src/b.ts', 'README.md'], null, ['src', 'src/app']);
    const row = (p: string) => side.querySelector<HTMLElement>(`[data-key="plain:${p}"]`)!;
    const dot = (p: string) => side.querySelector<HTMLElement>(`details[data-dir="${p}"] > summary .st-dot`);

    expect(row('src/app/a.ts').querySelector('.st')!.textContent).toBe('M');
    expect(row('src/app/a.ts').dataset.st).toBe('M');
    expect(row('README.md').querySelector('.st')!.textContent).toBe('A');
    expect(row('src/b.ts').querySelector('.st')).toBeNull();
    expect([dot('src')?.dataset.st, dot('src/app')?.dataset.st]).toEqual(['M', 'M']);
    expect(dot('src')!.textContent).toBe('Contains changes');
  });

  it('opening a directory git collapsed asks for its contents, an already listed one does not', async () => {
    await renderFiles(['src/a.ts'], null, [], ['node_modules/']);
    const toggle = (p: string) => {
      const d = side.querySelector<HTMLDetailsElement>(`details[data-dir="${p}"]`)!;
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    };

    toggle('node_modules');
    expect(h.toggleDir!).toHaveBeenCalledWith('node_modules', true, true);
    toggle('src');
    expect(h.toggleDir!).toHaveBeenCalledWith('src', true, false);

    // once it has been read, an ignored directory is not asked for again, empty or not
    S.ignoredKids = new Map([['node_modules', []]]);
    await renderFiles(['src/a.ts'], null, [], ['node_modules/']);
    toggle('node_modules');
    expect(h.toggleDir!).toHaveBeenLastCalledWith('node_modules', true, false);

    // a subdirectory of one already read arrives collapsed in turn, and reads on its own open.
    // React runs the parent's onToggle too, so this asserts the call rather than the last call
    S.ignoredKids = new Map([['node_modules', ['node_modules/pkg/']]]);
    await renderFiles(['src/a.ts'], null, ['node_modules'], ['node_modules/', 'node_modules/pkg/']);
    h.toggleDir!.mockClear();
    toggle('node_modules/pkg');
    expect(h.toggleDir!).toHaveBeenCalledWith('node_modules/pkg', true, true);
    expect(h.toggleDir!.mock.calls.filter(([p]) => p === 'node_modules')).toEqual([['node_modules', true, false]]);
  });

  it('Files tab nests a directory per segment and indents by depth', async () => {
    await renderFiles(['src/app/a.ts', 'README.md'], null, ['src', 'src/app']);
    const dirs = [...side.querySelectorAll<HTMLDetailsElement>('details[data-dir]')];
    expect(dirs.map((d) => d.dataset.dir)).toEqual(['src', 'src/app']);
    expect(dirs[1]!.parentElement).toBe(dirs[0]!);
    expect(dirs.map((d) => d.querySelector<HTMLElement>('summary')!.style.getPropertyValue('--depth')))
      .toEqual(['0', '1']);
    const deep = side.querySelector<HTMLElement>('[data-key="plain:src/app/a.ts"]')!;
    expect(deep.style.getPropertyValue('--depth')).toBe('2');
    expect(side.querySelector<HTMLElement>('[data-key="plain:README.md"]')!
      .style.getPropertyValue('--depth')).toBe('0');
  });

  it('renders nothing below a collapsed directory, and the whole subtree once it is open', async () => {
    await renderFiles(['src/app/a.ts', 'src/app/b.ts', 'README.md']);
    expect([...side.querySelectorAll('details[data-dir]')].map((d) => (d as HTMLElement).dataset.dir)).toEqual(['src']);
    expect(side.querySelectorAll('.row.f').length).toBe(1);

    side.querySelector<HTMLElement>('details[data-dir="src"] > summary')!.click();
    await tick();
    expect(h.toggleDir).toHaveBeenCalledWith('src', true, false);

    await renderFiles(['src/app/a.ts', 'src/app/b.ts', 'README.md'], null, ['src', 'src/app']);
    expect(side.querySelectorAll('.row.f').length).toBe(3);
  });

  it('marks the open file and scrolls it into view, whichever view opened it', async () => {
    const seen: Element[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) { seen.push(this); });
    // S.selected is the Changes-view key, so only S.open.path can mark the row here
    S.selected = 'unstaged:src/app/a.ts';
    await renderFiles(['src/app/a.ts', 'README.md'], 'src/app/a.ts', ['src', 'src/app']);
    const sel = [...side.querySelectorAll<HTMLElement>('.row.f.sel')];
    expect(sel.map((r) => r.dataset.path)).toEqual(['src/app/a.ts']);
    expect((seen.at(-1) as HTMLElement | undefined)?.dataset.path).toBe('src/app/a.ts');
    spy.mockRestore();
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
    expect(await open('summary.sec.d')).toEqual([]);
    const items = await open('.row.f');
    expect(items.map((i) => i.textContent)).toEqual(['Copy relative path']);
    items[0]!.click();
    expect(h.copyPath).toHaveBeenCalledExactlyOnceWith('src/a.ts');
  });
});
