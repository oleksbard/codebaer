import { beforeEach, expect, it } from 'vitest';
import type { Info } from '#ipc/terminal';
import { S } from '#kernel/store';
import { inSavedOrder, reorderTerminals } from './order';

const session = (id: number, pid: number, task = false): Info =>
  ({ id, pid, title: 'zsh', cwd: '/repo', tier: 'marks', state: { t: 'Idle' }, task });

beforeEach(() => localStorage.clear());

it('keeps the dragged order by id and pid, so a new host reusing an id does not take the old place', () => {
  S.terminals = [session(1, 101), session(2, 102), session(3, 103, true), session(4, 104)];
  reorderTerminals([4, 1, 2]);
  expect(S.terminals.map((t) => t.id)).toEqual([4, 1, 2, 3]);

  const hello = [session(5, 105), session(1, 101), session(4, 204), session(2, 102)];
  expect(inSavedOrder(hello).map((t) => t.id)).toEqual([1, 2, 5, 4]);
});
