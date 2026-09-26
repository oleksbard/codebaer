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

const { onTermEvent } = await import('./sessions');
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
