declare module '#kernel/store' {
  interface State {
    files: string[];
    /** Ignored entries for the Files tree, greyed out; a directory keeps its trailing slash. */
    ignored: string[];
    /** What git reported ignored; S.ignored is this plus every directory read on demand. */
    ignoredBase: string[];
    /** Contents of the ignored directories git collapsed, read on demand and kept across a refresh. */
    ignoredKids: Map<string, string[]>;
    /** The directory `toggleDir` just opened, so its own children (and no one else's) animate in;
     *  read once by `FilesTree` and cleared right after. */
    filesEntering: string | null;
  }
}

export const filesState = () => ({
  files: [], ignored: [], ignoredBase: [], ignoredKids: new Map<string, string[]>(), filesEntering: null,
});
