/** For async work that writes state after an await: a check taken before the await is false once a
 *  newer run started or the work was cancelled, so a late result cannot overwrite a newer view. */
export function epoch() {
  let n = 0;
  return {
    next(): () => boolean {
      const mine = ++n;
      return () => mine === n;
    },
    current(): () => boolean {
      const mine = n;
      return () => mine === n;
    },
    bump(): void {
      n++;
    },
  };
}
