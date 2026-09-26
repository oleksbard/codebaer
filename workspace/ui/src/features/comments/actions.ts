import { EditorView } from '@codemirror/view';
import type { StateEffect } from '@codemirror/state';
import { foldedRanges, unfoldEffect } from '@codemirror/language';
import { buildQueue, plural } from '#core/model';
import { flush, openPlain, openRow, view } from '#core/session';
import type { Open } from '#core/state';
import { homeFrom, selectTerminal, statusLabel, termLabels, terminalsOf } from '#features/terminals';
import { errText } from '#ipc/git';
import { input } from '#ipc/terminal';
import { confirmDialog, toast } from '#kernel/dialogs';
import { pick } from '#kernel/pick';
import { sleep } from '#kernel/sleep';
import { notify, S, type DeepReadonly } from '#kernel/store';
import { eligible, format, locate, location, pastePayload, takesComments, type Draft, type Side } from './comments';
import { commentSpan, lineRange, marksOf, setMarks, type Mark } from './editor-comments';

/** Some TUIs read an Enter that arrives in the same read as a paste as part of the paste. */
const SUBMIT_DELAY_MS = 120;
let nextComment = 1;

const sideOf = (o: Open): Side => (o.view === 'staged' ? 'index' : 'work');

type Shown = { path: string; side: Side };

/** The open file and side, when its editor can show comments at all. */
function shown(): Shown | null {
  const o = S.open;
  return o && !o.panel ? { path: o.path, side: sideOf(o) } : null;
}

const here = (c: Shown, at: Shown | null): boolean => !!at && c.path === at.path && c.side === at.side;

/** Text differs from what the box opened with, so closing it would lose something. */
function unsaved(d: Draft): boolean {
  const text = d.text.trim();
  const was = d.editing === null ? '' : S.comments.find((c) => c.id === d.editing)?.text ?? '';
  return !!text && text !== was;
}

function placeComments(): void {
  const at = shown();
  if (!at) return;
  const marks: { key: string; fromLine: number; toLine: number; lost?: boolean }[] = S.comments
    .filter((c) => here(c, at) && !c.moved && S.draft?.editing !== c.id)
    .map((c) => ({ key: `c:${c.id}`, fromLine: c.from, toLine: c.to }));
  const d = S.draft;
  if (d && here(d, at)) marks.push({ key: 'draft', fromLine: d.from, toLine: d.to, lost: d.lost });
  view.dispatch({ effects: setMarks.of(marks) });
}

/** A file may have changed while it was closed, so each comment is checked against its anchor
 *  before it is placed in a freshly opened editor. */
export function showComments(): void {
  const at = shown();
  // the card being edited goes where its draft goes
  const mine = S.comments.filter((c) => here(c, at) && !c.moved && S.draft?.editing !== c.id);
  const d = S.draft && here(S.draft, at) ? S.draft : null;
  if (!mine.length && !d) return;
  const lines = view.state.doc.toString().split('\n');
  for (const c of mine) {
    const r = locate(lines, c);
    if (r) { c.from = r.from; c.to = r.to; } else c.moved = true;
  }
  const r = d && !d.lost ? locate(lines, d) : null;
  if (d && r) { d.from = r.from; d.to = r.to; } else if (d) d.lost = true;
  const edited = d?.editing == null ? undefined : S.comments.find((c) => c.id === d.editing);
  if (edited && d?.lost) edited.moved = true;
  else if (edited && r) Object.assign(edited, r);
  placeComments();
}

/** The editor maps the marks through every edit; this copies their lines back into S. */
export function syncComments(): void {
  const at = shown();
  if (!at) return;
  const doc = view.state.doc;
  const marks = new Map(marksOf(view.state).map((m) => [m.key, m]));
  const read = (m: Mark) => {
    const from = doc.lineAt(m.from).number;
    const to = doc.lineAt(m.to).number;
    return { from, to, anchor: doc.sliceString(doc.line(from).from, doc.line(to).to) };
  };
  for (const c of S.comments) {
    if (!here(c, at) || c.moved || S.draft?.editing === c.id) continue;
    const m = marks.get(`c:${c.id}`);
    if (m) Object.assign(c, read(m));
    else c.moved = true;
  }
  const d = S.draft;
  const dm = marks.get('draft');
  if (d && dm && here(d, at)) {
    const r = read(dm);
    Object.assign(d, r);
    if (dm.lost) d.lost = true;
    // the card being edited has no mark of its own, and Cancel puts it back where the draft is now
    const edited = d.editing === null ? undefined : S.comments.find((c) => c.id === d.editing);
    if (edited && d.lost) edited.moved = true;
    else if (edited) Object.assign(edited, r);
  }
  notify();
}

