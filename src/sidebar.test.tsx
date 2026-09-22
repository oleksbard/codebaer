import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from './test-setup';
import type { FileEntry, Status } from './git';
import type { Row } from './model';

vi.mock('./app/controller', () => ({
  openRow: vi.fn(), openPlain: vi.fn(), acceptFile: vi.fn(), rejectFile: vi.fn(), unstageFile: vi.fn(),
  stageAll: vi.fn(), unstageAll: vi.fn(), commit: vi.fn(), aiMessage: vi.fn(), setTab: vi.fn(), toggleDir: vi.fn(),
}));

const c = await import('./app/controller');
const { S, notify } = await import('./app/store');
const { Sidebar } = await import('./app/Sidebar');
const h = c as unknown as Record<string, ReturnType<typeof vi.fn>>;

const row = (path: string, letter: string, section: Row['section'] = 'unstaged', extra: Partial<Row> = {}): Row =>
  ({ section, path, letter, untracked: false, conflicted: false, ...extra });

/** Builds the Status whose buildQueue() yields exactly these rows. */
function statusFor(unstaged: Row[], staged: Row[]): Status {
  const files = new Map<string, FileEntry>();
  const get = (p: string) => files.get(p) ?? files.set(p, { path: p, indexStatus: '.', worktreeStatus: '.', untracked: false, conflicted: false }).get(p)!;
  for (const r of unstaged) {
    const f = get(r.path);
    if (r.conflicted) f.conflicted = true;
    else if (r.untracked) f.untracked = true;
    else f.worktreeStatus = r.letter;
  }
  for (const r of staged) get(r.path).indexStatus = r.letter;
  return { head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, files: [...files.values()] };
}

let root: Root;
let side: HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  document.body.innerHTML = '<div id="host"></div>';
  S.status = null; S.files = []; S.tab = 'changes'; S.selected = null; S.open = null; S.filesOpen = new Set(); S.aiBusy = false; S.committing = false; S.commitMessage = '';
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<Sidebar />));
  side = document.querySelector<HTMLElement>('.side')!;
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

async function render(unstaged: Row[], staged: Row[] = [], selected: string | null = null): Promise<void> {
  S.status = statusFor(unstaged, staged);
  S.selected = selected;
  S.tab = 'changes';
  notify();
  await tick();
}

const openFile = (path: string) => ({
  path, view: 'plain', eol: 'lf', baseline: null, originalOid: null, originalExists: false,
  docOid: null, dirty: false, badge: null, panel: null, conflicted: false,
}) as NonNullable<typeof S.open>;

async function renderFiles(files: string[], active: string | null = null, open: string[] = []): Promise<void> {
  S.files = files;
  S.open = active ? openFile(active) : null;
  S.filesOpen = new Set(open);
  S.tab = 'files';
  notify();
  await tick();
}

const details = (sec: 'unstaged' | 'staged') => side.querySelector<HTMLDetailsElement>(`details[data-sec="${sec}"]`)!;

