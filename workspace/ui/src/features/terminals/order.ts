import { logError } from '#ipc/log';
import type { Info } from '#ipc/terminal';
import { notify, S } from '#kernel/store';
import { keyOf } from './icons';
import { isTask, terminalsOf } from './status';

const KEY = 'codebaer.term.order';

/** The rail's sessions in the order the pointer left them, then the tasks. Kept by id and pid like the icons, so a
 *  reload keeps it. */
export function reorderTerminals(ids: readonly number[]): void {
  const rail = terminalsOf(S.terminals);
  const placed = ids.flatMap((id) => rail.find((t) => t.id === id) ?? []);
  S.terminals = [...placed, ...rail.filter((t) => !placed.includes(t)), ...S.terminals.filter(isTask)];
  try {
    localStorage.setItem(KEY, JSON.stringify(terminalsOf(S.terminals).flatMap((t) => keyOf(t) ?? [])));
  } catch (e) {
    logError(e, 'save terminal order');
  }
  notify();
}

/** The sessions the saved order names first, in that order, then the rest in the host's order. */
export function inSavedOrder(sessions: readonly Info[]): Info[] {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    saved = [];
  }
  const rank = new Map<unknown, number>(Array.isArray(saved) ? saved.map((k, i) => [k, i]) : []);
  const at = (t: Info): number => rank.get(keyOf(t)) ?? rank.size;
  return [...sessions].sort((a, b) => at(a) - at(b));
}
