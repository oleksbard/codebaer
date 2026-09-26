import type { Text } from '@codemirror/state';
import { blameText } from '#core/model';
import { view } from '#core/session';
import type { Open } from '#core/state';
import { git } from '#ipc/git';
import { notify, S } from '#kernel/store';

/** `doc` is CodeMirror's immutable Text, so comparing it by identity catches every edit,
 *  including one that keeps the length; `head` catches a commit or a pull that re-attributes the
 *  line without the document moving at all. */
type Asked = { open: Open; line: number; doc: Text; head: string | null };
let asked: Asked | null = null;
let blameTimer: ReturnType<typeof setTimeout> = 0;

const sameAsk = (a: Asked, b: Asked | null): boolean =>
  !!b && a.open === b.open && a.line === b.line && a.doc === b.doc && a.head === b.head;

function setBlame(text: string | null): void {
  if (S.blame === text) return;
  S.blame = text;
  notify();
}

/** Runs on every selection change and every document change, so it debounces the git call and
 *  drops the one it has already asked for. */
export function cursorMoved(): void {
  const o = S.open;
  clearTimeout(blameTimer);
  if (!o || o.panel) { asked = null; setBlame(null); return; }
  const doc = view.state.doc;
  const ask: Asked = {
    open: o, line: doc.lineAt(view.state.selection.main.head).number, doc, head: S.status?.head ?? null,
  };
  if (sameAsk(ask, asked)) return;
  asked = ask;
  setBlame(null);
  blameTimer = setTimeout(() => void loadBlame(ask), 150);
}

// ponytail: one git process per line the cursor rests on, and nothing caps the ones still in
// flight; a per-open line cache and a single-flight queue if that ever shows up in the profile
async function loadBlame(ask: Asked): Promise<void> {
  const o = ask.open;
  // an open that lands inside the debounce has not reached its own cursorMoved yet, so the ask
  // still looks current while the user is already looking at another file
  if (S.open !== o) return;
  // the document is blamed, never the file on disk: the staged view's doc is the index blob, a
  // dirty buffer is ahead of disk, and the agent can rewrite the file between two cursor moves
  try {
    const b = await git.blame(o.path, ask.line, ask.doc.toString(), o.eol);
    if (S.open === o && sameAsk(ask, asked)) setBlame(blameText(b));
  } catch {
    // an untracked path and an unborn HEAD have nothing to blame, and this runs on every cursor
    // move: a toast per keystroke would bury the ones that matter. Rust logs every git call it
    // makes, so the failure is still on the record
    if (S.open === o && sameAsk(ask, asked)) setBlame(null);
  }
}
