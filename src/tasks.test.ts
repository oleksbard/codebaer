import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomCommand } from './settings';
import type { Info, TermState } from './terminal';

vi.mock('./terminal', async () => {
  const actual = await vi.importActual<typeof import('./terminal')>('./terminal');
  return {
    ...actual,
    runTask: vi.fn(), promote: vi.fn(), close: vi.fn(), kill: vi.fn(), dispose: vi.fn(),
    subscribe: vi.fn(() => Promise.resolve()),
    menu: vi.fn(() => Promise.resolve({ shells: [], default: '/bin/zsh', commands: [] })),
    size: () => [120, 30] as [number, number],
  };
});

const term = await import('./terminal');
const { commandGroups, inMenu, outcome, terminalsOf } = await import('./tasks');
const c = await import('./app/controller');
const { S } = await import('./app/store');

const cmd = (command: string, repo: string | null): CustomCommand => ({ name: '', command, repo });
const task = (id: number, state: TermState = { t: 'Running', command: null, since_ms: 0 }): Info =>
  ({ id, title: 'pnpm test', cwd: '/r', tier: 'process', state, task: true });
const shell = (id: number): Info => ({ id, title: 'zsh', cwd: '/r', tier: 'marks', state: { t: 'Idle' } });

describe('helpers', () => {
  it('offers the global commands and this repo\'s, never another repo\'s', () => {
    expect([cmd('a', null), cmd('b', '/r'), cmd('c', '/other')].filter((x) => inMenu(x, '/r')).map((x) => x.command))
      .toEqual(['a', 'b']);
    expect(inMenu(cmd('b', '/r'), null)).toBe(false);
  });

  it('groups this repo, then global, then the rest in order, with the first two always present', () => {
    const all = [cmd('x', '/b'), cmd('g', null), cmd('y', '/a'), cmd('z', '/b')];
    expect(commandGroups(all, '/r').map((g) => [g.repo, g.commands.map((x) => x.command)])).toEqual([
      ['/r', []], [null, ['g']], ['/b', ['x', 'z']], ['/a', ['y']],
    ]);
    expect(commandGroups([], null).map((g) => g.repo)).toEqual([null]);
  });

  it('reads an exit code the way a person would say it', () => {
    const at = (code: number | null) => outcome(task(1, { t: 'Exited', code }));
    expect(at(0)).toEqual({ text: 'finished', tone: 'ok' });
    expect(at(1)).toEqual({ text: 'failed with exit 1', tone: 'warn' });
    expect(at(143)?.text).toBe('stopped');
    expect(at(130)?.text).toBe('stopped');
    expect(at(null)?.text).toBe('exited');
    expect(outcome(task(1))).toBeNull();
  });

  it('keeps tasks out of the rail until one is moved there', () => {
    expect(terminalsOf([shell(1), task(2), { ...task(3), task: false }]).map((s) => s.id)).toEqual([1, 3]);
  });
});

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
    c.onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBe(4);
    expect(S.activeTerm).toBe(1);
  });

  it('still opens the dialog when the Spawned beats the reply to the run', async () => {
    let reply!: (req: number) => void;
    vi.mocked(term.runTask).mockReturnValue(new Promise((r) => { reply = r; }));
    const running = c.runTask({ t: 'Script', name: 'test' });
    c.onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
    expect(S.taskView).toBeNull();
    reply(7);
    await running;
    expect(S.taskView).toBe(4);
  });

  it('does not open over something that took the screen meanwhile, and says where the output went', async () => {
    await c.runTask({ t: 'Script', name: 'test' });
    S.settingsOpen = true;
    c.onTermEvent({ t: 'Spawned', req: 7, info: task(4) });
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
    c.onTermEvent({ t: 'Hello', proto: 3, sessions: [shell(1), task(2)] });
    expect(S.activeTerm).toBe(1);
    c.onTermEvent({ t: 'Closed', id: 1 });
    expect(S.activeTerm).toBeNull();
  });

  it('leaves a running task alone when its dialog closes, and says how it ended later', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    c.closeTask();
    expect(term.close).not.toHaveBeenCalled();
    c.onTermEvent({ t: 'Exit', id: 4, code: 2 });
    expect(S.toasts.map((t) => [t.kind, t.message])).toEqual([['warn', 'pnpm test failed with exit 2']]);
    expect(S.termAttention.size).toBe(0);
  });

  it('closes a task that ended out of sight once its output has been kept a while', () => {
    S.terminals = [task(4)];
    c.onTermEvent({ t: 'Exit', id: 4, code: 0 });
    vi.advanceTimersByTime(c.TASK_KEEP_MS - 1);
    expect(term.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(term.close).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('keeps an ended task while its dialog is open, and closes it with the dialog', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    c.onTermEvent({ t: 'Exit', id: 4, code: 0 });
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
    c.onTermEvent({ t: 'Hello', proto: 3, sessions: [task(4, { t: 'Exited', code: 0 })] });
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).not.toHaveBeenCalled();
    expect(S.taskView).toBe(4);
  });

  it('stops the countdown for a task reopened from the menu', () => {
    S.terminals = [task(4)];
    c.onTermEvent({ t: 'Exit', id: 4, code: 0 });
    c.openTask(4);
    vi.advanceTimersByTime(c.TASK_KEEP_MS);
    expect(term.close).not.toHaveBeenCalled();
  });

  it('starts the countdown for a task that ended while no window was listening', () => {
    c.onTermEvent({ t: 'Hello', proto: 3, sessions: [task(4, { t: 'Exited', code: 0 }), task(5)] });
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
    c.onTermEvent({ t: 'Exit', id: 4, code: 0 });
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
    c.onTermEvent({ t: 'Closed', id: 4 });
    expect(S.taskView).toBeNull();
  });

  it('blocks the global shortcuts while the dialog is open', () => {
    S.terminals = [task(4)];
    c.openTask(4);
    const hidden = S.sidebarHidden;
    c.dispatch('toggleSidebar');
    expect(S.sidebarHidden).toBe(hidden);
  });
});
