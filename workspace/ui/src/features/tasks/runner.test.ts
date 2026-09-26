import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomCommand } from '#ipc/settings';
import type { Info, Task, TermState } from '#ipc/terminal';

vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return {
    ...actual,
    runTask: vi.fn(), promote: vi.fn(), close: vi.fn(), kill: vi.fn(),
    subscribe: vi.fn(() => Promise.resolve()),
    menu: vi.fn(() => Promise.resolve({ shells: [], default: '/bin/zsh', commands: [] })),
  };
});
vi.mock('#features/terminals', async () => ({
  ...(await vi.importActual<object>('#features/terminals')),
  size: () => [120, 30] as [number, number],
}));

const term = await import('#ipc/terminal');
const { HIDDEN_TASK_MS } = await import('#features/settings');
const c = await import('./runner');
const { onTermEvent, terminalsOf } = await import('#features/terminals');
const { S } = await import('#kernel/store');
const { run } = await import('#kernel/registry');
await import('#app/bootstrap');

const cmd = (command: string, repo: string | null): CustomCommand =>
  ({ name: '', command, repo, hide_terminal: false, icon: null });
const hidden: Task = { t: 'Custom', ...cmd('pnpm test', null), hide_terminal: true };
const task = (id: number, state: TermState = { t: 'Running', command: null, since_ms: 0 }): Info =>
  ({ id, title: 'pnpm test', cwd: '/r', tier: 'process', state, task: true });
const shell = (id: number): Info => ({ id, title: 'zsh', cwd: '/r', tier: 'marks', state: { t: 'Idle' } });

