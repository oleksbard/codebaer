import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBusy } from '#core/session';
import { confirmDialog } from '#kernel/dialogs';
import { S } from '#kernel/store';
import { g, mountApp, status } from '#test-app';
import { tick } from '#test-setup';
import { commit } from './git-ops';

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

const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
});

describe('a failed commit', () => {
  it('reports in a dialog rather than a toast, and stops the button spinning', async () => {
    S.toasts = [];
    S.commitMessage = 'a message';
    g.commit!.mockRejectedValue({ kind: 'Git', detail: 'pre-commit hook failed' });

    await commit();

    expect(S.toasts).toEqual([]);
    expect(S.confirm?.message).toBe('Commit failed\npre-commit hook failed');
    expect(S.confirm?.error).toBe(true);
    expect(S.committing).toBe(false);
    expect(S.commitMessage).toBe('a message');
    S.confirm!.resolve(false);
    S.confirm = null;
  });
});

describe('the branch row', () => {
  it('withBusy keeps a fast operation off the spinner', async () => {
    await withBusy(() => Promise.resolve());
    await new Promise((r) => setTimeout(r, 200));
    expect(S.busy).toBe(false);
  });

  it('withBusy shows the spinner once an operation outlives the delay', async () => {
    let release!: () => void;
    const slow = withBusy(() => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 200));
    expect(S.busy).toBe(true);
    release();
    await slow;
    expect(S.busy).toBe(false);
  });

  it('marks the ahead and behind counts only when there is something to push or pull', async () => {
    const { notify } = await import('#kernel/store');
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
    const { notify } = await import('#kernel/store');
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
