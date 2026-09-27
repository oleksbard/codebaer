/** The All changes page. `order` only grows while the page is open, so a file accepted away keeps its place
 *  instead of pulling the ones below it up; `shown` is the large diffs opened past the size gate. */
export type AllChanges = { order: string[]; collapsed: Set<string>; shown: Set<string> };

declare module '#kernel/store' {
  interface State {
    blame: string | null;
    allChanges: AllChanges | null;
  }
}

export const reviewState = () => ({ blame: null, allChanges: null });
