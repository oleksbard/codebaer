import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getChunks } from '@codemirror/merge';
import { buildQueue, rejectSpecialCase, rowKey, type Row } from '#core/model';
import { closeFile, openRow, refresh, selectChunk } from '#core/session';
import { foldToChanges } from '#editor/context-view';
import {
  buildState, chunkCount, chunkIndexAtCursor, lineStat, rejectChunk, replaceDoc, replaceOriginal,
} from '#editor/editor';
import { ghostChunk } from '#editor/ghost';
import { setEditorDark } from '#editor/editor-theme';
import { closePane, detachPane, isSideBySide, originalPane, setSideBySide, sideBySide } from '#editor/side-by-side';
import { errKind, errText, git, staleText } from '#ipc/git';
import { confirmDialog, toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { notify, S } from '#kernel/store';
import { removeText, stageChunk, type HunkFile } from './hunks';
import { sideChosen } from './layout';

/** One file on the page. `panel` is why it shows no diff: an error kind from reading it, Conflicted, or Large. */
type Section = {
  path: string;
  view: EditorView | null;
  file: HunkFile | null;
  panel: string | null;
  error: string | null;
  /** Its reads and writes, one at a time: a re-read landing while a reject is being written would take the
   *  agent's text as the baseline the failed write then leaves behind. */
  work: Promise<void>;
  /** A refresh came while it was off screen; it reads again when it comes near. */
  stale: boolean;
  /** Counts the re-diffs this page's own accepts and rejects did not make. A click checks it has not moved
   *  when its turn in the queue comes, or it would act on whatever hunk a re-read moved under its cursor. */
  rev: number;
};

/** Changed lines past which a diff waits behind Show diff, so one lockfile cannot bury the page. */
export const LARGE = 500;
/** Characters, both sides together, past which a file is not even diffed until Show diff. */
export const LARGE_TEXT = 1024 * 1024;

const sections = new Map<string, Section>();
const els = new Map<string, HTMLElement>();
/** The files the page component reports near the screen; only these re-read on a refresh. */
const near = new Set<string>();
let scroller: HTMLElement | null = null;
/** The file the hunk keys act on: the last one clicked into or moved to, while it is on screen. */
let current: string | null = null;
/** A file scrolled to from the queue or the file keys; it keeps the queue's selection while it is on screen,
 *  since the page cannot scroll the last files to its top. */
let pinned: string | null = null;
/** The first file on screen, and how far the page is scrolled into it. */
let top: string | null = null;
let topBy = 0;
/** Scrolled to once the page is mounted. */
let reveal: { path: string; by: number } | null = null;
/** A key pressed again while the last one still waits for its file to load wins over it. */
const moves = epoch();

export const allChangesShown = (s: { readonly allChanges: unknown; readonly open: unknown; readonly tab: string }) =>
  !!s.allChanges && !s.open && s.tab !== 'terminals';
export const onPage = (): boolean => allChangesShown(S);

const queued = (): Map<string, Row> => new Map((S.status ? buildQueue(S.status).unstaged : []).map((r) => [r.path, r]));
const rowOf = (path: string): Row | undefined => queued().get(path);
const reading = (): string | null => current ?? pinned ?? top;

export async function showAllChanges(): Promise<void> {
  if (S.tab === 'terminals') S.tab = 'changes';
  if (S.allChanges && !S.open) { notify(); return; }
  const from = S.open?.path ?? null;
  if (!(await closeFile())) { notify(); return; }
  dropPage();
  S.allChanges = { order: [...queued().keys()], collapsed: new Set(), shown: new Set() };
  reveal = from === null ? null : { path: from, by: 0 };
  notify();
}

/** Back to the one-file view, on the file being read, or the next one still to review. */
export async function closeAllChanges(): Promise<void> {
  const order = S.allChanges?.order ?? [];
  const rows = queued();
  const row = order.slice(Math.max(0, order.indexOf(reading() ?? ''))).concat(order)
    .map((p) => rows.get(p)).find((r) => r !== undefined);
  // the open ends the page (the onCursor hook in index.ts) once the file is in the pane, so it never shows empty
  if (row) await openRow(row);
  else { dropPage(); S.selected = null; notify(); }
}

export const toggleAllChanges = (): Promise<void> => (onPage() ? closeAllChanges() : showAllChanges());

const destroy = (v: EditorView): void => { closePane(v); v.destroy(); };

export function dropPage(): void {
  for (const s of sections.values()) if (s.view) destroy(s.view);
  sections.clear();
  near.clear();
  S.allChanges = null;
  current = pinned = top = reveal = null;
  topBy = 0;
}

/** Opens the file in the one-file view, on the hunk its section had the cursor in. */
export async function openSection(path: string): Promise<void> {
  const row = rowOf(path);
  if (!row) return;
  const v = sections.get(path)?.view;
  const at = v ? Math.max(0, chunkIndexAtCursor(v.state)) : 0;
  await openRow(row);
  if (at && S.open?.path === path) { selectChunk(at); notify(); }
}

/** A queue row: on the page, scrolls to the file instead of leaving the page. */
export function pickRow(r: Row): Promise<void> {
  const page = S.allChanges;
  if (!onPage() || !page || r.section !== 'unstaged' || !page.order.includes(r.path)) return openRow(r);
  // the queue keeps the keyboard, as it does when a row opens a file in the one-file view
  return goTo(r.path, false);
}

/** Scrolls to the file and puts the cursor on its first hunk, as opening it in the one-file view does. */
async function goTo(path: string, focus: boolean): Promise<void> {
  const live = moves.next();
  const page = S.allChanges;
  page?.collapsed.delete(path);
  pinned = current = path;
  S.selected = rowKey({ section: 'unstaged', path });
  notify();
  revealSection(path, 0);
  await load(path);
  if (!live() || S.allChanges !== page) return;
  const sec = sections.get(path);
  if (sec?.view && chunkCount(sec.view.state) && readable(sec, sec.view)) select(sec, sec.view, 0, false, focus);
}

function revealSection(path: string, by: number): void {
  const el = els.get(path);
  if (!el || !scroller) return;
  scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + by;
}

// ---------- the DOM the page component hands over ----------
export function bindScroller(el: HTMLElement | null): void {
  if (!el) {
    // a tab switch unmounts the page: what it showed re-reads on the way back, which scrolls to where it was
    if (S.allChanges && top !== null) reveal = { path: top, by: topBy };
    near.clear();
    scroller = null;
    return;
  }
  scroller = el;
  if (reveal === null) return;
  const r = reveal;
  reveal = null;
  revealSection(r.path, r.by);
}

export function bindSection(path: string, el: HTMLElement | null): void {
  if (!el) { els.delete(path); return; }
  els.set(path, el);
  attach(path);
}

function attach(path: string): void {
  const v = sections.get(path)?.view;
  const body = els.get(path)?.querySelector('.fbody');
  if (!v || !body) return;
  if (v.dom.parentElement !== body) body.appendChild(v.dom);
  if (!isSideBySide(v)) { detachPane(v); return; }
  const left = originalPane(v);
  if (left.dom.nextSibling !== v.dom) body.insertBefore(left.dom, v.dom);
}

export function relayoutAllChanges(): void {
  const side = sideChosen(S);
  for (const sec of sections.values()) {
    if (!sec.view) continue;
    setSideBySide(sec.view, side);
    attach(sec.path);
  }
}

export function nearScreen(path: string, isNear: boolean): void {
  if (!isNear) { near.delete(path); return; }
  near.add(path);
  void load(path);
}

let frame = 0;
export function scrolled(): void {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; spy(); });
}

