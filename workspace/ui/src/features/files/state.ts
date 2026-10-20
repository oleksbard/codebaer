declare module '#kernel/store' {
  interface State {
    files: string[];
    /** Ignored entries for the Files tree, greyed out; a directory keeps its trailing slash. */
    ignored: string[];
    /** What git reported ignored; S.ignored is this plus every directory read on demand. */
    ignoredBase: string[];
    /** Contents of the ignored directories git collapsed, read on demand and kept across a refresh. */
    ignoredKids: Map<string, string[]>;
    /** Untracked folders with nothing git lists in them, each with a trailing slash. */
    emptyDirs: string[];
  }
}

export const filesState = () => ({
  files: [], ignored: [], ignoredBase: [], ignoredKids: new Map<string, string[]>(), emptyDirs: [],
});
