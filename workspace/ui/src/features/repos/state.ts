/** The open repo, as its preferences dialog shows it. */
export type RepoPrefs = { path: string; name: string; label: string; favorite: boolean };

declare module '#kernel/store' {
  interface State {
    /** The repo preferences dialog; null while it is closed. */
    repoPrefs: RepoPrefs | null;
  }
}

export const reposState = () => ({ repoPrefs: null });
