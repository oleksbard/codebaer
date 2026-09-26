import type { Info, Menu } from '#ipc/terminal';

declare module '#kernel/store' {
  interface State {
    terminals: Info[];
    activeTerm: number | null;
    /** Sessions that did something worth noticing while they were not the focused one. */
    termAttention: Set<number>;
    termMenu: Menu | null;
    termError: string | null;
    termFind: string;
  }
}

export const terminalsState = () => ({
  terminals: [], activeTerm: null, termAttention: new Set<number>(), termMenu: null, termError: null, termFind: '',
});
