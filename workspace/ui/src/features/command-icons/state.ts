declare module '#kernel/store' {
  interface State {
    /** The AI's icon picks by `iconKey()`, from icons-codebaer.json; empty until a menu or pane first asks. */
    commandIcons: Record<string, string>;
  }
}

export const commandIconsState = () => ({ commandIcons: {} });