/** Follows the file at the top of the page with the queue's selection. */
export function spy(): void {
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const on = (p: string): boolean => {
    const r = els.get(p)?.getBoundingClientRect();
    return !!r && r.bottom > box.top && r.top < box.bottom;
  };
  // scrolled away from the file being read, the keys start again from what is on screen
  if (current !== null && !on(current)) current = null;
  if (pinned !== null && !on(pinned)) pinned = null;
  const at = S.allChanges?.order.find((p) => (els.get(p)?.getBoundingClientRect().bottom ?? 0) > box.top + 1) ?? null;
  topBy = at === null ? 0 : box.top - (els.get(at)?.getBoundingClientRect().top ?? box.top);
  if (at === top) return;
  top = at;
  if (pinned !== null || at === null || !rowOf(at)) return;
  S.selected = rowKey({ section: 'unstaged', path: at });
  notify();
}

export function sectionOf(path: string): Readonly<Pick<Section, 'view' | 'panel' | 'error'>> | undefined {
  return sections.get(path);
}

// ---------- loading and refreshing ----------
function queue<T>(sec: Section, fn: () => Promise<T>): Promise<T> {
  const run = sec.work.then(fn);
  sec.work = run.then(() => {}, () => {});
  return run;
}

/** Reads the file for the page, or reads it again if a refresh came while it was away. */
export function load(path: string): Promise<void> {
  if (!S.allChanges) return Promise.resolve();
  const had = sections.get(path);
  if (had) return had.stale ? resync(had) : had.work;
  const sec: Section = {
    path, view: null, file: null, panel: null, error: null, work: Promise.resolve(), stale: false, rev: 0,
  };
  sections.set(path, sec);
  return queue(sec, () => fill(sec));
}

