import { beforeEach, expect, it, vi } from 'vitest';
import type { Info, Orphans, Proc } from './terminal';

vi.mock('./terminal', async () => {
  const actual = await vi.importActual<typeof import('./terminal')>('./terminal');
  return { ...actual, orphans: vi.fn(), close: vi.fn(async () => {}), relist: vi.fn(async () => {}) };
});
vi.mock('./toast', async () => {
  const actual = await vi.importActual<typeof import('./toast')>('./toast');
  return { ...actual, toast: vi.fn() };
});

const term = await import('./terminal');
const { orphanAction } = await import('./app/controller');
const { S } = await import('./app/store');
const { toast } = await import('./toast');

const SOCK = '/cfg/ptyd-2.sock';
const proc = (pid: number, session: number | null): Proc =>
  ({ pid, ppid: 10, pgid: pid, tty: 'ttys001', command: '/bin/zsh -l', session, relay: null, holds_app: false,
    exiting: false });
const report = (sessions: Proc[]): Orphans => ({
  sock: SOCK,
  hosts: [{ pid: 10, sock: SOCK, current: true, sock_exists: true, in_use: false, unclear: false, proto: 2,
    relay: null, sessions }],
  escaped: [],
});
const info = (id: number): Info => ({ id, title: 'zsh', cwd: '/r', tier: 'marks', state: { t: 'Idle' } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  S.orphans = null;
});

it('closes nothing when a fresh scan no longer says the row is that session', async () => {
  // the row paired pid 11 with #9, but #9 has since left the list, so 11 is not #9 after all
  S.terminals = [];
  vi.mocked(term.orphans).mockResolvedValue(report([proc(11, null)]));
  await orphanAction({ t: 'close', id: 9, pid: 11 });
  expect(term.close).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/changed since the scan/), 'err');
});

it('closes the session when a fresh scan still agrees', async () => {
  S.terminals = [info(9)];
  vi.mocked(term.orphans).mockResolvedValue(report([proc(11, 9)]));
  await orphanAction({ t: 'close', id: 9, pid: 11 });
  expect(term.close).toHaveBeenCalledWith(9);
});

it('says so when a restore brings nothing back', async () => {
  vi.useFakeTimers();
  S.terminals = [];
  vi.mocked(term.orphans).mockResolvedValue(report([proc(11, null)]));
  const unknown = orphanAction({ t: 'relist', id: null });
  await vi.advanceTimersByTimeAsync(5000);
  await unknown;
  expect(term.relist).toHaveBeenCalledWith(null);
  expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/nothing was restored/), 'err');

  const known = orphanAction({ t: 'relist', id: 4 });
  await vi.advanceTimersByTimeAsync(5000);
  await known;
  expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/#4.*nothing was restored/), 'err');
});

it('stays quiet when a restore brings the terminal back', async () => {
  S.terminals = [];
  vi.mocked(term.orphans).mockResolvedValue(report([proc(11, null)]));
  vi.mocked(term.relist).mockImplementationOnce(async () => {
    S.terminals = [info(7)];
  });
  await orphanAction({ t: 'relist', id: null });
  expect(term.relist).toHaveBeenLastCalledWith(7);
  expect(toast).not.toHaveBeenCalled();
});
