declare module '#kernel/store' {
  interface State {
    blame: string | null;
  }
}

export const reviewState = () => ({ blame: null });
