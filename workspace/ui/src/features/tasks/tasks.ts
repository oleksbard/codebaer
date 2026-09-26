import type { Info } from '#ipc/terminal';
import type { DeepReadonly } from '#kernel/store';

/** A shell reports a signal death as 128 plus the signal: these are the ones Stop and Ctrl-C send. */
const STOPPED = new Set([129, 130, 137, 143]);

export type Outcome = { text: string; tone: 'ok' | 'warn' | 'info' };

export function outcome(s: DeepReadonly<Info>): Outcome | null {
  if (s.state.t !== 'Exited') return null;
  const { code } = s.state;
  if (code === 0) return { text: 'finished', tone: 'ok' };
  if (code === null) return { text: 'exited', tone: 'info' };
  if (STOPPED.has(code)) return { text: 'stopped', tone: 'info' };
  return { text: `failed with exit ${code}`, tone: 'warn' };
}

/** Drops the leading words every command shares, so the menu spends its width on what tells them apart.
 *  Needs two commands to share anything, and leaves each at least its last word. */
export function withoutSharedPrefix(commands: readonly string[]): string[] {
  if (commands.length < 2) return [...commands];
  const words = commands.map((c) => c.split(' '));
  const first = words[0]!;
  let n = 0;
  while (words.every((w) => n < w.length - 1 && w[n] === first[n])) n++;
  return n ? words.map((w) => `… ${w.slice(n).join(' ')}`) : [...commands];
}
