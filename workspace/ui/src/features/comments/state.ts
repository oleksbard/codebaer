import type { Comment, Draft } from './comments';

declare module '#kernel/store' {
  interface State {
    /** Comments waiting to be sent to a terminal. Drafts for an agent, not review state: memory only. */
    comments: Comment[];
    draft: Draft | null;
    lastTarget: number | null;
  }
}

export const commentsState = () => ({ comments: [], draft: null, lastTarget: null });
