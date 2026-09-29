import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '#test-setup';
import { headerItem } from '#test-app';
import type { FileEntry, Status } from '#ipc/git';
import type { Row } from '#core/model';

vi.mock('#core/session', () => ({ openRow: vi.fn(), openPlain: vi.fn() }));
vi.mock('./hunks', async () => ({
  ...(await vi.importActual<object>('./hunks')),
  acceptFile: vi.fn(), rejectFile: vi.fn(), unstageFile: vi.fn(), stageAll: vi.fn(), unstageAll: vi.fn(),
  discardAll: vi.fn(),
}));
vi.mock('#features/git-ops', async () => ({
  ...(await vi.importActual<object>('#features/git-ops')), stash: vi.fn(), unstash: vi.fn(),
}));
vi.mock('#kernel/clipboard', () => {
  const copyPath = vi.fn();
  return {
    copyPath, copyItem: (path: string) => ({ label: 'Copy relative path', onSelect: () => void copyPath(path) }),
  };
});

const { S, notify } = await import('#kernel/store');
const { Sidebar } = await import('#app/Sidebar');
const session = await import('#core/session');
const hunks = await import('./hunks');
const ops = await import('#features/git-ops');
const h = {
  openRow: session.openRow, openPlain: session.openPlain, acceptFile: hunks.acceptFile, rejectFile: hunks.rejectFile,
  unstageFile: hunks.unstageFile, stageAll: hunks.stageAll, unstageAll: hunks.unstageAll, discardAll: hunks.discardAll,
  copyPath: (await import('#kernel/clipboard')).copyPath, stash: ops.stash, unstash: ops.unstash,
} as unknown as Record<string, ReturnType<typeof vi.fn>>;

const row = (path: string, letter: string, section: Row['section'] = 'unstaged', extra: Partial<Row> = {}): Row =>
  ({ section, path, letter, untracked: false, conflicted: false, ...extra });