describe('row layout', () => {
  it('shows the name first, the directory without its slash, and the letter last', async () => {
    await render([row('src/lib/auth/login.ts', 'M')]);
    const r = side.querySelector<HTMLElement>('.row')!;
    expect(r.querySelector('.path .name')!.textContent).toBe('login.ts');
    expect(r.querySelector('.path .dir')!.textContent).toBe('src/lib/auth');
    expect(r.querySelector('.tail > :last-child')!.className).toBe('st');
    expect(r.querySelector('.st')!.textContent).toBe('M');
    expect(r.dataset.st).toBe('M');
    expect(r.title).toBe('src/lib/auth/login.ts');
  });

  it('a root-level file has an empty directory span', async () => {
    await render([row('README.md', 'U', 'unstaged', { untracked: true })]);
    expect(side.querySelector('.path .dir')!.textContent).toBe('');
    expect(side.querySelector<HTMLElement>('.row')!.dataset.st).toBe('U');
  });

  it('a conflicted row keeps its badge before the actions and the letter', async () => {
    await render([row('x.ts', '!', 'unstaged', { conflicted: true })]);
    const tail = side.querySelector('.tail')!;
    expect([...tail.children].map((ch) => ch.className.split(' ')[0])).toEqual(['badge', 'acts', 'st']);
    expect(tail.querySelector('.st')!.textContent).toBe('!');
  });

  it('Files tab rows wrap the name in .name', async () => {
    await renderFiles(['src/a.ts'], null, ['src']);
    expect(side.querySelector('.row.f .path .name')!.textContent).toBe('a.ts');
  });

  it('Files tab nests a directory per segment and indents by depth', async () => {
    await renderFiles(['src/app/a.ts', 'README.md'], null, ['src', 'src/app']);
    const dirs = [...side.querySelectorAll<HTMLDetailsElement>('details[data-dir]')];
    expect(dirs.map((d) => d.dataset.dir)).toEqual(['src', 'src/app']);
    expect(dirs[1]!.parentElement).toBe(dirs[0]!);
    expect(dirs.map((d) => d.querySelector<HTMLElement>('summary')!.style.getPropertyValue('--depth'))).toEqual(['0', '1']);
    const deep = side.querySelector<HTMLElement>('[data-key="plain:src/app/a.ts"]')!;
    expect(deep.style.getPropertyValue('--depth')).toBe('2');
    expect(side.querySelector<HTMLElement>('[data-key="plain:README.md"]')!.style.getPropertyValue('--depth')).toBe('0');
  });

  it('renders nothing below a collapsed directory, and the whole subtree once it is open', async () => {
    await renderFiles(['src/app/a.ts', 'src/app/b.ts', 'README.md']);
    expect([...side.querySelectorAll('details[data-dir]')].map((d) => (d as HTMLElement).dataset.dir)).toEqual(['src']);
    expect(side.querySelectorAll('.row.f').length).toBe(1);

    side.querySelector<HTMLElement>('details[data-dir="src"] > summary')!.click();
    await tick();
    expect(h.toggleDir).toHaveBeenCalledWith('src', true);

    await renderFiles(['src/app/a.ts', 'src/app/b.ts', 'README.md'], null, ['src', 'src/app']);
    expect(side.querySelectorAll('.row.f').length).toBe(3);
  });

  it('marks the open file and scrolls it into view, whichever view opened it', async () => {
    const seen: Element[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { seen.push(this); });
    // S.selected is the Changes-view key, so only S.open.path can mark the row here
    S.selected = 'unstaged:src/app/a.ts';
    await renderFiles(['src/app/a.ts', 'README.md'], 'src/app/a.ts', ['src', 'src/app']);
    const sel = [...side.querySelectorAll<HTMLElement>('.row.f.sel')];
    expect(sel.map((r) => r.dataset.path)).toEqual(['src/app/a.ts']);
    expect((seen.at(-1) as HTMLElement | undefined)?.dataset.path).toBe('src/app/a.ts');
    spy.mockRestore();
  });

  it('a path with quotes and angle brackets renders as text in the name, the directory, the title and the key', async () => {
    await render([row('a "b"/c&d<e>.ts', 'M')]);
    const r = side.querySelector<HTMLElement>('.row')!;
    expect(r.querySelector('.path .name')!.textContent).toBe('c&d<e>.ts');
    expect(r.querySelector('.path .dir')!.textContent).toBe('a "b"');
    expect(r.title).toBe('a "b"/c&d<e>.ts');
    expect(r.dataset.key).toBe('unstaged:a "b"/c&d<e>.ts');
  });

  it('clicking a row opens it; clicking its hover actions stages or discards without opening', async () => {
    await render([row('a.ts', 'M')]);
    side.querySelector<HTMLElement>('.row')!.click();
    expect(h.openRow).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', section: 'unstaged' }));
    side.querySelector<HTMLElement>('[data-act="stage"]')!.click();
    side.querySelector<HTMLElement>('[data-act="revert"]')!.click();
    expect(h.acceptFile).toHaveBeenCalledWith('a.ts');
    expect(h.rejectFile).toHaveBeenCalledWith('a.ts');
    expect(h.openRow).toHaveBeenCalledTimes(1);
  });
});

describe('sections', () => {
  it('renders both sections open with counts', async () => {
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    const secs = [...side.querySelectorAll<HTMLDetailsElement>('details[data-sec]')];
    expect(secs.map((d) => d.dataset.sec)).toEqual(['unstaged', 'staged']);
    expect(secs.map((d) => d.open)).toEqual([true, true]);
    expect([...side.querySelectorAll('summary.sec .n')].map((n) => n.textContent)).toEqual(['1', '1']);
    expect(side.querySelector('summary.sec .l')!.textContent).toBe('Changes');
  });

  it('keeps a collapsed section collapsed across re-renders and a Files tab visit', async () => {
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    details('staged').open = false;
    await tick();
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    expect(details('staged').open).toBe(false);
    expect(details('unstaged').open).toBe(true);
    await renderFiles(['x.ts']);
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    expect(details('staged').open).toBe(false);
  });

  it('the stage-all button runs its handler and cancels the click default', async () => {
    await render([row('a', 'M')]);
    const btn = side.querySelector<HTMLButtonElement>('[data-all="stage"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(h.stageAll).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('arrow keys skip rows inside a collapsed section', async () => {
    const list = () => side.querySelector<HTMLElement>('.list')!;
    const down = () => list().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await render([row('a', 'M')], [row('b', 'M', 'staged')], 'unstaged:a');
    down();
    expect(h.openRow).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b', section: 'staged' }));

    details('staged').open = false;
    await tick();
    await render([row('a', 'M')], [row('b', 'M', 'staged')], 'unstaged:a');
    h.openRow!.mockClear();
    down();
    expect(h.openRow).toHaveBeenCalledTimes(1);
    expect(h.openRow).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'a' }));
  });

  it('the empty-section text lives inside its details so collapsing hides it', async () => {
    await render([], []);
    expect(details('unstaged').querySelector('.empty-sec')!.textContent).toBe('Nothing left to review');
    expect(details('staged').querySelector('.empty-sec')!.textContent).toBe('Accepted hunks land here');
  });

  it('Enter does nothing while the selected row is inside a collapsed section', async () => {
    await render([row('a', 'M')], [], 'unstaged:a');
    details('unstaged').open = false;
    await tick();
    await render([row('a', 'M')], [], 'unstaged:a');
    side.querySelector<HTMLElement>('.list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.openRow).not.toHaveBeenCalled();
  });

  it('Enter on a focused header button does not reach the list handler', async () => {
    await render([row('a', 'M')], [], 'unstaged:a');
    side.querySelector<HTMLButtonElement>('[data-all="stage"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.openRow).not.toHaveBeenCalled();
  });
});

