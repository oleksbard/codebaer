import { Chunk } from '@codemirror/merge';
import { RangeSet, RangeSetBuilder, StateEffect, StateField, Text } from '@codemirror/state';
import { GutterMarker, lineNumberMarkers } from '@codemirror/view';
import { view } from '#core/session';
import type { Open } from '#core/state';
import { git } from '#ipc/git';
import { S } from '#kernel/store';

export const setBase = StateEffect.define<Text | null>();

class Mark extends GutterMarker {
  constructor(override readonly elementClass: string) { super(); }
}
const added = new Mark('cm-branchLine cm-branchAdded');
const modified = new Mark('cm-branchLine cm-branchModified');
const deleted = new Mark('cm-branchLine cm-branchDeleted');

function marksOf(chunks: readonly Chunk[], doc: Text): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  let next = 1;
  for (const c of chunks) {
    const first = doc.lineAt(Math.min(c.fromB, doc.length)).number;
    // a chunk that only deletes is empty in the document, and marks the line it was deleted before
    const mark = c.fromB === c.toB ? deleted : c.fromA === c.toA ? added : modified;
    const last = mark === deleted ? first : doc.lineAt(Math.min(c.endB, doc.length)).number;
    for (let n = Math.max(first, next); n <= last; n++) b.add(doc.line(n).from, doc.line(n).from, mark);
    next = Math.max(next, last + 1);
  }
  return b.finish();
}

type Lines = { base: Text | null; chunks: readonly Chunk[]; marks: RangeSet<GutterMarker> };
const none: Lines = { base: null, chunks: [], marks: RangeSet.empty };

/** The lines the branch changed against main, committed or not, on the line numbers. */
export const lineMarks = StateField.define<Lines>({
  create: () => none,
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(setBase)) continue;
      if (!e.value) return none;
      const chunks = Chunk.build(e.value, tr.state.doc);
      return { base: e.value, chunks, marks: marksOf(chunks, tr.state.doc) };
    }
    if (!tr.docChanged || !v.base) return v;
    const chunks = Chunk.updateB(v.chunks, v.base, tr.state.doc, tr.changes);
    return { base: v.base, chunks, marks: marksOf(chunks, tr.state.doc) };
  },
  provide: (f) => lineNumberMarkers.from(f, (v) => v.marks),
});

let loaded: { open: Open; head: string | null } | null = null;

/** `fresh` reads again for the same file and HEAD, which a newly built editor state needs. */
export async function loadBase(fresh: boolean): Promise<void> {
  const o = S.open;
  const head = S.status?.head ?? null;
  if (!fresh && loaded?.open === o && loaded.head === head) return;
  loaded = o ? { open: o, head } : null;
  if (!o || o.panel) return;
  let base: Text | null = null;
  try {
    const blob = await git.branchBase(o.path);
    if (blob) base = Text.of(blob.text.split('\n'));
  } catch {
    // a binary, too large or conflicted file has nothing to mark, and its view already says why
  }
  if (S.open === o && loaded?.open === o && loaded.head === head) view.dispatch({ effects: setBase.of(base) });
}
