import type { CustomCommand } from '#ipc/settings';
import type { DeepReadonly } from '#kernel/store';

/** A command saved to hide its terminal that is still running after this long is stopped and closed. */
export const HIDDEN_TASK_MS = 10 * 60_000;

export const commandTitle = (c: DeepReadonly<CustomCommand>): string => c.name.trim() || c.command;

/** Another repo's commands are kept and edited in Settings, but never offered to run here. */
export const inMenu = (c: DeepReadonly<CustomCommand>, root: string | null): boolean =>
  c.repo === null || c.repo === root;

export type CommandGroup<C> = { repo: string | null; commands: C[] };

/** This repo first, then the global ones, then each other repo in the order its first command was saved. */
export function commandGroups<C extends DeepReadonly<CustomCommand>>(
  all: readonly C[],
  root: string | null,
): CommandGroup<C>[] {
  const by = new Map<string | null, C[]>();
  if (root !== null) by.set(root, []);
  by.set(null, []);
  for (const c of all) {
    const list = by.get(c.repo);
    if (list) list.push(c);
    else by.set(c.repo, [c]);
  }
  return [...by].map(([repo, commands]) => ({ repo, commands }));
}
