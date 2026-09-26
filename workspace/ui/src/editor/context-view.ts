import { foldEffect, foldable, forceParsing, unfoldAll } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { getChunks } from '@codemirror/merge';
import { Facet, type EditorState } from '@codemirror/state';

export type LineRange = { first: number; last: number };

/** Lines a feature needs kept visible when the unchanged ones fold away, e.g. commented ones. */
export const keepVisible = Facet.define<(state: EditorState) => readonly LineRange[]>();

const FALLBACK = 3;
// ponytail: an encloser longer than this contributes only its header line, so a change on a class
// or module header cannot keep the whole file; raise it if real methods start getting clipped
const WHOLE_MAX = 80;

/**
 * Line ranges the changes-only view leaves visible: every chunk with the block it lives in
 * whole, and one header line for each outer block around it, plus every range a `keepVisible` provider names.
 */
export function keepRanges(state: EditorState): LineRange[] {
  const doc = state.doc;
  const chunks = getChunks(state)?.chunks ?? [];
  // no chunks folds nothing at all, so comments alone never collapse a plain or accepted file
  if (!chunks.length) return [];
  const out: LineRange[] = state.facet(keepVisible).flatMap((f) => f(state));
  for (const c of chunks) {
    const first = doc.lineAt(c.fromB).number;
    const last = doc.lineAt(c.endB).number;
    out.push({ first, last });
    let whole = false;
    // starts above the chunk: a block the change itself opens is the change, not context around it
    for (let n = first - 1; n >= 1; n--) {
      const line = doc.line(n);
      const fold = foldable(state, line.from, line.to);
      if (!fold) continue;
      // foldable() reports the range opened by line n, so it encloses the chunk only if it ends below it
      const end = doc.lineAt(fold.to).number;
      if (end < last) continue;
      if (whole || end - n > WHOLE_MAX) { out.push({ first: n, last: n }); continue; }
      out.push({ first: n, last: end });
      whole = true;
    }
    if (!whole) out.push({ first: Math.max(1, first - FALLBACK), last: Math.min(doc.lines, last + FALLBACK) });
  }
  return union(out);
}

function union(ranges: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.first - b.first)) {
    const prev = out[out.length - 1];
    // +2, not +1: a lone line between two kept ranges costs a placeholder line to hide one line
    if (prev && r.first <= prev.last + 2) prev.last = Math.max(prev.last, r.last);
    else out.push({ ...r });
  }
  return out;
}

export function foldToChanges(view: EditorView): void {
  // ponytail: 150ms of parsing, past which foldable() sees no tree and those chunks take the
  // ±3-line fallback; raise the budget if a real file ever comes out short
  forceParsing(view, view.state.doc.length, 150);
  unfoldAll(view);
  const keep = keepRanges(view.state);
  if (!keep.length) return;
  const doc = view.state.doc;
  const effects: ReturnType<typeof foldEffect.of>[] = [];
  // from line start to line end, never across the line break, so a gap collapses onto its own line
  const fold = (first: number, last: number) => {
    const from = doc.line(first).from;
    const to = doc.line(last).to;
    // a gap of one blank line is a zero-length range, which CodeMirror rejects as a replacement decoration
    if (from < to) effects.push(foldEffect.of({ from, to }));
  };
  let n = 1;
  for (const r of keep) {
    if (r.first > n) fold(n, r.first - 1);
    n = r.last + 1;
  }
  if (n <= doc.lines) fold(n, doc.lines);
  if (effects.length) view.dispatch({ effects });
}
