import { RangeSetBuilder, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** Line numbers of one conflict's markers; `base` is the `|||||||` line that diff3 and zdiff3 add. `ambiguous`: a
 *  side has a `=======` line of its own, so which one git wrote as the separator cannot be told. */
export type Conflict = { start: number; base: number | null; mid: number; end: number; ambiguous: boolean };
export type Keep = 'current' | 'incoming' | 'both';

// git's default conflict-marker-size; a merge attribute can change it, which this does not follow
const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const MID = /^={7}$/;
const END = /^>{7}(?: |$)/;

export function parseConflicts(doc: Text): Conflict[] {
  const found: Conflict[] = [];
  let cur: { start: number; base: number | null; mid: number | null; ambiguous: boolean } | null = null;
  let n = 0;
  for (const iter = doc.iterLines(); !iter.next().done;) {
    n++;
    const line = iter.value;
    // a second start before the end means the first was not a conflict: the later one wins
    if (START.test(line)) cur = { start: n, base: null, mid: null, ambiguous: false };
    else if (!cur) continue;
    else if (cur.mid === null && cur.base === null && BASE.test(line)) cur.base = n;
    else if (MID.test(line)) {
      if (cur.mid === null) cur.mid = n;
      else cur.ambiguous = true;
    } else if (cur.mid !== null && END.test(line)) {
      found.push({ start: cur.start, base: cur.base, mid: cur.mid, end: n, ambiguous: cur.ambiguous });
      cur = null;
    }
  }
  return found;
}

/** The text that replaces the conflict's lines, the line break after the end marker included. */
function resolution(doc: Text, c: Conflict, keep: Keep): { from: number; to: number; insert: string } {
  const body = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let i = from; i < to; i++) out.push(doc.line(i).text);
    return out;
  };
  const current = body(c.start + 1, c.base ?? c.mid);
  const incoming = body(c.mid + 1, c.end);
  const kept = keep === 'current' ? current : keep === 'incoming' ? incoming : [...current, ...incoming];
  const end = doc.line(c.end);
  const last = end.to === doc.length;
  return {
    from: doc.line(c.start).from,
    to: last ? end.to : end.to + 1,
    insert: kept.length ? kept.join('\n') + (last ? '' : '\n') : '',
  };
}

export function resolveConflict(view: EditorView, c: Conflict, keep: Keep): void {
  if (c.ambiguous) return;
  const change = resolution(view.state.doc, c, keep);
  view.dispatch({ changes: change, selection: { anchor: change.from }, userEvent: 'input.resolve' });
  view.focus();
}

class Actions extends WidgetType {
  constructor(readonly label: string, readonly buttons: boolean) { super(); }

  override eq(other: Actions): boolean { return other.label === this.label && other.buttons === this.buttons; }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-conflictActions';
    const tag = document.createElement('span');
    tag.className = 'cm-conflictTag';
    tag.textContent = this.label;
    wrap.append(tag);
    if (!this.buttons) return wrap;
    const keeps: [Keep, string][] = [['current', 'Keep current'], ['incoming', 'Keep incoming'], ['both', 'Keep both']];
    for (const [keep, text] of keeps) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.name = keep;
      // the widget is reused while lines above it change, so the conflict is looked up at the click
      b.onclick = (e) => {
        e.preventDefault();
        const line = view.state.doc.lineAt(view.posAtDOM(wrap)).number;
        const c = view.state.field(conflictField).list.find((x) => x.start === line);
        if (c) resolveConflict(view, c, keep);
      };
      wrap.append(b);
    }
    return wrap;
  }

  override ignoreEvent(): boolean { return true; }
}

const line = (cls: string): Decoration => Decoration.line({ class: cls });
const CURRENT = line('cm-conflict cm-conflictCurrent');
const BASE_SIDE = line('cm-conflict cm-conflictBase');
const INCOMING = line('cm-conflict cm-conflictIncoming');
const HEAD_CURRENT = line('cm-conflict cm-conflictCurrent cm-conflictHead');
const HEAD_BASE = line('cm-conflict cm-conflictBase cm-conflictHead');
const SEP = line('cm-conflict cm-conflictSep');
const HEAD_INCOMING = line('cm-conflict cm-conflictIncoming cm-conflictHead');
const MARKER = Decoration.mark({ class: 'cm-conflictMarker' });
const actions = (label: string, buttons: boolean): Decoration =>
  Decoration.widget({ widget: new Actions(label, buttons), side: 1 });

function decorate(doc: Text, conflicts: readonly Conflict[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const head = (n: number, deco: Decoration, label: string, buttons: boolean): void => {
    const l = doc.line(n);
    b.add(l.from, l.from, deco);
    b.add(l.from, l.from + 7, MARKER);
    b.add(l.to, l.to, actions(label, buttons));
  };
  const body = (from: number, to: number, deco: Decoration): void => {
    for (let i = from; i < to; i++) b.add(doc.line(i).from, doc.line(i).from, deco);
  };
  for (const c of conflicts) {
    if (c.ambiguous) {
      head(c.start, HEAD_BASE, 'two ======= lines, edit by hand', false);
      body(c.start + 1, c.end, BASE_SIDE);
      head(c.end, HEAD_BASE, 'end of conflict', false);
      continue;
    }
    head(c.start, HEAD_CURRENT, 'current change', true);
    body(c.start + 1, c.base ?? c.mid, CURRENT);
    if (c.base !== null) {
      head(c.base, HEAD_BASE, 'common ancestor', false);
      body(c.base + 1, c.mid, BASE_SIDE);
    }
    const mid = doc.line(c.mid);
    b.add(mid.from, mid.from, SEP);
    b.add(mid.from, mid.to, MARKER);
    body(c.mid + 1, c.end, INCOMING);
    head(c.end, HEAD_INCOMING, 'incoming change', false);
  }
  return b.finish();
}

type Found = { list: Conflict[]; deco: DecorationSet };

function find(doc: Text): Found {
  const list = parseConflicts(doc);
  return { list, deco: decorate(doc, list) };
}

const conflictField = StateField.define<Found>({
  create: (state) => find(state.doc),
  update: (value, tr) => (tr.docChanged ? find(tr.state.doc) : value),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** For the conflict editor: colours each side of every conflict and puts the keep buttons on its first line. */
export const conflictMarkers: Extension = conflictField;

export function conflicts(state: EditorState): readonly Conflict[] {
  return state.field(conflictField, false)?.list ?? [];
}

/** Puts the cursor on the first conflict's start marker and scrolls it to the middle of the editor. */
export function selectFirstConflict(view: EditorView): void {
  const c = conflicts(view.state)[0];
  if (!c) return;
  const at = view.state.doc.line(c.start).from;
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
}

/** The conflict the cursor is in, or -1. */
export function conflictIndexAtCursor(state: EditorState): number {
  const at = state.doc.lineAt(state.selection.main.head).number;
  return conflicts(state).findIndex((c) => c.start <= at && at <= c.end);
}
