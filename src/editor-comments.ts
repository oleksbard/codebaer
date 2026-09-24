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

/** One change removed all of from..to and put nothing in its place, as rejecting an added hunk
 *  does. touchesRange's "cover" misses a change that starts exactly at `from`. */
function deletes(tr: Transaction, from: number, to: number): boolean {
  let gone = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA <= from && toA >= to && !inserted.length) gone = true;
  });
  return gone;
}

function remap(marks: readonly Mark[], tr: Transaction): readonly Mark[] {
  if (!tr.docChanged || !marks.length) return marks;
  const old = tr.startState.doc;
  const doc = tr.newDoc;
  if (!replacesAll(tr)) {
    return marks.flatMap((m) => {
      const gone = m.to > m.from && deletes(tr, m.from, m.to);
      if (gone && m.key !== 'draft') return [];
      // both ends after anything inserted at them, so a line added at either edge stays outside
      const from = doc.lineAt(tr.changes.mapPos(m.from, 1)).from;
      let to = Math.max(from, tr.changes.mapPos(m.to, 1));
      if (to > from && to === doc.lineAt(to).from) to--;
      const lost = gone || !!m.lost;
      return [{ key: m.key, from, to: doc.lineAt(to).to, ...(lost ? { lost } : {}) }];
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
