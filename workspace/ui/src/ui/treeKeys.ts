/** A tree drawn as a flat list of rows, with a cursor on one of them (`at`, -1 for none). */
export type TreeNav = {
  count: number;
  at: number;
  /** Null for a leaf, else whether the branch is open. */
  open(i: number): boolean | null;
  /** The row of the branch that holds row `i`, -1 at the top. */
  parent(i: number): number;
  /** Moves the cursor to row `i`; a leaf opens there. */
  go(i: number): void;
  toggle(i: number): void;
};

/** The keys of VS Code's trees: the arrows move, Enter or Space opens a leaf or toggles a branch, Right opens a
 *  branch and then steps into it, Left closes it and then steps out to its parent. False for a key it leaves. */
export function treeKey(key: string, nav: TreeNav): boolean {
  const { at, count } = nav;
  if (!count) return false;
  const open = at >= 0 ? nav.open(at) : null;
  switch (key) {
    case 'ArrowDown': nav.go(at < 0 ? 0 : Math.min(count - 1, at + 1)); return true;
    case 'ArrowUp': nav.go(at < 0 ? 0 : Math.max(0, at - 1)); return true;
    case 'Enter':
    case ' ':
      if (at < 0) return false;
      if (open === null) nav.go(at);
      else nav.toggle(at);
      return true;
    case 'ArrowRight':
      if (open === false) nav.toggle(at);
      // an open branch can be empty, or still be read, so the next row may be a sibling
      else if (open === true && at + 1 < count && nav.parent(at + 1) === at) nav.go(at + 1);
      return true;
    case 'ArrowLeft': {
      if (open === true) { nav.toggle(at); return true; }
      const up = at >= 0 ? nav.parent(at) : -1;
      if (up >= 0) nav.go(up);
      return true;
    }
    default:
      return false;
  }
}
