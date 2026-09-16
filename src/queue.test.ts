import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue, type QueueHandlers } from './queue';
import type { Row } from './model';

const row = (path: string, letter: string, section: Row['section'] = 'unstaged', extra: Partial<Row> = {}): Row =>
  ({ section, path, letter, untracked: false, conflicted: false, ...extra });

let root: HTMLElement;
let h: Record<keyof QueueHandlers, ReturnType<typeof vi.fn>>;
let q: Queue;

beforeEach(() => {
  document.body.innerHTML = '<div id="side"></div>';
  root = document.getElementById('side')!;
  h = { openRow: vi.fn(), openPlain: vi.fn(), stageFile: vi.fn(), revertFile: vi.fn(), unstageFile: vi.fn(), commit: vi.fn(), aiMessage: vi.fn(), setTab: vi.fn(), stageAll: vi.fn(), unstageAll: vi.fn() };
  q = new Queue(root, h as unknown as QueueHandlers);
});

const render = (unstaged: Row[], staged: Row[] = [], selected: string | null = null) =>
  q.render({ unstaged, staged }, [], selected, 'changes');
const details = (sec: 'unstaged' | 'staged') => root.querySelector<HTMLDetailsElement>(`details[data-sec="${sec}"]`)!;

describe('row layout', () => {
  it('shows the name first, the directory without its slash, and the letter last', () => {
    render([row('src/lib/auth/login.ts', 'M')]);
    const r = root.querySelector<HTMLElement>('.row')!;
    expect(r.querySelector('.path .name')!.textContent).toBe('login.ts');
    expect(r.querySelector('.path .dir')!.textContent).toBe('src/lib/auth');
    expect(r.querySelector('.tail > :last-child')!.className).toBe('st');
    expect(r.querySelector('.st')!.textContent).toBe('M');
    expect(r.dataset.st).toBe('M');
    expect(r.title).toBe('src/lib/auth/login.ts');
  });

  it('a root-level file has an empty directory span', () => {
    render([row('README.md', 'U', 'unstaged', { untracked: true })]);
    expect(root.querySelector('.path .dir')!.textContent).toBe('');
    expect(root.querySelector<HTMLElement>('.row')!.dataset.st).toBe('U');
  });

  it('a conflicted row keeps its badge before the actions and the letter', () => {
    render([row('x.ts', '!', 'unstaged', { conflicted: true })]);
    const tail = root.querySelector('.tail')!;
    expect([...tail.children].map((c) => c.className.split(' ')[0])).toEqual(['badge', 'acts', 'st']);
    expect(tail.querySelector('.st')!.textContent).toBe('!');
  });

  it('Files tab rows wrap the name in .name', () => {
    q.render({ unstaged: [], staged: [] }, ['src/a.ts'], null, 'files');
    expect(root.querySelector('.row.f .path .name')!.textContent).toBe('a.ts');
  });

  it('escapes the name, the directory, the title and the key', () => {
    render([row('a "b"/c&d<e>.ts', 'M')]);
    const r = root.querySelector<HTMLElement>('.row')!;
    expect(r.querySelector('.path .name')!.textContent).toBe('c&d<e>.ts');
    expect(r.querySelector('.path .dir')!.textContent).toBe('a "b"');
    expect(r.title).toBe('a "b"/c&d<e>.ts');
    expect(r.dataset.key).toBe('unstaged:a "b"/c&d<e>.ts');
  });
});

describe('sections', () => {
  it('renders both sections open with counts', () => {
    render([row('a', 'M')], [row('b', 'M', 'staged')]);
    const secs = [...root.querySelectorAll<HTMLDetailsElement>('details[data-sec]')];
    expect(secs.map((d) => d.dataset.sec)).toEqual(['unstaged', 'staged']);
    expect(secs.map((d) => d.open)).toEqual([true, true]);
    expect([...root.querySelectorAll('summary.sec .n')].map((n) => n.textContent)).toEqual(['1', '1']);
    expect(root.querySelector('summary.sec .l')!.textContent).toBe('Changes');
  });

  it('keeps a collapsed section collapsed across re-renders and a Files tab visit', () => {
    render([row('a', 'M')], [row('b', 'M', 'staged')]);
    details('staged').open = false;
    render([row('a', 'M')], [row('b', 'M', 'staged')]);
    expect(details('staged').open).toBe(false);
    expect(details('unstaged').open).toBe(true);
    q.render({ unstaged: [], staged: [] }, ['x.ts'], null, 'files');
    render([row('a', 'M')], [row('b', 'M', 'staged')]);
    expect(details('staged').open).toBe(false);
  });

  it('the stage-all button runs its handler and cancels the click default', () => {
    render([row('a', 'M')]);
    const btn = root.querySelector<HTMLButtonElement>('[data-all="stage"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(h.stageAll).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('arrow keys skip rows inside a collapsed section', () => {
    const list = root.querySelector<HTMLElement>('.list')!;
    const down = () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    render([row('a', 'M')], [row('b', 'M', 'staged')], 'unstaged:a');
    down();
    expect(h.openRow).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b', section: 'staged' }));

    details('staged').open = false;
    render([row('a', 'M')], [row('b', 'M', 'staged')], 'unstaged:a');
    h.openRow.mockClear();
    down();
    expect(h.openRow).toHaveBeenCalledTimes(1);
    expect(h.openRow).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'a' }));
  });

  it('the empty-section text lives inside its details so collapsing hides it', () => {
    render([], []);
    expect(details('unstaged').querySelector('.empty-sec')!.textContent).toBe('Nothing left to review');
    expect(details('staged').querySelector('.empty-sec')!.textContent).toBe('Accepted hunks land here');
  });

  it('Enter does nothing while the selected row is inside a collapsed section', () => {
    const list = root.querySelector<HTMLElement>('.list')!;
    render([row('a', 'M')], [], 'unstaged:a');
    details('unstaged').open = false;
    render([row('a', 'M')], [], 'unstaged:a');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.openRow).not.toHaveBeenCalled();
  });
});

describe('AI commit message button', () => {
  const btn = () => root.querySelector<HTMLButtonElement>('#ai-btn')!;

  it('is disabled with nothing staged and enabled once something is', () => {
    render([]);
    expect(btn().disabled).toBe(true);
    render([], [row('a.ts', 'M', 'staged')]);
    expect(btn().disabled).toBe(false);
  });

  it('click asks for a message, busy disables it, setMessage fills the box', () => {
    render([], [row('a.ts', 'M', 'staged')]);
    btn().click();
    expect(h.aiMessage).toHaveBeenCalledTimes(1);
    q.setAiBusy(true);
    expect(btn().disabled).toBe(true);
    expect(btn().classList.contains('busy')).toBe(true);
    q.setAiBusy(false);
    expect(btn().disabled).toBe(false);
    expect(btn().classList.contains('busy')).toBe(false);
    q.setMessage('Fix the thing');
    expect(q.message()).toBe('Fix the thing');
  });
});
