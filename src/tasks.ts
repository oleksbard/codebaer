import type { CustomCommand } from './settings';
import type { Info } from './terminal';

export const isTask = (s: Info): boolean => s.task === true;

/** What the terminal rail lists: a task stays out of it until it is moved there. */
export const terminalsOf = (sessions: readonly Info[]): Info[] => sessions.filter((s) => !isTask(s));

export const commandTitle = (c: CustomCommand): string => c.name.trim() || c.command;

/** Another repo's commands are kept and edited in Settings, but never offered to run here. */
export const inMenu = (c: CustomCommand, root: string | null): boolean => c.repo === null || c.repo === root;

export type CommandGroup = { repo: string | null; commands: CustomCommand[] };

/** This repo first, then the global ones, then each other repo in the order its first command was saved. */
export function commandGroups(all: readonly CustomCommand[], root: string | null): CommandGroup[] {
  const by = new Map<string | null, CustomCommand[]>();
  if (root !== null) by.set(root, []);
  by.set(null, []);
  for (const c of all) {
    const list = by.get(c.repo);
    if (list) list.push(c);
    else by.set(c.repo, [c]);
  }
  return [...by].map(([repo, commands]) => ({ repo, commands }));
}

/** A shell reports a signal death as 128 plus the signal: these are the ones Stop and Ctrl-C send. */
const STOPPED = new Set([129, 130, 137, 143]);

export type Outcome = { text: string; tone: 'ok' | 'warn' | 'info' };

export function outcome(s: Info): Outcome | null {
  if (s.state.t !== 'Exited') return null;
  const { code } = s.state;
  if (code === 0) return { text: 'finished', tone: 'ok' };
  if (code === null) return { text: 'exited', tone: 'info' };
  if (STOPPED.has(code)) return { text: 'stopped', tone: 'info' };
  return { text: `failed with exit ${code}`, tone: 'warn' };
}
