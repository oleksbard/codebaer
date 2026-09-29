import {
  Annotation, Compartment, EditorState, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField,
  type ChangeSet, type Extension, type TransactionSpec,
} from '@codemirror/state';
import {
  Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, drawSelection, gutter, keymap, lineNumbers,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { foldEffect, foldedRanges, language, syntaxHighlighting, unfoldEffect } from '@codemirror/language';
import { getChunks, getOriginalDoc, updateOriginalDoc, type Chunk } from '@codemirror/merge';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { folding } from './editor';
import { editorDark, editorHighlight, editorTheme, setEditorDark } from './editor-theme';

// The working-tree editor stays the unified merge view that accept, reject, comments and folds all drive, with its
// inline deletions hidden, and a read-only editor of its original goes on its left. @codemirror/merge's MergeView
// would do the layout, but it makes both editors itself, and the app holds one long-lived view.

/** On what this module sends to the other editor, so that side does not send it back. */
const mirrored = Annotation.define<boolean>();

// ---------- spacers ----------
class Spacer extends WidgetType {
  constructor(readonly height: number) { super(); }
  override eq(other: Spacer): boolean { return this.height === other.height; }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-mergeSpacer';
    el.style.height = `${this.height}px`;
    return el;
  }
  override updateDOM(el: HTMLElement): boolean {
    el.style.height = `${this.height}px`;
    return true;
  }
  override get estimatedHeight(): number { return this.height; }
  override ignoreEvent(): boolean { return false; }
}

const adjustSpacers = StateEffect.define<DecorationSet>({ map: (v, m) => v.map(m) });
const spacers = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(adjustSpacers)) return e.value;
    return v.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// side 0 on the right puts a spacer after the merge view's zero-height deletion widget at the same position, so
// a deletion's Accept and Reject sit at the top of the gap it leaves, not under it
const spacer = (height: number, side: number) => Decoration.widget({ widget: new Spacer(height), block: true, side });
const heightOf = (d: Decoration): number => (d.spec as { widget: Spacer }).widget.height;

function sameSpacers(a: DecorationSet, b: DecorationSet): boolean {
  if (a.size !== b.size) return false;
  const i = a.iter();
  const j = b.iter();
  for (; i.value && j.value; i.next(), j.next()) {
    if (i.from !== j.from || Math.abs(heightOf(i.value) - heightOf(j.value)) > 1) return false;
  }
  return true;
}

const EPSILON = 0.01;

/** @codemirror/merge's updateSpacers, which it does not export: at the start of each run of unchanged lines, the
 *  side that reaches it higher up gets a spacer as tall as the difference. */
function align(a: EditorView, b: EditorView, chunks: readonly Chunk[]): void {
  const buildA = new RangeSetBuilder<Decoration>();
  const buildB = new RangeSetBuilder<Decoration>();
  const oldA = a.state.field(spacers).iter();
  const oldB = b.state.field(spacers).iter();
  let posA = 0;
  let posB = 0;
  let offA = 0;
  let offB = 0;
  const vpA = a.viewport;
  const vpB = b.viewport;
  for (let i = 0; ; i++) {
    const chunk = i < chunks.length ? chunks[i]! : null;
    const endA = chunk ? chunk.fromA : a.state.doc.length;
    const endB = chunk ? chunk.fromB : b.state.doc.length;
    if (posA < endA) {
      const diff = a.lineBlockAt(posA).top + offA - (b.lineBlockAt(posB).top + offB);
      if (diff < -EPSILON) { offA -= diff; buildA.add(posA, posA, spacer(-diff, -1)); }
      else if (diff > EPSILON) { offB += diff; buildB.add(posB, posB, spacer(diff, 0)); }
    }
    // a long unchanged run the viewport starts inside is lined up again at the viewport, since the heights above
    // it are estimates
    if (endA > posA + 1000 && posA < vpA.from && endA > vpA.from && posB < vpB.from && endB > vpB.from) {
      const off = Math.min(vpA.from - posA, vpB.from - posB);
      posA += off;
      posB += off;
      i--;
    } else if (!chunk) {
      break;
    } else {
      posA = chunk.toA;
      posB = chunk.toB;
    }
    for (; oldA.value && oldA.from < posA; oldA.next()) offA -= heightOf(oldA.value);
    for (; oldB.value && oldB.from < posB; oldB.next()) offB -= heightOf(oldB.value);
  }
  for (; oldA.value; oldA.next()) offA -= heightOf(oldA.value);
  for (; oldB.value; oldB.next()) offB -= heightOf(oldB.value);
  const docDiff = a.contentHeight + offA - (b.contentHeight + offB);
  if (docDiff < -EPSILON) buildA.add(a.state.doc.length, a.state.doc.length, spacer(-docDiff, 1));
  else if (docDiff > EPSILON) buildB.add(b.state.doc.length, b.state.doc.length, spacer(docDiff, 1));
  const decoA = buildA.finish();
  const decoB = buildB.finish();
  if (!sameSpacers(decoA, a.state.field(spacers))) a.dispatch({ effects: adjustSpacers.of(decoA) });
  if (!sameSpacers(decoB, b.state.field(spacers))) b.dispatch({ effects: adjustSpacers.of(decoB) });
}

