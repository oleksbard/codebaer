import {
  StateEffect, StateField, type EditorState, type Extension, type Range, type Text, type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet } from '@codemirror/view';
import { getChunks, getOriginalDoc, type Chunk } from '@codemirror/merge';
import { langOf, reanchor, type Quote } from './comments';

/** `key` is `draft` or `c:<id>`; positions are the start of the first line and the end of the last.
 *  `lost` is only ever set on the draft: its lines are gone, and it was kept where they were. */
export type Mark = { key: string; from: number; to: number; lost?: boolean };

/** Replaces every mark; lines are 1-based and clamped to the document. */
export const setMarks = StateEffect.define<{ key: string; fromLine: number; toLine: number; lost?: boolean }[]>();

/** The controller registers its sync here, for the same reason as `onCursor`: after any change to
 *  a document that carries marks, it copies their new lines back into S. */
export const onComments = { run: () => {} };

// ---------- portal hosts ----------
// ponytail: one registry for the single editor there is; key it by view if a second one appears
const hosts = new Map<string, HTMLElement>();
const hostListeners = new Set<() => void>();
let hostVersion = 0;
let hostQueued = false;

/** On a microtask: hosts come and go inside CodeMirror's own update, where a synchronous React
 *  render would be reentrant. */
function hostsChanged(): void {
  if (hostQueued) return;
  hostQueued = true;
  queueMicrotask(() => {
    hostQueued = false;
    hostVersion++;
    for (const l of hostListeners) l();
  });
}

export const commentHost = (key: string): HTMLElement | undefined => hosts.get(key);
export const hostsVersion = (): number => hostVersion;
export function subscribeHosts(fn: () => void): () => void {
  hostListeners.add(fn);
  return () => { hostListeners.delete(fn); };
}

function register(key: string, el: HTMLElement): void {
  hosts.set(key, el);
  hostsChanged();
}

function unregister(key: string, el: HTMLElement): void {
  if (hosts.get(key) !== el) return;
  hosts.delete(key);
  hostsChanged();
}

/** An empty block that React portals a card or the draft box into. */
class Host extends WidgetType {
  constructor(readonly key: string) { super(); }
  override eq(other: Host): boolean { return other.key === this.key; }
  override toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-comment-host';
    register(this.key, el);
    return el;
  }
  override destroy(el: HTMLElement): void { unregister(this.key, el); }
  // the box's textarea and buttons handle their own keys, clicks and selection
  override ignoreEvent(): boolean { return true; }
  override get estimatedHeight(): number { return this.key === 'draft' ? 110 : 30; }
}

// ---------- ranges ----------
/** Whole lines, and a selection that ends at column 0 of a later line stops on the line before. */
export function lineRange(doc: Text, from: number, to: number): { from: number; to: number } {
  const first = doc.lineAt(from).number;
  let last = doc.lineAt(to);
  if (to > from && to === last.from && last.number > first) last = doc.line(last.number - 1);
  return { from: first, to: last.number };
}