const tracker = (sec: Section) => EditorView.updateListener.of((u) => {
  if ((u.focusChanged && u.view.hasFocus) || u.transactions.some((t) => t.isUserEvent('select'))) current = sec.path;
});

/** Builds the section's editor. Runs inside its queue. */
async function fill(sec: Section): Promise<void> {
  const live = () => sections.get(sec.path) === sec;
  if (rowOf(sec.path)?.conflicted) { sec.panel = 'Conflicted'; notify(); return; }
  try {
    const [orig, disk] = await Promise.all([git.readBlob('index', sec.path), git.readFile(sec.path)]);
    if (!live()) return;
    if (orig.text.length + disk.text.length > LARGE_TEXT && !S.allChanges?.shown.has(sec.path)) {
      sec.panel = 'Large';
      notify();
      return;
    }
    // read only: an edit here would need the one-file view's unsaved state and its Stale handling for every file
    const state = await buildState('unstaged', sec.path, disk.text, orig.text, () => {},
      [EditorState.readOnly.of(true), tracker(sec), sideBySide(sideChosen(S))],
      { accept: () => void acceptIn(sec), reject: () => void rejectIn(sec) });
    if (!live()) return;
    sec.file = {
      path: sec.path, eol: disk.eol, baseline: disk.exists ? disk.text : null, originalOid: orig.oid,
      originalExists: orig.exists,
    };
    sec.view = new EditorView({ state });
    sec.panel = null;
    sec.error = null;
    attach(sec.path);
    fold(sec.view);
  } catch (e) {
    if (!live()) return;
    sec.panel = errKind(e);
    sec.error = errText(e);
  }
  notify();
}

function fold(v: EditorView): void {
  try { foldToChanges(v); } catch (e) { toast(`could not collapse unchanged lines: ${String(e)}`, 'err'); }
}

/** The review feature's onRefresh: new files join the end of the page, and the files near the screen re-read. */
export async function syncAllChanges(): Promise<void> {
  const page = S.allChanges;
  if (!page) return;
  for (const p of queued().keys()) if (!page.order.includes(p)) page.order.push(p);
  const now: Promise<void>[] = [];
  for (const sec of sections.values()) {
    if (near.has(sec.path)) now.push(resync(sec));
    else sec.stale = true;
  }
  await Promise.all(now);
}

const resync = (sec: Section): Promise<void> => queue(sec, () => reread(sec));