const adjusting = (u: ViewUpdate): boolean => u.transactions.some((t) => t.effects.some((e) => e.is(adjustSpacers)));

// ---------- mapping between the sides ----------
/** A position on the other side: the same offset into unchanged text, and inside a chunk the start (bias -1) or
 *  the end (bias 1) of the chunk there. */
function across(pos: number, chunks: readonly Chunk[], toA: boolean, bias: -1 | 1): number {
  let out = pos;
  for (const c of chunks) {
    const [from, to, otherFrom, otherTo] = toA ? [c.fromB, c.toB, c.fromA, c.toA] : [c.fromA, c.toA, c.fromB, c.toB];
    if (pos < from) break;
    if (pos < to) return bias < 0 ? otherFrom : otherTo;
    out = otherTo + (pos - to);
  }
  return out;
}

type Range = [number, number];

function foldsOf(state: EditorState): Range[] {
  const out: Range[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { out.push([from, to]); });
  return out;
}

/** Folds on `to` what is folded in `from`: the changes-only folds, and a gap expanded on either side. */
function mirrorFolds(from: EditorState, to: EditorView, chunks: readonly Chunk[], toA: boolean): void {
  const len = to.state.doc.length;
  const want = foldsOf(from)
    .map(([f, t]): Range => [across(f, chunks, toA, 1), Math.min(across(t, chunks, toA, -1), len)])
    .filter(([f, t]) => f < t);
  const had = foldsOf(to.state);
  if (want.length === had.length && want.every(([f, t], i) => had[i]![0] === f && had[i]![1] === t)) return;
  to.dispatch({
    effects: [
      ...had.map(([f, t]) => unfoldEffect.of({ from: f, to: t })),
      ...want.map(([f, t]) => foldEffect.of({ from: f, to: t })),
    ],
    annotations: mirrored.of(true),
  });
}

// ---------- the left side ----------
const setChunks = StateEffect.define<readonly Chunk[]>();
const chunksOf = StateField.define<readonly Chunk[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setChunks)) v = e.value;
    return v;
  },
});

const changedLine = Decoration.line({ class: 'cm-changedLine' });
const changedMark = new (class extends GutterMarker { override elementClass = 'cm-changedLineGutter'; })();

