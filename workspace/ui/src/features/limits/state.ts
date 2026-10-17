import type { LimitWindow } from '#ipc/git';
import type { LimitProvider } from '#ipc/settings';

/** The last answer from a CLI. A failed read keeps the windows and the time of the read before it. */
export type Limits = { windows: readonly LimitWindow[] | null; error: string | null; at: number | null };

declare module '#kernel/store' {
  interface State {
    /** Absent until the first answer, and for a CLI that is not installed. */
    limits: Partial<Record<LimitProvider, Limits>>;
    /** The CLIs whose limits are being read now. */
    limitsBusy: LimitProvider[];
  }
}

export const limitsState = () => ({ limits: {}, limitsBusy: [] });