describe('task lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    S.terminals = [];
    S.activeTerm = null;
    S.taskView = null;
    S.tab = 'changes';
    S.toasts = [];
    S.termAttention = new Set();
    S.palette = null; S.confirm = null; S.prompt = null; S.orphans = null; S.settingsOpen = false;
    vi.mocked(term.runTask).mockResolvedValue(7);
    vi.mocked(term.promote).mockResolvedValue();
    vi.mocked(term.close).mockResolvedValue();
  });

  afterEach(() => {
    // the expiry timers of one test must not fire into the next
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('opens the dialog for the task it started, and leaves the terminal view alone', async () => {
    S.terminals = [shell(1)];
    S.activeTerm = 1;
    await c.runTask({ t: 'Script', name: 'test' });
    expect(term.runTask).toHaveBeenCalledWith({ t: 'Script', name: 'test' }, 120, 30);
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBe(4);
    expect(S.activeTerm).toBe(1);
  });

  it('still opens the dialog when the Spawned beats the reply to the run', async () => {
    let reply!: (req: number) => void;
    vi.mocked(term.runTask).mockReturnValue(new Promise((r) => { reply = r; }));
    const running = c.runTask({ t: 'Script', name: 'test' });
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBeNull();
    reply(7);
    await running;
    expect(S.taskView).toBe(4);
  });

  it('does not open over something that took the screen meanwhile, and says where the output went', async () => {
    await c.runTask({ t: 'Script', name: 'test' });
    S.settingsOpen = true;
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBeNull();
    expect(S.terminals.map((t) => t.id)).toEqual([4]);
    expect(S.toasts.map((t) => t.message)).toEqual(['pnpm test is running. Its output is in the command menu.']);
  });

  it('says why a run was refused', async () => {
    vi.mocked(term.runTask).mockRejectedValue({ kind: 'Io', detail: 'package.json has no script named test' });
    await c.runTask({ t: 'Script', name: 'test' });
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['err', 'package.json has no script named test']]);
  });

  it('keeps a task out of the active terminal choice when the list arrives', () => {
    onTermEvent({ t: 'Hello', proto: 3, sessions: [shell(1), task(2)] });
    expect(S.activeTerm).toBe(1);
    onTermEvent({ t: 'Closed', id: 1 });
    expect(S.activeTerm).toBeNull();
  });

  it('leaves a running task alone when its dialog closes, and says how it ended later', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    c.closeTask();
    expect(term.close).not.toHaveBeenCalled();
    onTermEvent({ t: 'Exit', id: 4, code: 2 });
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['warn', 'pnpm test failed with exit 2']]);
    expect(S.termAttention.size).toBe(0);
  });

  it('closes a task that ended out of sight once its output has been kept a while', () => {
    S.terminals = [task(4)];
    onTermEvent({ t: 'Exit', id: 4, code: 0 });
    vi.advanceTimersByTime(c.TASK_KEEP_MS - 1);
    expect(term.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('keeps an ended task while its dialog is open, and closes it with the dialog', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    onTermEvent({ t: 'Exit', id: 4, code: 0 });
    expect(S.toasts).toEqual([]);
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).not.toHaveBeenCalled();
    c.closeTask();
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('tries again later when closing an ended task with its dialog fails', async () => {
    vi.mocked(term.close).mockRejectedValueOnce({ kind: 'Io', detail: 'no terminal host' });
    S.terminals = [task(4, { t: 'Exited', code: 0 })];
    c.openTask(4);
    c.closeTask();
    await vi.advanceTimersByTimeAsync(c.TASK_KEEP_MS);
    expect(term.close).toHaveBeenCalledTimes(2);
  });

  it('does not count down a task whose dialog is open when the list arrives again', () => {
    S.terminals = [task(4, { t: 'Exited', code: 0 })];
    c.openTask(4);
    onTermEvent({ t: 'Hello', proto: 3, sessions: [task(4, { t: 'Exited', code: 0 })] });
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).not.toHaveBeenCalled();
    expect(S.taskView).toBe(4);
  });

  it('stops the countdown for a task reopened from the menu', () => {
    S.terminals = [task(4)];
    onTermEvent({ t: 'Exit', id: 4, code: 0 });
    c.openTask(4);
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).not.toHaveBeenCalled();
  });

  it('starts the countdown for a task that ended while no window was listening', () => {
    onTermEvent({ t: 'Hello', proto: 3, sessions: [task(4, { t: 'Exited', code: 0 }), task(5)] });
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('moves a task to the rail and shows it there, for good', async () => {
    S.terminals = [shell(1), task(4)];
    c.openTask(4);
    await c.promoteTask(4);
    expect(term.promote).toHaveBeenCalledWith(4);
    expect(S.taskView).toBeNull();
    expect(S.tab).toBe('terminals');
    expect(S.activeTerm).toBe(4);
    expect(terminalsOf(S.terminals).map((t) => t.id)).toEqual([1, 4]);
    onTermEvent({ t: 'Exit', id: 4, code: 0 });
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).not.toHaveBeenCalled();
  });

  it('keeps the dialog when the move fails', async () => {
    vi.mocked(term.promote).mockRejectedValue({ kind: 'Io', detail: 'no terminal host' });
    S.terminals = [task(4)];
    c.openTask(4);
    await c.promoteTask(4);
    expect(S.taskView).toBe(4);
    expect(S.terminals[0]!.task).toBe(true);
    expect(S.toasts.map((t) => t.message)).toEqual(['no terminal host']);
  });

  it('drops the dialog when its task is closed from elsewhere', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    onTermEvent({ t: 'Closed', id: 4 });
    expect(S.taskView).toBeNull();
  });

  it('runs a hidden task with no dialog, and closes it the moment it ends', async () => {
    await c.runTask(hidden);
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBeNull();
    expect(S.toasts).toEqual([]);
    onTermEvent({ t: 'Exit', id: 4, code: 2 });
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['warn', 'pnpm test failed with exit 2']]);
  });

  it('opens the dialog for a saved command that shows its terminal', async () => {
    await c.runTask({ t: 'Custom', ...cmd('pnpm test', null) });
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBe(4);
  });

  it('stops a hidden task that is still running at the limit', async () => {
    await c.runTask(hidden);
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    vi.advanceTimersByTime(HIDDEN_TASK_MS - 1);
    expect(term.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['warn', 'pnpm test was stopped after 10 minutes']]);
    onTermEvent({ t: 'Closed', id: 4 });
    onTermEvent({ t: 'Exit', id: 4, code: 129 });
    expect(S.termAttention.size).toBe(0);
    expect(S.toasts).toHaveLength(1);
  });

  it('treats a hidden task opened from the menu as an ordinary one', async () => {
    await c.runTask(hidden);
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    c.openTask(4);
    vi.advanceTimersByTime(HIDDEN_TASK_MS);
    onTermEvent({ t: 'Exit', id: 4, code: 0 });
    expect(term.close).not.toHaveBeenCalled();
    expect(S.taskView).toBe(4);
  });

  it('closes a hidden task that ended while no window was listening', async () => {
    await c.runTask(hidden);
    onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    onTermEvent({ t: 'Hello', proto: 3, sessions: [task(4, { t: 'Exited', code: 0 })] });
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
    expect(S.toasts.map((t) => t.message)).toEqual(['pnpm test finished']);
  });

  it('blocks the global shortcuts while the dialog is open', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    const hidden = S.sidebarHidden;
    run('app.toggleSidebar');
    expect(S.sidebarHidden).toBe(hidden);
  });
});
