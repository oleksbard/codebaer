import { expect, it, vi } from 'vitest';
import type { Info } from '#ipc/terminal';

/** Stands in for whatever xterm does on the way out; the point is only that it can fail. */
vi.mock('./xterm', async () => {
  const actual = await vi.importActual<typeof import('./xterm')>('./xterm');
  return { ...actual, dispose: () => { throw new Error('teardown failed'); } };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, toast: vi.fn() };
});

vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, menu: vi.fn(), spawn: vi.fn(), subscribe: vi.fn() };
});

const { newTerminal, onTermEvent } = await import('./sessions');
const pty = await import('#ipc/terminal');
const { S, subscribe } = await import('#kernel/store');
const { toast } = await import('#kernel/dialogs');

const session = (id: number): Info => ({ id, title: 'zsh', cwd: '/repo', tier: 'marks', state: { t: 'Idle' } });

it('keeps the list and the repaint even when handling an event fails', () => {
  S.terminals = [session(1), session(2)];
  S.activeTerm = 1;
  const painted = vi.fn();
  const stop = subscribe(painted);

  // an escaping error would wedge the channel Tauri delivers every later event on
  expect(() => onTermEvent({ t: 'Closed', id: 1 })).not.toThrow();

  expect(S.terminals.map((t) => t.id)).toEqual([2]);
  expect(S.activeTerm).toBe(2);
  expect(painted).toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('Error: teardown failed', 'err');
  stop();
});

it('moves a session to the folder its host reports, and only that session', () => {
  S.terminals = [session(1), session(2)];
  onTermEvent({ t: 'Cwd', id: 1, cwd: '/elsewhere' });
  expect(S.terminals.map((t) => t.cwd)).toEqual(['/elsewhere', '/repo']);
});

it('shows a new terminal whose host announced it before the spawn call returned', async () => {
  S.terminals = [session(1)];
  S.activeTerm = 1;
  vi.mocked(pty.menu).mockResolvedValue({ shells: [], default: '/bin/zsh', commands: [] });
  vi.mocked(pty.spawn).mockImplementation(async () => {
    onTermEvent({ t: 'Spawned', req: 7, info: session(3) });
    return 7;
  });
  await newTerminal({ t: 'Shell', path: '/bin/zsh' });
  expect(S.activeTerm).toBe(3);
});

it('stores what claude reports, and flags a session you are not looking at when it asks for you', () => {
  const working = {
    phase: 'working' as const, since_ms: 0, turn_ms: 0, took_ms: null, end: null, actions: 1, calls: [], last: null,
    ask: null, subagents: 0, rev: 1,
  };
  S.terminals = [{ ...session(1), agent: working }, session(2)];
  S.activeTerm = 2;
  S.termAttention = new Set();
  onTermEvent({ t: 'Agent', id: 1, agent: { ...working, actions: 2, rev: 2 } });
  expect(S.terminals[0]!.agent?.actions).toBe(2);
  expect(S.termAttention.has(1)).toBe(false);
  onTermEvent({ t: 'Agent', id: 1, agent: { ...working, phase: 'approval', rev: 3 } });
  expect(S.termAttention.has(1)).toBe(true);
});

it('drops a state that arrives after a newer one', () => {
  const working = {
    phase: 'working' as const, since_ms: 0, turn_ms: 0, took_ms: null, end: null, actions: 1, calls: [], last: null,
    ask: null, subagents: 0, rev: 5,
  };
  S.terminals = [{ ...session(1), agent: working }];
  onTermEvent({ t: 'Agent', id: 1, agent: { ...working, phase: 'approval', rev: 4 } });
  onTermEvent({ t: 'Agent', id: 1, agent: { ...working, actions: 9, rev: 5 } });
  expect(S.terminals[0]!.agent).toEqual(working);
});