/** The lines each chunk takes out, marked as the merge view marks the lines it adds, in the viewport only. */
const deletedLines = ViewPlugin.fromClass(class {
  lines: DecorationSet = Decoration.none;
  marks: RangeSet<GutterMarker> = RangeSet.empty;
  constructor(view: EditorView) { this.build(view); }
  update(u: ViewUpdate): void {
    const moved = u.state.field(chunksOf) !== u.startState.field(chunksOf);
    if (u.docChanged || u.viewportChanged || moved) this.build(u.view);
  }
  build(view: EditorView): void {
    const doc = view.state.doc;
    const { from, to } = view.viewport;
    const lines = new RangeSetBuilder<Decoration>();
    const marks = new RangeSetBuilder<GutterMarker>();
    for (const c of view.state.field(chunksOf)) {
      if (c.fromA >= to) break;
      if (c.fromA === c.toA || c.toA <= from) continue;
      const last = doc.lineAt(Math.min(c.endA, to, doc.length)).number;
      for (let n = doc.lineAt(Math.max(c.fromA, from)).number; n <= last; n++) {
        const at = doc.line(n).from;
        lines.add(at, at, changedLine);
        marks.add(at, at, changedMark);
      }
    }
    this.lines = lines.finish();
    this.marks = marks.finish();
  }
}, { decorations: (p) => p.lines });

const deletedGutter = Prec.low(gutter({
  class: 'cm-changeGutter',
  markers: (v) => v.plugin(deletedLines)?.marks ?? RangeSet.empty,
}));

/** Each working-tree editor's left side, and the sync instance of each one shown side by side. */
const panes = new WeakMap<EditorView, EditorView>();
const syncs = new WeakMap<EditorView, Sync>();
const frames = new WeakMap<EditorView, number>();

function schedule(right: EditorView): void {
  if (frames.has(right)) return;
  // layout cannot be read inside an update, and both sides have to have drawn
  frames.set(right, requestAnimationFrame(() => {
    frames.delete(right);
    const left = panes.get(right);
    if (left && syncs.has(right)) align(left, right, getChunks(right.state)?.chunks ?? []);
  }));
}

/** A click on the left puts the working tree's cursor on the same line, or on the start of the chunk it is in, so
 *  the hunk keys act on what was clicked. A drag that selected text leaves it. */
function clicked(e: MouseEvent, left: EditorView, right: EditorView): boolean {
  if (!left.state.selection.main.empty || !syncs.has(right)) return false;
  const pos = left.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos === null) return false;
  const chunks = left.state.field(chunksOf);
  const c = chunks.find((k) => k.fromA < k.toA && k.fromA <= pos && pos <= k.endA);
  const head = Math.min(c ? c.fromB : across(pos, chunks, false, 1), right.state.doc.length);
  right.dispatch({ selection: { anchor: head }, userEvent: 'select.pointer' });
  right.focus();
  return false;
}

function leftUpdated(u: ViewUpdate, right: EditorView): void {
  if (!syncs.has(right) || panes.get(right) !== u.view) return;
  if (!u.transactions.some((t) => t.annotation(mirrored)) && foldedRanges(u.state) !== foldedRanges(u.startState)) {
    mirrorFolds(u.state, right, u.state.field(chunksOf), false);
  }
  if ((u.heightChanged || u.viewportChanged) && !adjusting(u)) schedule(right);
}

function leftState(right: EditorView): EditorState {
  const s = right.state;
  return EditorState.create({
    doc: getOriginalDoc(s),
    extensions: [
      lineNumbers(),
      drawSelection(),
      EditorView.lineWrapping,
      highlightSelectionMatches(),
      editorTheme,
      editorDark(s.facet(EditorView.darkTheme)),
      syntaxHighlighting(editorHighlight),
      folding,
      s.facet(language)?.extension ?? [],
      keymap.of(searchKeymap),
      EditorState.readOnly.of(true),
      EditorView.editorAttributes.of({ class: 'cm-merge-a' }),
      chunksOf.init(() => getChunks(s)?.chunks ?? []),
      deletedLines,
      deletedGutter,
      spacers,
      EditorView.updateListener.of((u) => leftUpdated(u, right)),
      EditorView.domEventHandlers({ click: (e, v) => clicked(e, v, right) }),
    ],
  });
}

// ---------- the right side ----------
const chunkStart = Decoration.line({ class: 'cm-chunkStart' });

