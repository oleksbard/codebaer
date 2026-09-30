import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { getChunks, type Chunk } from '@codemirror/merge';
import { DUR, EASE, heavyMotion, motionLevel } from '#ui/motion';
import { chunkIndexAtCursor } from './editor';
import { isSideBySide, originalPane } from './side-by-side';

export type GhostTone = 'accept' | 'reject' | 'unstage';

const EASE_STD = `cubic-bezier(${EASE.std.join(',')})`;
const STILL = globalThis.matchMedia('(prefers-reduced-motion: reduce)');

type Rect = { top: number; height: number };

/** A chunk's own rect in a plain pane (side by side): the range's first to last line, or null with nothing on
 *  this side (a pure addition has none on the original pane, a pure deletion none on the working one). */
function plainRect(view: EditorView, from: number, to: number): Rect | null {
  if (from === to) return null;
  const first = view.lineBlockAt(from);
  const last = view.lineBlockAt(Math.max(from, to - 1));
  return { top: first.top, height: last.bottom - first.top };
}

/** The unified view's rect: `lineBlockAt` joins the deletion widget above `fromB` with the line it sits above,
 *  which is one line too many for a chunk that only deletes (that line is unchanged context); that case takes
 *  the widget's own piece of the join instead of the whole thing. */
function unifiedRect(view: EditorView, chunk: Chunk): Rect {
  const first = view.lineBlockAt(chunk.fromB);
  if (chunk.fromB === chunk.toB) {
    const parts = Array.isArray(first.type) ? first.type : [first];
    const widget = parts.find((p) => p.widget) ?? first;
    return { top: widget.top, height: widget.height };
  }
  const last = view.lineBlockAt(chunk.toB - 1);
  return { top: first.top, height: last.bottom - first.top };
}

function place(view: EditorView, rect: Rect, tone: GhostTone): void {
  const el = document.createElement('div');
  el.className = `cm-ghost ${tone}`;
  el.style.top = `${rect.top + view.documentPadding.top}px`;
  el.style.height = `${rect.height}px`;
  view.scrollDOM.appendChild(el);
  const collapse = heavyMotion() && !STILL.matches;
  const frames: Keyframe[] = collapse
    ? [{ opacity: 1, height: `${rect.height}px` }, { opacity: 0, height: '0px' }]
    : [{ opacity: 1 }, { opacity: 0 }];
  const anim = el.animate(frames, { duration: DUR[3] * 1000, easing: EASE_STD, fill: 'forwards' });
  anim.finished.then(() => el.remove(), () => el.remove());
}

/** Ghosts the chunk under `view`'s cursor, tinted for what is about to happen to it. Call this just before
 *  `acceptChunk`/`rejectChunk`, which is when the chunk this measures still exists; it does not wait for
 *  either of them, or for the git call that follows. `unstage` never runs side by side: the staged view has
 *  no split. */
export function ghostChunk(view: EditorView, tone: GhostTone): void {
  if (motionLevel() === 'off') return;
  const idx = chunkIndexAtCursor(view.state);
  const chunk = getChunks(view.state)?.chunks[idx];
  if (!chunk) return;
  if (isSideBySide(view)) {
    const left = originalPane(view);
    const a = plainRect(left, chunk.fromA, chunk.toA);
    if (a) place(left, a, tone);
    const b = plainRect(view, chunk.fromB, chunk.toB);
    if (b) place(view, b, tone);
    return;
  }
  place(view, unifiedRect(view, chunk), tone);
}

// ---------- landing flash ----------
const setFlash = StateEffect.define<{ at: number; gen: number }>();
/** The generation to clear: a stale timer from a flash a newer one already replaced is a no-op. */
const clearFlash = StateEffect.define<number>();
const flashLine = Decoration.line({ class: 'cm-landingFlash' });
// module-wide, not per state: opening a file replaces the state, and a counter that restarted with it would let
// the last file's timer match, and cut short, the new file's flash
let flashGen = 0;

type Flash = { deco: DecorationSet; gen: number };

/** Add to a merge view's extensions for `flashLanding` to have anywhere to dispatch its effects to. */
export const landingFlash = StateField.define<Flash>({
  create: () => ({ deco: Decoration.none, gen: 0 }),
  update({ deco, gen }, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) { gen = e.value.gen; deco = Decoration.set([flashLine.range(e.value.at)]); }
      else if (e.is(clearFlash) && e.value === gen) deco = Decoration.none;
    }
    return { deco, gen };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Flashes the first line of the chunk under `view`'s cursor once, to orient the eye after it jumps there. A
 *  colour change, not movement, so it plays under `lite` and reduced motion, unlike the ghost. */
export function flashLanding(view: EditorView): void {
  const idx = chunkIndexAtCursor(view.state);
  const chunk = getChunks(view.state)?.chunks[idx];
  if (!chunk) return;
  const at = view.state.doc.lineAt(Math.min(chunk.fromB, view.state.doc.length)).from;
  const gen = ++flashGen;
  view.dispatch({ effects: setFlash.of({ at, gen }) });
  setTimeout(() => view.dispatch({ effects: clearFlash.of(gen) }), DUR[5] * 1000);
}