/** Scroll and unfold effects that bring lines from..to into view. */
function revealLines(from: number, to: number, y: 'center' | 'nearest'): StateEffect<unknown>[] {
  const doc = view.state.doc;
  const a = doc.line(Math.min(from, doc.lines)).from;
  const b = doc.line(Math.min(to, doc.lines)).to;
  // the margin leaves room for the box drawn under the last line
  const effects: StateEffect<unknown>[] = [EditorView.scrollIntoView(y === 'center' ? a : b, { y, yMargin: 140 })];
  foldedRanges(view.state).between(a, b, (f, t) => { effects.push(unfoldEffect.of({ from: f, to: t })); });
  return effects;
}

/** A box scrolled out of the viewport or folded away has no DOM, so this brings it back and lets
 *  the box take focus when it mounts. */
function focusDraft(d: Draft): void {
  d.focus = true;
  view.dispatch({ effects: revealLines(d.from, d.to, 'nearest') });
  notify();
}

/** The box keeps its text, caret and focus in the draft, so a box the editor rebuilds comes back as it was.
 *  A box for a draft that has since been replaced changes nothing. */
export function editDraft(d: DeepReadonly<Draft>, text: string, caret: number): void {
  if (S.draft !== d) return;
  S.draft.text = text;
  S.draft.caret = caret;
  notify();
}

/** No notify(): nothing renders from these; the box reads them when it next mounts. */
export function draftCaret(d: DeepReadonly<Draft>, caret: number): void {
  if (S.draft === d) S.draft.caret = caret;
}

export function draftFocus(d: DeepReadonly<Draft> | null, focus: boolean): void {
  if (S.draft && (d === null || S.draft === d)) S.draft.focus = focus;
}

export function startComment(): void {
  const at = shown();
  if (!at || S.tab === 'terminals') return;
  const d = S.draft;
  if (d && here(d, at)) { focusDraft(d); return; }
  if (d && unsaved(d)) { toast(`Finish or cancel the comment on ${location(d)} first`, 'info'); return; }
  const sel = view.state.selection.main;
  const lines = lineRange(view.state.doc, sel.from, sel.to);
  const span = commentSpan(view.state, at.path, lines.from, lines.to);
  S.draft = { ...at, ...span, text: '', editing: null, focus: true, caret: null, lost: false };
  placeComments();
  view.dispatch({ effects: revealLines(span.from, span.to, 'nearest') });
  notify();
}

export function editComment(id: number): void {
  const c = S.comments.find((x) => x.id === id);
  if (!c) return;
  const d = S.draft;
  if (d?.editing === id) { focusDraft(d); return; }
  if (d && unsaved(d)) { toast(`Finish or cancel the comment on ${location(d)} first`, 'info'); return; }
  S.draft = {
    path: c.path, side: c.side, from: c.from, to: c.to, anchor: c.anchor, quote: c.quote, text: c.text,
    editing: id, focus: true, caret: null, lost: false,
  };
  placeComments();
  if (here(c, shown())) view.dispatch({ effects: revealLines(c.from, c.to, 'nearest') });
  notify();
}

/** A blank draft is left open. */
export function saveDraft(): void {
  const d = S.draft;
  const text = d?.text.trim();
  if (!d || !text) return;
  const at = shown();
  const c = d.editing === null ? null : S.comments.find((x) => x.id === d.editing);
  if (c) {
    c.text = text;
    if (d.lost) c.moved = true;
    else Object.assign(c, { from: d.from, to: d.to, anchor: d.anchor, moved: false });
  } else {
    // re-read when the file is on screen: its lines may have changed since the box opened
    const span = here(d, at) && !d.lost ? commentSpan(view.state, d.path, d.from, d.to) : d;
    S.comments.push({
      id: nextComment++, path: d.path, side: d.side, from: span.from, to: span.to, anchor: span.anchor,
      quote: span.quote, text, moved: d.lost,
    });
  }
  S.draft = null;
  placeComments();
  notify();
  if (d.lost) toast('Saved. Its lines are no longer in the file, so it waits in the pending list as moved.', 'info');
  if (here(d, at)) view.focus();
}

export async function cancelDraft(): Promise<void> {
  const d = S.draft;
  if (!d) return;
  const ask = d.editing === null ? 'Discard this comment?' : 'Discard the changes to this comment?';
  if (unsaved(d) && !(await confirmDialog(ask))) return;
  if (S.draft !== d) return;
  S.draft = null;
  placeComments();
  notify();
  if (here(d, shown())) view.focus();
}

