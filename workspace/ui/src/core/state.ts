import type { Eol, FileText, Status } from '#ipc/git';
import type { ViewKind } from '#editor/editor';

export type Tab = 'changes' | 'files' | 'terminals';

export type Open = {
  path: string;
  view: ViewKind;
  eol: Eol;
  baseline: string | null;
  originalOid: string | null;
  originalExists: boolean;
  docOid: string | null;
  dirty: boolean;
  badge: FileText | null;
  panel: string | null;
  conflicted: boolean;
};

declare module '#kernel/store' {
  interface State {
    /** Canonical, the form the terminal host reports folders in; `rootLabel` is for display. */
    root: string | null;
    rootLabel: string | null;
    title: string | null;
    status: Status | null;
    tab: Tab;
    open: Open | null;
    selected: string | null;
    refreshing: boolean;
    refreshAgain: boolean;
    saveTimer: ReturnType<typeof setTimeout>;
    flushing: Promise<boolean> | null;
    fatal: string | null;
    busy: boolean;
    changesOnly: boolean;
    /** Directory paths expanded in the Files tree; outlives the tab switch that unmounts the tree. */
    filesOpen: Set<string>;
  }
}

export const coreState = () => ({
  root: null, rootLabel: null, title: null, status: null, tab: 'changes' as Tab, open: null, selected: null,
  refreshing: false, refreshAgain: false, saveTimer: 0, flushing: null, fatal: null, busy: false,
  changesOnly: localStorage.getItem('codebaer.changesOnly') === 'true',
  filesOpen: new Set<string>(),
});
