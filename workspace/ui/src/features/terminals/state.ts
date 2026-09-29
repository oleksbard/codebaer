import type { Info, Menu } from '#ipc/terminal';

/** What a session's icon is picked for, as the command menu keys its own; `icon` is a hand pick, carried by a task. */
export type TermIcon = { name: string; command: string; icon: string | null };

declare module '#kernel/store' {
  interface State {
    terminals: Info[];
    activeTerm: number | null;
    /** Sessions that did something worth noticing while they were not the focused one. */
    termAttention: Set<number>;
    termMenu: Menu | null;
    termError: string | null;
    termFind: string;
    /** A shell's first long command and a task's own command, by session; a program is picked for by its title. */
    termIcons: Map<number, TermIcon>;
  }
}

export const terminalsState = () => ({
  terminals: [], activeTerm: null, termAttention: new Set<number>(), termMenu: null, termError: null, termFind: '',
  termIcons: new Map<number, TermIcon>(),
});
