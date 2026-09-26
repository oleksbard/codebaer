declare module '#kernel/store' {
  interface State {
    committing: boolean;
    aiBusy: boolean;
    commitMessage: string;
    cancellable: boolean;
  }
}

export const gitOpsState = () => ({ committing: false, aiBusy: false, commitMessage: '', cancellable: false });