const splitLines = (s: string): string[] => (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');

/** Capped, since an agent's new file or a rewritten block is one hunk, and its whole removed side
 *  would push the selected lines out of the quote. */
const MAX_REMOVED = 10;

function removedLines(orig: Text, c: Chunk): string[] {
  if (c.toA <= c.fromA) return [];
  const lines = splitLines(orig.sliceString(c.fromA, Math.min(c.toA, orig.length)));
  const shown = lines.slice(0, MAX_REMOVED).map((l) => `-${l}`);
  const more = lines.length - shown.length;
  return more > 0 ? [...shown, `(${more} more removed line${more === 1 ? '' : 's'} not shown)`] : shown;
}

function diffText(doc: Text, orig: Text, chunks: readonly Chunk[], from: number, to: number): string {
  const sorted = [...chunks].sort((a, b) => a.fromB - b.fromB);
  const out: string[] = [];
  let next = 0;
  for (let n = from; n <= to; n++) {
    const line = doc.line(n);
    // a hunk's removed lines go where the selection enters it
    for (; next < sorted.length && doc.lineAt(sorted[next]!.fromB).number <= n; next++) {
      out.push(...removedLines(orig, sorted[next]!));
    }
    const added = sorted.some((c) => c.toB > c.fromB && line.from >= c.fromB && line.from < c.toB);
    out.push(`${added ? '+' : ' '}${line.text}`);
  }
  return out.join('\n');
}

/** Lines from..to and their quote: a diff when they touch a hunk, so removed lines, which the
 *  unified view draws as a widget outside the document, can still be commented on. */
export function commentSpan(
  state: EditorState, path: string, fromLine: number, toLine: number,
): { from: number; to: number; anchor: string; quote: Quote } {
  const doc = state.doc;
  const from = Math.max(1, Math.min(fromLine, doc.lines));
  const to = Math.max(from, Math.min(toLine, doc.lines));
  const a = doc.line(from).from;
  const b = doc.line(to).to;
  // the overlap test chunkIndexAtCursor uses, so a removal counts from the line it sits on
  const touched = (getChunks(state)?.chunks ?? []).filter((c) => c.fromB <= b && c.endB >= a);
  const anchor = doc.sliceString(a, b);
  const quote: Quote = touched.length
    ? { t: 'diff', text: diffText(doc, getOriginalDoc(state), touched, from, to) }
    : { t: 'code', lang: langOf(path), text: anchor };
  return { from, to, anchor, quote };
}

function marksFromLines(doc: Text, key: string, from: number, to: number, lost = false): Mark {
  const a = Math.max(1, Math.min(from, doc.lines));
  const b = Math.max(a, Math.min(to, doc.lines));
  return { key, from: doc.line(a).from, to: doc.line(b).to, ...(lost ? { lost } : {}) };
}

/** A refresh's replaceDoc is one change over the whole document, and mapping through it would
 *  collapse every mark to one end. */
function replacesAll(tr: Transaction): boolean {
  let n = 0;
  let all = false;
  tr.changes.iterChanges((fromA, toA) => {
    n++;
    all = fromA === 0 && toA === tr.startState.doc.length;
  });
  return n === 1 && all;
}

export type Edit = { fromA: number; toA: number; fromB: number; toB: number };

/** The edit that removed the character at pos, if one did; `edits` come sorted and apart. */
function removedBy(edits: readonly Edit[], pos: number): Edit | undefined {
  let lo = 0;
  let hi = edits.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = edits[mid]!;
    if (pos < e.fromA) hi = mid - 1;
    else if (pos >= e.toA) lo = mid + 1;
    else return e;
  }
  return undefined;
}

/** `tr.changes.mapPos` for positions asked in non-decreasing order, in time linear in the edits
 *  overall rather than per call: an edit on every line would otherwise make mapping quadratic. */
export class PosMapper {
  private i = 0;
  constructor(private readonly edits: readonly Edit[]) {}

  map(pos: number, assoc: -1 | 1): number {
    const es = this.edits;
    while (this.i < es.length && es[this.i]!.toA < pos) this.i++;
    const prev = es[this.i - 1];
    let delta = prev ? prev.toB - prev.toA : 0;
    for (let j = this.i; j < es.length; j++) {
      const e = es[j]!;
      if (e.fromA > pos) break;
      if (e.toA > pos || (e.toA === e.fromA && assoc < 0)) return pos === e.fromA || assoc < 0 ? e.fromB : e.toB;
      delta = e.toB - e.toA;
    }
    return pos + delta;
  }
}

/**
 * Where old line n went, by the characters of it that survived the edit: the new line of its
 * first surviving non-blank character, or its last when `last` is set, so a line split by Enter
 * spans both halves. Indenting, commenting out, typing, Enter at either edge and joining lines all
 * keep some of a line's characters, and positions say exactly where they went. A line left with no
 * text, or that had none, is still the same line while its line breaks are: clearing a line keeps
 * it, and so does deleting whole lines above a blank one. Null when the line itself is gone.
 */
