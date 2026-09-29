import type { EditorView } from '@codemirror/view';
import { view } from '#core/session';
import { originalPane, setSideBySide } from '#editor/side-by-side';
import type { DeepReadonly, State } from '#kernel/store';
import { S } from '#kernel/store';

export const mainPane = (): EditorView => originalPane(view);

export const sideChosen = (s: DeepReadonly<State>): boolean => s.settings['appearance.diff-layout'] === 'side-by-side';

/** Whether the one-file view shows its file side by side: only the unstaged view's diff does, and a conflict opens
 *  as a plain file. */
export function mainSide(s: DeepReadonly<State>): boolean {
  const o = s.open;
  return sideChosen(s) && !!o && o.view === 'unstaged' && !o.conflicted && !o.panel;
}

/** After each open, since every state core builds starts unified. */
export const layoutMain = (): void => setSideBySide(view, mainSide(S));
