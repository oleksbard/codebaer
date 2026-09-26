declare module '#kernel/store' {
  interface State {
    /** The task whose output dialog is open. */
    taskView: number | null;
  }
}

export const tasksState = () => ({ taskView: null });