async function reread(sec: Section): Promise<void> {
  sec.stale = false;
  const live = () => sections.get(sec.path) === sec;
  const row = rowOf(sec.path);
  // a file that left the queue keeps what it last showed, and the page folds it away as done
  if (!live() || !row) return;
  const v = sec.view;
  const f = sec.file;
  if (!v || !f || row.conflicted) {
    // a file too big to diff stays that way until Show diff; reading it again is up to 4 MB for nothing
    if ((row.conflicted && sec.panel === 'Conflicted') || sec.panel === 'Large') return;
    // the panel stays up while fill reads, which replaces it either way
    if (v) destroy(v);
    sec.view = null; sec.file = null;
    await fill(sec);
    return;
  }
  try {
    const [orig, disk] = await Promise.all([git.readBlob('index', sec.path), git.readFile(sec.path)]);
    if (!live() || sec.view !== v) return;
    const text = disk.exists ? disk.text : null;
    if (orig.oid === f.originalOid && text === f.baseline) return;
    sec.rev++;
    if (orig.oid !== f.originalOid) {
      replaceOriginal(v, orig.text); f.originalOid = orig.oid; f.originalExists = orig.exists;
    }
    if (text !== f.baseline) { replaceDoc(v, disk.text); f.baseline = text; f.eol = disk.eol; }
    fold(v);
  } catch (e) {
    if (!live() || sec.view !== v) return;
    destroy(v);
    sec.view = null; sec.file = null; sec.panel = errKind(e); sec.error = errText(e);
  }
}

export function rethemeAllChanges(dark: boolean): void {
  for (const s of sections.values()) if (s.view) setEditorDark(s.view, dark);
}

// ---------- folding files away ----------
export function toggleSection(path: string): void {
  const c = S.allChanges?.collapsed;
  if (!c) return;
  if (!c.delete(path)) c.add(path);
  notify();
}

export function collapseAll(fold: boolean): void {
  const page = S.allChanges;
  if (!page) return;
  page.collapsed = fold ? new Set(page.order) : new Set();
  notify();
}

export function showLarge(path: string): void {
  const page = S.allChanges;
  if (!page) return;
  page.shown.add(path);
  notify();
  const sec = sections.get(path);
  if (sec?.panel === 'Large') void queue(sec, () => { sec.panel = null; return fill(sec); });
}

const gated = (sec: Section, v: EditorView): boolean => {
  const n = lineStat(v.state);
  return n.added + n.removed > LARGE && !S.allChanges?.shown.has(sec.path);
};

/** Its diff is on the page to see: still to review, not folded away, not behind Show diff. */
const readable = (sec: Section, v: EditorView, rows = queued()): boolean =>
  rows.has(sec.path) && !S.allChanges?.collapsed.has(sec.path) && !gated(sec, v);