function starts(view: EditorView): DecorationSet {
  const { from, to } = view.viewport;
  const b = new RangeSetBuilder<Decoration>();
  for (const c of getChunks(view.state)?.chunks ?? []) {
    if (c.fromB >= to) break;
    const at = view.state.doc.lineAt(c.fromB).from;
    if (c.fromB < c.toB && c.toB > from) b.add(at, at, chunkStart);
  }
  return b.finish();
}

/** Marks each chunk's first line, which leaves room at its end for the chunk's buttons: side by side they sit over
 *  it, where unified they sit over the deleted lines. */
const chunkStarts = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = starts(view); }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged || getChunks(u.state)?.chunks !== getChunks(u.startState)?.chunks) {
      this.decorations = starts(u.view);
    }
  }
}, { decorations: (p) => p.decorations });

class Sync {
  constructor(readonly view: EditorView) {
    syncs.set(view, this);
    this.reset();
  }

  /** Starts the left side over from the working-tree editor's state. */
  reset(): void {
    const left = panes.get(this.view);
    const chunks = getChunks(this.view.state)?.chunks;
    if (!left || !chunks) return;
    left.setState(leftState(this.view));
    mirrorFolds(this.view.state, left, chunks, true);
    schedule(this.view);
  }

  update(u: ViewUpdate): void {
    const left = panes.get(u.view);
    const chunks = getChunks(u.state)?.chunks;
    if (!left || !chunks) return;
    let changes: ChangeSet | null = null;
    for (const t of u.transactions) {
      for (const e of t.effects) {
        if (e.is(updateOriginalDoc)) changes = changes ? changes.compose(e.value.changes) : e.value.changes;
      }
    }
    if (changes && changes.length !== left.state.doc.length) { this.reset(); return; }
    if (changes || chunks !== getChunks(u.startState)?.chunks) {
      const spec: TransactionSpec = { effects: setChunks.of(chunks), annotations: mirrored.of(true) };
      left.dispatch(changes ? { ...spec, changes } : spec);
    }
    const dark = u.state.facet(EditorView.darkTheme);
    if (dark !== u.startState.facet(EditorView.darkTheme)) setEditorDark(left, dark);
    if (!u.transactions.some((t) => t.annotation(mirrored)) && foldedRanges(u.state) !== foldedRanges(u.startState)) {
      mirrorFolds(u.state, left, chunks, true);
    }
    if ((u.docChanged || u.heightChanged || u.viewportChanged || changes) && !adjusting(u)) schedule(u.view);
  }

  destroy(): void {
    if (syncs.get(this.view) === this) syncs.delete(this.view);
    const f = frames.get(this.view);
    if (f !== undefined) { cancelAnimationFrame(f); frames.delete(this.view); }
  }
}

const sync = ViewPlugin.fromClass(Sync);
const slot = new Compartment();
const on: Extension = [spacers, sync, chunkStarts, EditorView.editorAttributes.of({ class: 'cm-side' })];

/** For a working-tree editor's state: `show` puts it side by side with its `originalPane`. */
export const sideBySide = (show: boolean): Extension => slot.of(show ? on : []);

/** A state without `sideBySide` stays as it is. */
export function setSideBySide(view: EditorView, show: boolean): void {
  if (syncs.has(view) === show) return;
  view.dispatch({ effects: slot.reconfigure(show ? on : []) });
}

export const isSideBySide = (view: EditorView): boolean => syncs.has(view);

/** The read-only editor of `right`'s original, made on first ask. The caller puts it on the left while `right` is
 *  side by side, and closes it with `closePane` when `right` goes. */
export function originalPane(right: EditorView): EditorView {
  let left = panes.get(right);
  if (!left) {
    left = new EditorView();
    panes.set(right, left);
    syncs.get(right)?.reset();
  }
  return left;
}

/** Takes the left side out of the page, for `right` shown unified again. */
export function detachPane(right: EditorView): void {
  panes.get(right)?.dom.remove();
}

export function closePane(right: EditorView): void {
  panes.get(right)?.destroy();
  panes.delete(right);
}