function survivor(
  tr: Transaction, edits: readonly Edit[], map: PosMapper, n: number, last: boolean,
): number | null {
  const old = tr.startState.doc;
  const line = old.line(n);
  const t = line.text;
  for (let k = 0; k < t.length; k++) {
    const i = last ? t.length - 1 - k : k;
    if (/\s/.test(t[i]!) || removedBy(edits, line.from + i)) continue;
    return tr.newDoc.lineAt(map.map(line.from + i, 1)).number;
  }
  // a removed break joins this line to the text the removal started after, or ended before
  const below = line.to < old.length ? removedBy(edits, line.to) : undefined;
  if (below && (/\S/.test(t) || /\S/.test(old.sliceString(below.toA, old.lineAt(below.toA).to)))) return null;
  const above = line.from > 0 ? removedBy(edits, line.from - 1) : undefined;
  if (above && (/\S/.test(t) || /\S/.test(old.sliceString(old.lineAt(above.fromA).from, above.fromA)))) return null;
  // text replaced in place, a paste over the line say, starts where its replacement starts
  const lead = t.search(/\S/);
  const at = !last && lead >= 0 ? map.map(line.from + lead, -1)
    : line.to < old.length && !below ? map.map(line.to, 1) : map.map(line.from, -1);
  return tr.newDoc.lineAt(at).number;
}

/** New lines made entirely of inserted text, by their text, where that text is unique. */
function insertedLines(tr: Transaction, edits: readonly Edit[]): Map<string, number | null> {
  const doc = tr.newDoc;
  const out = new Map<string, number | null>();
  for (const e of edits) {
    if (e.toB === e.fromB) continue;
    for (let l = doc.lineAt(e.fromB); ; l = doc.line(l.number + 1)) {
      if (l.from >= e.fromB && l.to <= e.toB && /\S/.test(l.text)) out.set(l.text, out.has(l.text) ? null : l.number);
      if (l.to >= e.toB || l.number === doc.lines) break;
    }
  }
  return out;
}

/** Lines from..to after the edit. A line with nothing left of it goes to a unique inserted copy of
 *  its text (a moved line), else to the replacement's line at its offset (a rejected hunk or a paste
 *  over it), else nowhere. A moved line far from the rest no longer belongs to the comment. */
function remapLines(
  tr: Transaction, edits: readonly Edit[], inserted: () => Map<string, number | null>, from: number, to: number,
): { from: number; to: number } | null {
  const old = tr.startState.doc;
  const doc = tr.newDoc;
  const map = new PosMapper(edits);
  const kept: number[] = [];
  const moved: number[] = [];
  for (let n = from; n <= to; n++) {
    const first = survivor(tr, edits, map, n, false);
    if (first !== null) {
      kept.push(first, survivor(tr, edits, map, n, true) ?? first);
      continue;
    }
    const line = old.line(n);
    const copy = /\S/.test(line.text) ? inserted().get(line.text) : undefined;
    if (copy) { moved.push(copy); continue; }
    const lead = line.text.search(/\S/);
    const e = removedBy(edits, lead < 0 ? Math.max(0, line.from - 1) : line.from + lead)
      ?? removedBy(edits, line.to);
    if (e && e.toB > e.fromB) {
      const top = doc.lineAt(e.fromB).number;
      const count = doc.lineAt(Math.max(e.fromB, e.toB - 1)).number - top + 1;
      const offset = n - old.lineAt(e.fromA).number;
      if (offset < count) kept.push(top + offset);
    }
  }
  if (!kept.length && !moved.length) return null;
  // a loop, not a spread: a comment over a whole large file has more lines than a call takes arguments
  const base = kept.length ? kept : moved;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of base) { lo = Math.min(lo, n); hi = Math.max(hi, n); }
  for (const m of [...moved].sort((a, b) => a - b)) {
    if (m >= lo - 1 && m <= hi + 1) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
  }
  return { from: lo, to: hi };
}