// ---------- hunks ----------
async function acceptIn(sec: Section): Promise<void> {
  const v = sec.view;
  const f = sec.file;
  if (!v || !f) return;
  current = sec.path;
  if (chunkIndexAtCursor(v.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  const live = () => sections.get(sec.path) === sec && sec.view === v;
  const rev = sec.rev;
  const ok = await queue(sec, async () => {
    if (!live()) return false;
    if (sec.rev !== rev) { toast(`${sec.path} changed and was re-diffed, nothing was staged`, 'warn'); return false; }
    const staged = await stageChunk(v, f, live);
    // a refused stage re-diffs against the index
    if (!staged) sec.rev++;
    return staged;
  });
  await refresh();
  if (ok && live()) await stackHunk(1);
}

async function rejectIn(sec: Section): Promise<void> {
  const v = sec.view;
  const f = sec.file;
  if (!v || !f) return;
  current = sec.path;
  const live = () => sections.get(sec.path) === sec && sec.view === v;
  const special = rejectSpecialCase(f.baseline, f.originalExists);
  if (special === 'removeConfirm' && !(await confirmDialog(removeText(f.path)))) return;
  if (special) {
    if (!live()) return;
    await queue(sec, async () => {
      try { await git.revertPath(f.path); } catch (e) { toast(errText(e), 'err'); }
    });
    await refresh();
    return;
  }
  if (chunkIndexAtCursor(v.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  const rev = sec.rev;
  await queue(sec, async () => {
    const before = f.baseline;
    if (!live() || before === null) return;
    if (sec.rev !== rev) { toast(`${f.path} changed and was re-diffed, nothing was rejected`, 'warn'); return; }
    ghostChunk(v, 'reject');
    rejectChunk(v);
    const text = v.state.doc.toString();
    try {
      await git.writeFile(f.path, text, f.eol, before);
      f.baseline = text;
    } catch (e) {
      sec.rev++;
      const disk = staleText(e);
      // the file is not what the editor showed: take what it holds, so the diff and the next write start there
      if (disk) {
        replaceDoc(v, disk.text); f.baseline = disk.exists ? disk.text : null; f.eol = disk.eol;
        toast(`${f.path} changed on disk, your reject was dropped, re-diffed`, 'warn');
      } else {
        replaceDoc(v, before);
        toast(`not saved: ${errText(e)}`, 'err');
      }
      fold(v);
    }
  });
  await refresh();
}

/** The section the hunk keys act on, when its diff is on the page to see. */
function hunkTarget(): Section | undefined {
  const sec = current === null ? undefined : sections.get(current);
  return sec?.view && readable(sec, sec.view) ? sec : undefined;
}

export async function stackAccept(): Promise<void> {
  const sec = hunkTarget();
  if (sec) await acceptIn(sec);
  else toast('Put the cursor in a hunk first', 'info');
}

export async function stackReject(): Promise<void> {
  const sec = hunkTarget();
  if (sec) await rejectIn(sec);
  else toast('Put the cursor in a hunk first', 'info');
}

/** The file the whole-file keys act on: the one being read, when it is still to review and not a conflict,
 *  which only the one-file view can resolve. */
export function stackPath(): string | null {
  const p = reading();
  const row = p === null ? undefined : rowOf(p);
  return row && !row.conflicted ? row.path : null;
}

function select(sec: Section, v: EditorView, i: number, scroll: boolean, focus = true): void {
  const c = getChunks(v.state)?.chunks[i];
  if (!c) return;
  const effects = scroll ? EditorView.scrollIntoView(c.fromB, { y: 'center' }) : [];
  v.dispatch({ selection: { anchor: c.fromB }, effects });
  if (focus) v.focus();
  current = sec.path;
}

/** The next hunk from the cursor in the same file, without wrapping. */
function step(sec: Section, v: EditorView, dir: 1 | -1): boolean {
  const chunks = getChunks(v.state)?.chunks ?? [];
  const head = v.state.selection.main.head;
  const at = chunks.findIndex((c) => c.fromB <= head && head <= c.endB);
  const i = at >= 0 ? at + dir
    : dir > 0 ? chunks.findIndex((c) => c.fromB > head) : chunks.filter((c) => c.endB < head).length - 1;
  if (i < 0 || i >= chunks.length) return false;
  select(sec, v, i, true);
  return true;
}

/** Files in page order from the current one, wrapping, with the current one last; with no current file the
 *  one being read comes first. */
function around(dir: 1 | -1): string[] {
  const order = S.allChanges?.order ?? [];
  const n = order.length;
  const at = reading();
  const i = at === null ? -1 : order.indexOf(at);
  const start = i < 0 ? (dir > 0 ? -1 : n) : current === null ? i - dir : i;
  return Array.from({ length: n }, (_, k) => order[(((start + dir * (k + 1)) % n) + n) % n]!);
}

export async function stackHunk(dir: 1 | -1): Promise<void> {
  const live = moves.next();
  const page = S.allChanges;
  if (!page) return;
  const here = hunkTarget();
  if (here?.view && step(here, here.view, dir)) return;
  for (const p of around(dir)) {
    const rows = queued();
    if (!rows.has(p) || page.collapsed.has(p)) continue;
    await load(p);
    if (!live() || S.allChanges !== page) return;
    const sec = sections.get(p);
    const v = sec?.view;
    const n = v ? chunkCount(v.state) : 0;
    if (!sec || !v || !n || !readable(sec, v, rows)) continue;
    select(sec, v, dir > 0 ? 0 : n - 1, true);
    return;
  }
  toast('Nothing left to review', 'info');
}

export async function stackFile(dir: 1 | -1): Promise<void> {
  const rows = queued();
  const p = around(dir).find((x) => rows.has(x));
  if (p !== undefined) await goTo(p, true);
}
