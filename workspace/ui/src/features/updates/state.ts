import type { Update } from '#ipc/git';

declare module '#kernel/store' {
  interface State {
    /** Whether this build updates itself, once the backend has said. */
    canUpdate: boolean;
    /** A newer release, downloaded and waiting for the restart that installs it. */
    update: Update | null;
    /** `restartToUpdate` is downloading it: the pill shows that instead of Restart to Update. */
    installing: boolean;
  }
}

export const updatesState = () => ({ canUpdate: false, update: null, installing: false });
