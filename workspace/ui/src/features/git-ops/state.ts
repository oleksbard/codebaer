import type { Outgoing } from '#ipc/git';

declare module '#kernel/store' {
  interface State {
    committing: boolean;
    /** A commit just landed: the Commit button shows a check instead of its label for a moment. */
    committed: boolean;
    aiBusy: boolean;
    commitMessage: string;
    cancellable: boolean;
    outgoing: Outgoing;
  }
}

export const NO_OUTGOING: Outgoing = { commits: [], more: false };

export const gitOpsState = () => ({
  committing: false, committed: false, aiBusy: false, commitMessage: '', cancellable: false, outgoing: NO_OUTGOING,
});
