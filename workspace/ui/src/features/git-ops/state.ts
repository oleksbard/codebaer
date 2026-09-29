import type { Outgoing } from '#ipc/git';

declare module '#kernel/store' {
  interface State {
    committing: boolean;
    aiBusy: boolean;
    commitMessage: string;
    cancellable: boolean;
    outgoing: Outgoing;
  }
}

export const NO_OUTGOING: Outgoing = { commits: [], more: false };

export const gitOpsState = () => ({
  committing: false, aiBusy: false, commitMessage: '', cancellable: false, outgoing: NO_OUTGOING,
});
