import { expect, it, vi } from 'vitest';
import type { Info } from './terminal';

/** Stands in for whatever xterm does on the way out; the point is only that it can fail. */
vi.mock('./terminal', async () => {
  const actual = await vi.importActual<typeof import('./terminal')>('./terminal');
  return { ...actual, dispose: () => { throw new Error('teardown failed'); } };
});
vi.mock('./toast', async () => {
  const actual = await vi.importActual<typeof import('./toast')>('./toast');
  return { ...actual, toast: vi.fn() };
});

const { onTermEvent } = await import('./app/controller');
const { S, subscribe } = await import('./app/store');
const { toast } = await import('./toast');

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
