import type { Eol, FileText, Status } from '#ipc/git';
import type { ViewKind } from '#editor/editor';

export type Tab = 'changes' | 'files' | 'search' | 'terminals';

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
    flushing: Promise<boolean> | null;
    /** Why git did not run at launch. Every folder then opens without git, until one opens with it. */
    gitMissing: string | null;
    /** The open folder has no repository, or there is no git: only its terminals and tasks work. */
    folderOnly: boolean;
    busy: boolean;
    changesOnly: boolean;
    /** Folds just the panel; `sidebarHidden` takes the activity bar with it. */
    sideCollapsed: boolean;
    /** Directory paths expanded in the Files tree; outlives the tab switch that unmounts the tree. */
    filesOpen: Set<string>;
    /** Until the launch has opened its repo or found none to open, so the no-repo screen does not flash first. */
    starting: boolean;
  }
}

export const coreState = () => ({
  root: null, rootLabel: null, title: null, status: null, tab: 'changes' as Tab, open: null, selected: null,
  refreshing: false, refreshAgain: false, flushing: null, gitMissing: null, folderOnly: false, busy: false,
  changesOnly: localStorage.getItem('codebaer.changesOnly') === 'true',
  sideCollapsed: localStorage.getItem('codebaer.sideCollapsed') === 'true',
  filesOpen: new Set<string>(),
  starting: true,
});
