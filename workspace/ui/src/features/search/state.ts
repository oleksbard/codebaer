import type { SearchFile } from '#ipc/git';

declare module '#kernel/store' {
  interface State {
    searchQuery: string;
    /** Folders or globs, comma-separated; empty searches the whole repo. */
    searchInclude: string;
    /** In path order. */
    searchFiles: SearchFile[];
    searchBusy: boolean;
    /** The search stopped at the backend's cap. */
    searchTruncated: boolean;
    searchError: string | null;
    /** Files whose hits are folded away. */
    searchCollapsed: Set<string>;
    /** The hit last opened, as `searchKey` makes it. */
    searchSelected: string | null;
    /** Files changed while the tab was hidden, so the search runs again when it shows. */
    searchStale: boolean;
  }
}

export const searchState = () => ({
  searchQuery: '', searchInclude: '', searchFiles: [], searchBusy: false, searchTruncated: false,
  searchError: null, searchCollapsed: new Set<string>(), searchSelected: null, searchStale: false,
});