export function deleteComment(id: number): void {
  S.comments = S.comments.filter((c) => c.id !== id);
  if (S.draft?.editing === id) S.draft = null;
  placeComments();
  notify();
}

export async function discardComments(): Promise<void> {
  const n = S.comments.length;
  if (!n || !(await confirmDialog(`Discard ${plural(n, 'pending comment')}?`))) return;
  S.comments = [];
  if (S.draft && S.draft.editing !== null) S.draft = null;
  placeComments();
  notify();
}

/** A comment that lost its place is put back at its old lines, where it can be edited or deleted. */
export async function jumpToComment(id: number): Promise<void> {
  const c = S.comments.find((x) => x.id === id);
  if (!c || !S.status) return;
  let side = c.side;
  if (!here(c, shown())) {
    const q = buildQueue(S.status);
    const row = (c.side === 'index' ? q.staged : q.unstaged).find((r) => r.path === c.path);
    if (row) await openRow(row);
    else { await openPlain(c.path); side = 'work'; }
  }
  // anything else on screen now was opened by the user while this one loaded, and wins
  const at = shown();
  if (!at || at.path !== c.path || at.side !== side || !S.comments.includes(c)) return;
  const doc = view.state.doc;
  if (c.side !== side) { c.side = side; c.moved = true; }
  if (c.moved) {
    c.from = Math.min(c.from, doc.lines);
    c.to = Math.max(c.from, Math.min(c.to, doc.lines));
    c.anchor = doc.sliceString(doc.line(c.from).from, doc.line(c.to).to);
    c.moved = false;
    placeComments();
  }
  view.dispatch({ effects: revealLines(c.from, c.to, 'center') });
  notify();
}

export async function sendComments(): Promise<void> {
  const d = S.draft;
  if (d && d.editing !== null && !d.text.trim()) {
    toast(`Finish or cancel the comment on ${location(d)} first`, 'info');
    return;
  }
  if (d && unsaved(d)) saveDraft();
  else if (d) { S.draft = null; placeComments(); notify(); }
  const sent = [...S.comments];
  if (!sent.length) return;
  // the agent reads the file from disk, which has to hold what the comments were written against
  if (!(await flush())) {
    toast(S.open?.badge
      ? 'This file changed on disk. Reload or Keep mine first.'
      : 'not saved, see the error above', 'warn');
    return;
  }
  const labels = termLabels(terminalsOf(S.terminals));
  const targets = eligible(terminalsOf(S.terminals), S.root)
    .sort((a, b) => Number(b.id === S.lastTarget) - Number(a.id === S.lastTarget));
  if (!targets.length) { toast('No claude or codex session is open in this repo.', 'warn'); return; }
  const id = await pick(targets.map((s) => ({
    label: labels.get(s.id) ?? s.title,
    detail: statusLabel(s, Date.now(), homeFrom(s.cwd)),
    note: s.id === S.lastTarget ? 'last used' : undefined,
    value: s.id,
  })), `Send ${plural(sent.length, 'comment')} to…`);
  if (id === null) return;
  const label = labels.get(id) ?? `#${id}`;
  if (!eligible(terminalsOf(S.terminals), S.root).some((s) => s.id === id)) {
    toast(`${label} is no longer open`, 'err');
    return;
  }
  try {
    await input(id, pastePayload(format(sent)));
  } catch (e) {
    toast(errText(e), 'err');
    return;
  }
  let pressed = true;
  await sleep(SUBMIT_DELAY_MS);
  // an agent that quit in the meantime leaves its shell to read the Enter
  const still = S.terminals.find((s) => s.id === id);
  if (still && takesComments(still)) {
    try { await input(id, '\r'); } catch { pressed = false; }
  } else pressed = false;
  const done = new Set(sent.map((c) => c.id));
  S.comments = S.comments.filter((c) => !done.has(c.id));
  S.lastTarget = id;
  placeComments();
  selectTerminal(id);
  if (pressed) toast(`Sent ${plural(sent.length, 'comment')} to ${label}`, 'ok');
  else toast(`Pasted into ${label} but could not press Enter`, 'warn');
}

export async function confirmRepoChange(): Promise<boolean> {
  const pending = S.comments.length + (S.draft?.editing === null && S.draft.text.trim() ? 1 : 0);
  return !pending || confirmDialog(`Discard ${plural(pending, 'pending comment')}?`);
}
