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
