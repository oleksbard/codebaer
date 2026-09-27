import type { AiProvider } from '#ipc/settings';

export type AiTools = {
  /** Null until a check answers; a check that fails keeps the last answer. */
  installed: AiProvider[] | null;
  checking: boolean;
  failed: boolean;
};

declare module '#kernel/store' {
  interface State {
    /** The AI tools dialog; null while it is closed. */
    aiTools: AiTools | null;
  }
}

export const aiToolsState = () => ({ aiTools: null });
