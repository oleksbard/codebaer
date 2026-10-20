import type { Token } from '#editor/snippet';
import type { Info, Menu } from '#ipc/terminal';
import type { Anchor } from '#ui/HoverCard';

/** What a session's icon is picked for, as the command menu keys its own; `icon` is a hand pick, carried by a task. */
export type TermIcon = { name: string; command: string; icon: string | null };

/** What the card over a file path in a terminal shows. `line` in `code` is the one the path named. */
export type PeekBody =
  | { kind: 'code'; first: number; line: number | null; lines: Token[][] }
  | { kind: 'image'; url: string; size: { width: number; height: number } | null }
  | { kind: 'markdown'; html: string }
  | { kind: 'note'; text: string };

/** `path` is relative to the repository. */
export type TermPeek = { id: number; at: Anchor; path: string; line: number | null; body: PeekBody };

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
    termPeek: TermPeek | null;
  }
}

export const terminalsState = () => ({
  terminals: [], activeTerm: null, termAttention: new Set<number>(), termMenu: null, termError: null, termFind: '',
  termIcons: new Map<number, TermIcon>(), termPeek: null,
});