describe('context menu', () => {
  const open = async (sel: string) => {
    side.querySelector<HTMLElement>(sel)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    return [...document.querySelectorAll<HTMLElement>('.menu-item')];
  };

  it('an unstaged row offers Stage file, Discard changes, Open file', async () => {
    await render([row('a.ts', 'M')]);
    const items = await open('.row');
    expect(items.map((i) => i.textContent)).toEqual(['Stage file', 'Discard changes', 'Open file']);
    items[1]!.click();
    expect(h.rejectFile).toHaveBeenCalledWith('a.ts');
  });

  it('a staged row offers Unstage file, Open file', async () => {
    await render([], [row('b.ts', 'M', 'staged')]);
    const items = await open('.row');
    expect(items.map((i) => i.textContent)).toEqual(['Unstage file', 'Open file']);
    items[1]!.click();
    expect(h.openPlain).toHaveBeenCalledWith('b.ts');
  });

  it('a conflicted row offers Mark resolved, Open file', async () => {
    await render([row('c.ts', '!', 'unstaged', { conflicted: true })]);
    const items = await open('.row');
    expect(items.map((i) => i.textContent)).toEqual(['Mark resolved', 'Open file']);
    items[0]!.click();
    expect(h.acceptFile).toHaveBeenCalledWith('c.ts');
  });
});

describe('commit button', () => {
  const btn = () => side.querySelector<HTMLButtonElement>('#commit-btn')!;

  it('stays disabled until the message box holds more than whitespace', async () => {
    await render([], [row('a.ts', 'M', 'staged')]);
    expect(btn().disabled).toBe(true);
    S.commitMessage = '   '; notify(); await tick();
    expect(btn().disabled).toBe(true);
    S.commitMessage = 'Fix the thing'; notify(); await tick();
    expect(btn().disabled).toBe(false);
  });

  it('swaps to a spinner while committing and refuses a second click', async () => {
    await render([], [row('a.ts', 'M', 'staged')]);
    S.commitMessage = 'Fix the thing'; notify(); await tick();
    expect(btn().textContent).toBe('Commit ⌘↩');
    expect(btn().disabled).toBe(false);

    S.committing = true; notify(); await tick();
    expect(btn().disabled).toBe(true);
    expect(btn().classList.contains('busy')).toBe(true);
    expect(btn().textContent).toBe('Committing…');
    expect(btn().querySelector('.spinner')).not.toBeNull();

    S.committing = false; notify(); await tick();
    expect(btn().textContent).toBe('Commit ⌘↩');
    expect(btn().disabled).toBe(false);
  });
});

describe('AI commit message button', () => {
  const btn = () => side.querySelector<HTMLButtonElement>('#ai-btn')!;

  it('is disabled with nothing staged and enabled once something is', async () => {
    await render([]);
    expect(btn().disabled).toBe(true);
    await render([], [row('a.ts', 'M', 'staged')]);
    expect(btn().disabled).toBe(false);
  });

  it('click asks for a message, busy disables it, the store fills the box', async () => {
    await render([], [row('a.ts', 'M', 'staged')]);
    btn().click();
    expect(h.aiMessage).toHaveBeenCalledTimes(1);
    S.aiBusy = true; notify(); await tick();
    expect(btn().disabled).toBe(true);
    expect(btn().classList.contains('busy')).toBe(true);
    S.aiBusy = false; notify(); await tick();
    expect(btn().disabled).toBe(false);
    expect(btn().classList.contains('busy')).toBe(false);
    S.commitMessage = 'Fix the thing'; notify(); await tick();
    expect(side.querySelector<HTMLTextAreaElement>('#commit-message')!.value).toBe('Fix the thing');
  });
});