/** Builds the Status whose buildQueue() yields exactly these rows. */
function statusFor(unstaged: Row[], staged: Row[]): Status {
  const files = new Map<string, FileEntry>();
  const blank = { indexStatus: '.', worktreeStatus: '.', untracked: false, conflicted: false } as const;
  const get = (p: string) => files.get(p) ?? files.set(p, { path: p, ...blank }).get(p)!;
  for (const r of unstaged) {
    const f = get(r.path);
    if (r.conflicted) f.conflicted = true;
    else if (r.untracked) f.untracked = true;
    else f.worktreeStatus = r.letter;
  }
  for (const r of staged) get(r.path).indexStatus = r.letter;
  return { head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, stash: 0, files: [...files.values()] };
}

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

  it('a path with quotes and angle brackets renders as text in the name, the directory, the title and the key',
    async () => {
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
  it('renders both sections open with the count right after the label', async () => {
    await render([row('a', 'M'), row('c', 'M')], [row('b', 'M', 'staged')]);
    const secs = [...side.querySelectorAll<HTMLDetailsElement>('details[data-sec]')];
    expect(secs.map((d) => d.dataset.sec)).toEqual(['unstaged', 'staged']);
    expect(secs.map((d) => d.open)).toEqual([true, true]);
    expect([...side.querySelectorAll('summary.sec .l')].map((l) => l.textContent)).toEqual(['Changes2', 'Staged1']);
    expect(side.querySelector('summary.sec .l > .n')!.textContent).toBe('2');
  });

  it('shows no count for an empty section', async () => {
    await render([row('a', 'M')], []);
    expect(details('unstaged').querySelector('summary .n')!.textContent).toBe('1');
    expect(details('staged').querySelector('summary .n')).toBe(null);
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

  const withStashes = async (n: number) => {
    S.status = { ...S.status!, stash: n };
    notify();
    await tick();
  };
  const menuItems = () => [...document.querySelectorAll('.queue-menu > *')]
    .map((i) => (i.classList.contains('menu-sep') ? '-' : i.textContent));
  /** The header's buttons: the menu's or the one action's own, then Stage all's. */
  const headerButtons = (sec: 'unstaged' | 'staged') =>
    [...details(sec).querySelectorAll<HTMLElement>('summary [data-all]')].map((b) => b.dataset.all);

  it('lists the available header actions in a menu, whose button does not fold the section', async () => {
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    await withStashes(2);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    details('unstaged').querySelector('[data-all="menu"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await headerItem('unstaged', 'show');
    expect(menuItems()).toEqual(['Review all changes⌘⇧A', 'Discard all changes', '-', 'Stash changes', 'Unstash…']);
    await headerItem('staged', 'unstage');
    expect(menuItems()).toEqual(['Unstage all changes', 'Stash staged changes']);
  });

  it('keeps Stage all out of the menu, as a button after it while there is something to stage', async () => {
    await render([row('a', 'M')]);
    expect(headerButtons('unstaged')).toEqual(['menu', 'stage']);
    const stage = details('unstaged').querySelector<HTMLElement>('[data-all="stage"]')!;
    expect(stage.title).toBe('Stage all changes (⌘⌥Y)');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    stage.dispatchEvent(ev);
    expect(h.stageAll).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
    await render([], [row('b', 'M', 'staged')]);
    expect(headerButtons('unstaged')).toEqual([]);
  });

  it('the menu items run their handlers', async () => {
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    await withStashes(1);
    (await headerItem('unstaged', 'discard')).click();
    (await headerItem('unstaged', 'stash')).click();
    (await headerItem('unstaged', 'unstash')).click();
    (await headerItem('staged', 'unstage')).click();
    (await headerItem('staged', 'stash-staged')).click();
    expect([h.discardAll, h.unstash, h.unstageAll].map((f) => f!.mock.calls.length)).toEqual([1, 1, 1]);
    expect(h.stash!.mock.calls).toEqual([['unstaged'], ['staged']]);
  });

  it('leaves out Unstash with no stash, and Discard, the stashes and Unstash with a conflict', async () => {
    await render([row('a', 'M')]);
    await headerItem('unstaged', 'show');
    expect(menuItems()).toEqual(['Review all changes⌘⇧A', 'Discard all changes', '-', 'Stash changes']);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    await render([row('a', 'M'), row('c', '!', 'unstaged', { conflicted: true })], [row('b', 'M', 'staged')]);
    await withStashes(1);
    expect(headerButtons('unstaged')).toEqual(['show', 'stage']);
    expect(headerButtons('staged')).toEqual(['unstage']);
  });

  it('shows the one available action as its own button, and nothing when none is', async () => {
    await render([], []);
    expect(headerButtons('unstaged')).toEqual([]);
    expect(headerButtons('staged')).toEqual([]);
    await withStashes(1);
    expect(headerButtons('unstaged')).toEqual(['unstash']);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    details('unstaged').querySelector('[data-all="unstash"]')!.dispatchEvent(ev);
    expect(h.unstash).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
    expect(details('unstaged').querySelector('[data-all="unstash"]')!.getAttribute('aria-label')).toBe('Unstash…');
  });

  it('offers no stash action without a commit', async () => {
    await render([row('a', 'M')], [row('b', 'M', 'staged')]);
    S.status = { ...S.status!, head: null, stash: 1 };
    notify();
    await tick();
    await headerItem('unstaged', 'show');
    expect(menuItems()).toEqual(['Review all changes⌘⇧A', 'Discard all changes']);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(headerButtons('staged')).toEqual(['unstage']);
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
    side.querySelector<HTMLElement>('.list')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.openRow).not.toHaveBeenCalled();
  });

  it('Enter on a focused header button does not reach the list handler', async () => {
    await render([row('a', 'M')], [], 'unstaged:a');
    side.querySelector<HTMLButtonElement>('[data-all="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.openRow).not.toHaveBeenCalled();
  });
});

describe('context menu', () => {
  const open = async (sel: string) => {
    side.querySelector<HTMLElement>(sel)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    return [...document.querySelectorAll<HTMLElement>('.menu-item')];
  };

  it('an unstaged row offers Stage file, Discard changes, Open file, Copy relative path', async () => {
    await render([row('a.ts', 'M')]);
    const items = await open('.row');
    expect(items.map((i) => i.textContent))
      .toEqual(['Stage file', 'Discard changes', 'Open file', 'Copy relative path']);
    items[1]!.click();
    expect(h.rejectFile).toHaveBeenCalledWith('a.ts');
  });

  it('a staged row offers Unstage file, Open file, Copy relative path', async () => {
    await render([], [row('b.ts', 'M', 'staged')]);
    const items = await open('.row');
    expect(items.map((i) => i.textContent)).toEqual(['Unstage file', 'Open file', 'Copy relative path']);
    items[1]!.click();
    expect(h.openPlain).toHaveBeenCalledWith('b.ts');
  });

  it('a conflicted row offers Mark resolved, Open file, Copy relative path', async () => {
    await render([row('c.ts', '!', 'unstaged', { conflicted: true })]);
    const items = await open('.row');
    expect(items.map((i) => i.textContent)).toEqual(['Mark resolved', 'Open file', 'Copy relative path']);
    items[0]!.click();
    expect(h.acceptFile).toHaveBeenCalledWith('c.ts');
  });

  it('Copy relative path copies the row path, which is relative to the repo root', async () => {
    await render([row('src/lib/auth/login.ts', 'M')]);
    (await open('.row')).find((i) => i.textContent === 'Copy relative path')!.click();
    expect(h.copyPath).toHaveBeenCalledExactlyOnceWith('src/lib/auth/login.ts');
  });
});