function remap(marks: readonly Mark[], tr: Transaction): readonly Mark[] {
  if (!tr.docChanged || !marks.length) return marks;
  const old = tr.startState.doc;
  const doc = tr.newDoc;
  if (!replacesAll(tr)) {
    const edits: Edit[] = [];
    tr.changes.iterChanges((fromA, toA, fromB, toB) => { edits.push({ fromA, toA, fromB, toB }); });
    let found: Map<string, number | null> | null = null;
    const inserted = () => (found ??= insertedLines(tr, edits));
    return marks.flatMap((m) => {
      const r = remapLines(tr, edits, inserted, old.lineAt(m.from).number, old.lineAt(m.to).number);
      if (r) return [marksFromLines(doc, m.key, r.from, r.to, !!m.lost)];
      if (m.key !== 'draft') return [];
      // every line of the draft went; it stays where they were, to keep what is being typed
      const at = doc.lineAt(tr.changes.mapPos(m.from, 1)).number;
      return [marksFromLines(doc, m.key, at, at, true)];
    });
  }
  const lines = doc.toString().split('\n');
  return marks.flatMap((m) => {
    const first = old.lineAt(m.from).number;
    const last = old.lineAt(m.to).number;
    // a lost draft sits on text that was never commented, which must not count as finding it again
    const at = m.lost ? null : reanchor(lines, old.sliceString(m.from, m.to), first);
    if (at !== null) return [marksFromLines(doc, m.key, at, at + last - first)];
    // the draft is being written, so it stays at its old lines rather than vanishing under the typist
    return m.key === 'draft' ? [marksFromLines(doc, m.key, first, last, true)] : [];
  });
}

const commented = Decoration.line({ class: 'cm-commented' });

function decorate(doc: Text, marks: readonly Mark[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const m of marks) {
    const last = doc.lineAt(m.to).number;
    for (let n = doc.lineAt(m.from).number; n <= last; n++) ranges.push(commented.range(doc.line(n).from));
    ranges.push(Decoration.widget({ widget: new Host(m.key), block: true, side: 1 }).range(m.to));
  }
  return Decoration.set(ranges, true);
}

type Value = { marks: readonly Mark[]; decos: DecorationSet };

const field = StateField.define<Value>({
  create: () => ({ marks: [], decos: Decoration.none }),
  update(v, tr) {
    let marks = remap(v.marks, tr);
    for (const e of tr.effects) {
      if (e.is(setMarks)) marks = e.value.map((p) => marksFromLines(tr.newDoc, p.key, p.fromLine, p.toLine, p.lost));
    }
    if (marks === v.marks) return v;
    return { marks, decos: decorate(tr.newDoc, marks) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

export const marksOf = (state: EditorState): readonly Mark[] => state.field(field, false)?.marks ?? [];

// ---------- the chip ----------
/** Stable, so CodeMirror keeps one tooltip view and only moves it as the selection changes. */
function createChip() {
  const dom = document.createElement('div');
  dom.className = 'cm-comment-chip-host';
  register('chip', dom);
  return { dom, destroy: () => unregister('chip', dom) };
}

const chip = showTooltip.compute(['selection', field], (state) => {
  const sel = state.selection.main;
  if (sel.empty || state.field(field).marks.some((m) => m.key === 'draft')) return null;
  return { pos: sel.head, above: sel.head < sel.anchor, strictSide: false, arrow: false, create: createChip };
});

/** Hides the chip while a mouse selection is still being dragged out. */
const dragging = ViewPlugin.define((view) => {
  const up = () => view.dom.classList.remove('cm-comment-dragging');
  document.addEventListener('mouseup', up);
  return { destroy: () => document.removeEventListener('mouseup', up) };
}, {
  eventHandlers: {
    mousedown(e, view) { if (e.button === 0) view.dom.classList.add('cm-comment-dragging'); },
  },
});

export const commentsExtension: Extension = [
  field,
  chip,
  dragging,
  EditorView.updateListener.of((u) => { if (u.docChanged && marksOf(u.startState).length) onComments.run(); }),
];
