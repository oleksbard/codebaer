import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { EditorView } from '@codemirror/view';
import { EditorState, type Text } from '@codemirror/state';
import { getChunks } from '@codemirror/merge';
import { unfoldAll } from '@codemirror/language';
import { errKind, errText, git, staleText, type Branch, type Eol } from '../git';
import {
  acceptText, blameText, buildQueue, decideRefresh, FLUSH_SET, pinDefaultBranches, rejectSpecialCase, rowKey,
  unstageText, visibleFiles, type Row,
} from '../model';
import {
  acceptChunk, buildState, chunkCount, chunkIndexAtCursor, getOriginalDoc, goToNextChunk,
  goToPreviousChunk, onCursor, rejectChunk, replaceDoc, replaceOriginal, type ViewKind,
} from '../editor';
import { foldToChanges } from '../context-view';
import { pick } from '../palette';
import { logError } from '../log';
import { confirmDialog, errorDialog, promptDialog, toast } from '../toast';
import { installKeys, type Action } from '../keys';
import { orphanRows, type OrphanAction, type OrphanScan } from '../orphans';
import { DEFAULTS, type SettingKey, type Settings } from '../settings';
import * as term from '../terminal';
import { notify, refs, S, type Open, type Tab } from './store';

const PANEL_KINDS = new Set(['Binary', 'NotUtf8', 'TooLarge', 'Special']);

export const view = new EditorView({ state: EditorState.create({ doc: '' }) });

// ---------- refresh ----------
export async function refresh(): Promise<void> {
  if (S.refreshing) { S.refreshAgain = true; return; }
  S.refreshing = true;
  try {
    S.status = await git.status();
    if (S.tab === 'files') await loadFiles();
    await refreshOpen();
    // refreshOpen's replaceDoc/replaceOriginal map every fold away, and this is the path an agent
    // editing the open file takes
    refold();
    // a commit or a pull re-attributes the line under the cursor without the document changing
    cursorMoved();
    notify();
  } catch (e) {
    if (errKind(e) === 'NotARepo') { toast('That folder is not a git repository', 'err'); await pickRepo(); }
    else toast(errText(e), 'err');
  } finally {
    S.refreshing = false;
    if (S.refreshAgain) { S.refreshAgain = false; void refresh(); }
  }
}

async function refreshOpen(): Promise<void> {
  const o = S.open;
  if (!o || !S.status) return;
  const epoch = S.openEpoch;
  const stale = () => S.openEpoch !== epoch || S.open !== o;
  const entry = S.status.files.find((f) => f.path === o.path);
  if (o.panel) {
    // a paneled record's editor holds a bare state with no extensions and no merge
    // field, so it cannot be patched back to life: reopen it instead. A reopen that
    // fails again leaves the panel set for the next refresh to retry.
    // an unmerged path fails read_blob for either rev, so a paneled record on one
    // has to reopen as a conflict even when the record itself predates the merge
    if (o.conflicted || entry?.conflicted) await openConflict(o.path);
    else if (o.view === 'plain') await openPlain(o.path);
    else await openRow({
      section: o.view,
      path: o.path,
      letter: (o.view === 'staged' ? entry?.indexStatus : entry?.worktreeStatus) ?? 'M',
      untracked: entry?.untracked ?? false,
      conflicted: false,
    });
    return;
  }
  if (entry?.conflicted && !o.conflicted) {
    if (o.dirty) {
      try {
        const disk = await git.readFile(o.path);
        if (stale()) return;
        o.badge = disk;
      } catch (e) {
        if (stale()) return;
        toast(errText(e), 'err');
      }
      return;
    }
    await openConflict(o.path);
    return;
  }
  if (o.conflicted && !entry?.conflicted) {
    // the single refresh path that flushes: dirty conflict-resolution edits would otherwise be dropped on reopen
    await openRow({ section: 'unstaged', path: o.path, letter: 'M', untracked: false, conflicted: false });
    return;
  }
  try {
    if (o.view !== 'plain' && !o.conflicted) {
      const orig = await git.readBlob(o.view === 'unstaged' ? 'index' : 'head', o.path);
      if (stale()) return;
      if (orig.oid !== o.originalOid) {
        replaceOriginal(view, orig.text); o.originalOid = orig.oid; o.originalExists = orig.exists;
      }
    }
    if (o.view === 'staged') {
      const idx = await git.readBlob('index', o.path);
      if (stale()) return;
      if (idx.oid !== o.docOid) { replaceDoc(view, idx.text); o.docOid = idx.oid; o.eol = idx.eol; }
    } else {
      const disk = await git.readFile(o.path);
      if (stale()) return;
      const d = decideRefresh(disk, o.baseline, o.dirty);
      if (d === 'replace') {
        replaceDoc(view, disk.text);
        o.baseline = disk.exists ? disk.text : null; o.eol = disk.eol; o.badge = null;
      }
      else if (d === 'badge') o.badge = disk;
    }
    o.panel = null;
  } catch (e) {
    if (stale()) return;
    // a panel hides the editor and blocks flush, so a dirty buffer would be both
    // invisible and unwritten; the text stays on screen and the Stale protocol
    // decides the next write instead (spec 6.1)
    if (PANEL_KINDS.has(errKind(e)) && !o.dirty) o.panel = errKind(e);
    else toast(errText(e), 'err');
  }
}

// ---------- autosave ----------
function markDirty(): void {
  const o = S.open;
  if (!o || o.view === 'staged') return;
  o.dirty = true;
  notify();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => void flush(), 300);
}

export async function flush(): Promise<boolean> {
  const inFlight = S.flushing;
  if (inFlight) return inFlight;
  const o = S.open;
  if (!o || !o.dirty || o.view === 'staged' || o.panel) return true;
  clearTimeout(S.saveTimer);
  const p = (async (): Promise<boolean> => {
    try {
      // callers read `true` as "this record is settled and may be abandoned", so keystrokes
      // typed during a write have to be written here, not handed to a timer that would fire
      // after S.open moved on. Terminates once a write completes with no new keystroke.
      for (;;) {
        const text = view.state.doc.toString();
        await git.writeFile(o.path, text, o.eol, o.baseline);
        o.baseline = text;
        if (S.open !== o || view.state.doc.toString() === text) break;
      }
      clearTimeout(S.saveTimer);
      o.dirty = false;
      o.badge = null;
      notify();
      return true;
    } catch (e) {
      const stale = staleText(e);
      if (stale) { o.badge = stale; notify(); return false; }
      toast(`not saved: ${errText(e)}`, 'err');
      return false;
    } finally {
      S.flushing = null;
    }
  })();
  S.flushing = p;
  return p;
}

let busyDepth = 0;
let busyTimer: ReturnType<typeof setTimeout> = 0;

/** Staging a file finishes in milliseconds; the delay keeps those off the spinner entirely. */
export async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  if (++busyDepth === 1) busyTimer = setTimeout(() => { S.busy = true; notify(); }, 150);
  try {
    return await fn();
  } finally {
    if (--busyDepth === 0) {
      clearTimeout(busyTimer);
      busyTimer = 0;
      if (S.busy) { S.busy = false; notify(); }
    }
  }
}

export async function guarded<T>(name: keyof typeof git, fn: () => Promise<T>): Promise<T | undefined> {
  if (FLUSH_SET.has(name) && !(await flush())) {
    toast(S.open?.badge
      ? 'This file changed on disk. Reload or Keep mine first.'
      : 'not saved, see the error above', 'warn');
    return undefined;
  }
  try {
    return await withBusy(fn);
  } catch (e) {
    toast(errText(e), 'err');
    return undefined;
  } finally {
    void refresh();
  }
}

// ---------- blame ----------
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

// wired on import, not in start(): every consumer of the controller drives the same editor
onCursor.run = cursorMoved;

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

// ---------- open ----------
/** Expands every directory above `path` so the Files tree shows the file that just opened. */
function reveal(path: string): void {
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) S.filesOpen.add(path.slice(0, i));
}

export function toggleDir(path: string, open: boolean, unlisted = false): void {
  if (open) S.filesOpen.add(path);
  else S.filesOpen.delete(path);
  notify();
  if (open && unlisted) void expandIgnored(path);
}

/** A directory read off disk knows nothing of git, so a path git has since started tracking
 *  (`git add -f` inside an ignored directory) would otherwise be both a file and an ignored row. */
const rebuildIgnored = (): void => {
  const tracked = new Set(S.files);
  S.ignored = [S.ignoredBase, ...S.ignoredKids.values()].flat().filter((p) => !tracked.has(p));
};

/** git collapses a wholly ignored directory to one entry, so opening one reads it off disk.
 *  The key is claimed before the await, so a reopen during the read does not read it twice. */
async function expandIgnored(path: string): Promise<void> {
  if (S.ignoredKids.has(path)) return;
  S.ignoredKids.set(path, []);
  try {
    S.ignoredKids.set(path, await git.listDir(path));
  } catch (e) {
    S.ignoredKids.delete(path);
    toast(errText(e), 'err');
  }
  rebuildIgnored();
  notify();
}

export async function openRow(row: Row): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  const epoch = ++S.openEpoch;
  S.selected = rowKey(row);
  reveal(row.path);
  if (row.conflicted) { await openConflict(row.path); cursorMoved(); notify(); return; }
  const kind: ViewKind = row.section;
  try {
    const orig = await git.readBlob(kind === 'unstaged' ? 'index' : 'head', row.path);
    let doc = '';
    let baseline: string | null = null;
    let docOid: string | null = null;
    let eol: Eol = 'lf';
    if (kind === 'unstaged') {
      const f = await git.readFile(row.path);
      doc = f.text; baseline = f.exists ? f.text : null; eol = f.eol;
    } else {
      const idx = await git.readBlob('index', row.path);
      doc = idx.text; docOid = idx.oid; eol = idx.eol;
    }
    const opened: Open = {
      path: row.path, view: kind, eol, baseline, originalOid: orig.oid, originalExists: orig.exists,
      docOid, dirty: false, badge: null, panel: null, conflicted: false,
    };
    const state = await buildState(kind, row.path, doc, orig.text, markDirty,
      kind === 'unstaged' ? { accept: () => void accept(), reject: () => void reject() } : undefined);
    if (epoch !== S.openEpoch) return;
    S.open = opened;
    view.setState(state);
    selectChunk(0);
  } catch (e) {
    if (epoch !== S.openEpoch) return;
    // the panel is set for every error kind, not only the four with panel copy: it is what
    // disables accept, reject and flush. Without it the failed open leaves the previous file's
    // document mounted under this path, and one file's text reaches another file's index or disk
    S.open = {
      path: row.path, view: kind, eol: 'lf', baseline: null, originalOid: null, originalExists: false,
      docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: false,
    };
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
  // outside the try: openRow's catch maps anything thrown to a failed-open panel and blanks the
  // document, so a fold bug in here would read as an unopenable file
  refold();
  // setState alone fires no update, so a file whose cursor lands on line 1 needs the nudge
  cursorMoved();
  notify();
}

export async function openPlain(path: string): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  const epoch = ++S.openEpoch;
  S.selected = `plain:${path}`;
  reveal(path);
  try {
    const f = await git.readFile(path);
    const opened: Open = {
      path, view: 'plain', eol: f.eol, baseline: f.exists ? f.text : null, originalOid: null,
      originalExists: false, docOid: null, dirty: false, badge: null, panel: null, conflicted: false,
    };
    const state = await buildState('plain', path, f.text, null, markDirty);
    if (epoch !== S.openEpoch) return;
    S.open = opened;
    view.setState(state);
  } catch (e) {
    if (epoch !== S.openEpoch) return;
    S.open = {
      path, view: 'plain', eol: 'lf', baseline: null, originalOid: null, originalExists: false,
      docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: false,
    };
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
  cursorMoved();
  notify();
}

export async function closeFile(): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  // bumping the epoch drops an open still in flight, which would otherwise land on the blank state
  S.openEpoch++;
  S.open = null;
  S.selected = null;
  view.setState(EditorState.create({ doc: '' }));
  cursorMoved();
  notify();
}

async function openConflict(path: string): Promise<void> {
  const epoch = ++S.openEpoch;
  try {
    const f = await git.readFile(path);
    const opened: Open = {
      path, view: 'unstaged', eol: f.eol, baseline: f.exists ? f.text : null, originalOid: null,
      originalExists: false, docOid: null, dirty: false, badge: null, panel: null, conflicted: true,
    };
    const state = await buildState('plain', path, f.text, null, markDirty);
    if (epoch !== S.openEpoch) return;
    S.open = opened;
    view.setState(state);
  } catch (e) {
    if (epoch !== S.openEpoch) return;
    const opened: Open = {
      path, view: 'unstaged', eol: 'lf', baseline: null, originalOid: null, originalExists: false,
      docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: true,
    };
    S.open = opened;
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
}

function selectChunk(i: number): void {
  const chunks = getChunks(view.state)?.chunks ?? [];
  const c = chunks[Math.max(0, Math.min(i, chunks.length - 1))];
  if (c) view.dispatch({ selection: { anchor: c.fromB }, scrollIntoView: true });
}

function refold(): void {
  if (!S.changesOnly) return;
  // every caller treats a throw as a failed read of the file, so a fold bug would surface as an
  // unopenable file or a dead refresh rather than as itself
  try { foldToChanges(view); } catch (e) { toast(`could not collapse unchanged lines: ${String(e)}`, 'err'); }
}

export function toggleChangesOnly(): void {
  S.changesOnly = !S.changesOnly;
  localStorage.setItem('codebaer.changesOnly', String(S.changesOnly));
  if (S.changesOnly) foldToChanges(view);
  else unfoldAll(view);
  notify();
}

export function hasUnstaged(path: string): boolean {
  return !!S.status?.files.some((f) => f.path === path && (f.worktreeStatus !== '.' || f.untracked));
}

export const viewChanges = (path: string): Promise<void> =>
  openRow({ section: 'unstaged', path, letter: 'M', untracked: false, conflicted: false });

export async function reload(): Promise<void> {
  await S.flushing; // an in-flight write would otherwise land its own text in the baseline set below
  const o = S.open;
  if (!o) return;
  // read first, mutate only on success: a failed read must not leave the record
  // clean with a null baseline, which would make the next reject discard the file
  try {
    const disk = await git.readFile(o.path);
    if (S.open !== o) return;
    clearTimeout(S.saveTimer);
    replaceDoc(view, disk.text);
    o.baseline = disk.exists ? disk.text : null;
    o.eol = disk.eol;
    o.dirty = false;
    o.badge = null;
    refold();
  } catch (e) {
    toast(errText(e), 'err');
  }
  notify();
}

export function keepMine(): void {
  const o = S.open;
  if (!o?.badge) return;
  o.baseline = o.badge.exists ? o.badge.text : null;
  o.badge = null;
  notify();
  void flush();
}

// ---------- hunk actions ----------
export async function accept(): Promise<void> {
  const o = S.open;
  if (!o || o.view !== 'unstaged' || o.panel || o.conflicted) return;
  if (chunkIndexAtCursor(view.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  if (!(await flush())) return;
  acceptChunk(view);
  const text = acceptText(getOriginalDoc(view.state).toString(), o.baseline);
  let ok = true;
  try {
    const r = await git.stageContent(o.path, text, o.eol, o.originalOid);
    o.originalOid = r.oid;
    o.originalExists = r.oid !== null;
  } catch (e) {
    ok = false;
    const idx = await git.readBlob('index', o.path).catch(() => null);
    if (idx) { replaceOriginal(view, idx.text); o.originalOid = idx.oid; o.originalExists = idx.exists; }
    if (errKind(e) === 'StaleIndex') toast('index changed under you, your accept was dropped, re-diffed', 'warn');
    else toast(errText(e), 'err');
  }
  await refresh();
  // a dropped accept leaves its hunk on screen, and a file opened while this was in flight owns
  // the view now, so neither one may move the cursor
  if (!ok || S.open !== o) return;
  // goToNextChunk wraps, so any hunk still in this file wins over moving to the next one
  if (chunkCount(view.state)) { if (!goToNextChunk(view)) selectChunk(0); notify(); }
  else nextHunk(1);
}

export async function reject(): Promise<void> {
  const o = S.open;
  if (!o || o.view !== 'unstaged' || o.panel || o.conflicted) return;
  const special = rejectSpecialCase(o.baseline, o.originalExists);
  if (special === 'restore') {
    try { await git.revertPath(o.path); } catch (e) { toast(errText(e), 'err'); }
    await refresh();
    return;
  }
  if (special === 'removeConfirm') {
    if (!(await confirmDialog(`Delete ${o.path}?\nIts content is not in git and cannot be recovered.`))) return;
    // a refresh can replace the record while the dialog is open; the blocking confirm() never let that happen
    if (S.open !== o) return;
    try { await git.revertPath(o.path); o.baseline = null; o.dirty = false; } catch (e) { toast(errText(e), 'err'); }
    await refresh();
    return;
  }
  if (chunkIndexAtCursor(view.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  rejectChunk(view);
  await flush();
  await refresh();
}

export async function unstageHunk(): Promise<void> {
  const o = S.open;
  if (!o || o.view !== 'staged' || o.panel) return;
  if (chunkIndexAtCursor(view.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  rejectChunk(view);
  const text = unstageText(view.state.doc.toString(), o.originalExists);
  try {
    const r = await git.stageContent(o.path, text, o.eol, o.docOid);
    o.docOid = r.oid;
  } catch (e) {
    const idx = await git.readBlob('index', o.path).catch(() => null);
    if (idx) { replaceDoc(view, idx.text); o.docOid = idx.oid; }
    if (errKind(e) === 'StaleIndex') toast('index changed under you, your unstage was dropped, re-diffed', 'warn');
    else toast(errText(e), 'err');
  }
  await refresh();
}

export const acceptFile = (path: string): Promise<void | undefined> => guarded('stagePath', () => git.stagePath(path));
export const unstageFile = (path: string): Promise<void | undefined> =>
  guarded('unstagePath', () => git.unstagePath(path));
export const stageAll = (): Promise<void | undefined> => guarded('stageAll', () => git.stageAll());
export const unstageAll = (): Promise<void | undefined> => guarded('unstageAll', () => git.unstageAll());

export async function rejectFile(path: string): Promise<void> {
  if (!(await confirmDialog(`Discard unstaged changes in ${path}?\nAccepted hunks stay staged.`))) return;
  await guarded('revertPath', () => git.revertPath(path));
}

export function nextHunk(dir: 1 | -1): void {
  const o = S.open;
  const moved = o && o.view !== 'plain' && !o.panel && !o.conflicted
    && (dir > 0 ? goToNextChunk(view) : goToPreviousChunk(view));
  if (moved) { notify(); return; }
  const rows = S.status ? buildQueue(S.status).unstaged : [];
  if (!rows.length) { toast('Nothing left to review', 'info'); return; }
  const i = rows.findIndex((r) => rowKey(r) === S.selected);
  const idx = i === -1 ? (dir > 0 ? 0 : rows.length - 1) : (i + dir + rows.length) % rows.length;
  const next = rows[idx]!;
  void openRow(next).then(() => { if (dir < 0) selectChunk(chunkCount(view.state) - 1); notify(); });
}

function nextFile(dir: 1 | -1): void {
  if (!S.status) return;
  const q = buildQueue(S.status);
  const rows = [...q.unstaged, ...q.staged];
  if (!rows.length) return;
  const i = rows.findIndex((r) => rowKey(r) === S.selected);
  const idx = i === -1 ? (dir > 0 ? 0 : rows.length - 1) : (i + dir + rows.length) % rows.length;
  void openRow(rows[idx]!);
}

// ---------- git operations ----------
export async function commit(): Promise<void> {
  if (S.committing) return;
  const msg = S.commitMessage.trim();
  if (!msg) { toast('Type a commit message first', 'err'); refs.commit?.focus(); return; }
  S.committing = true;
  notify();
  try {
    await git.commit(msg);
    S.commitMessage = '';
    toast('Committed', 'ok');
  } catch (e) {
    void errorDialog(`Commit failed\n${errText(e)}`);
  } finally {
    S.committing = false;
    notify();
  }
  void refresh();
}

export async function aiMessage(): Promise<void> {
  S.aiBusy = true;
  notify();
  try {
    S.commitMessage = await git.aiCommitMessage();
    notify();
    refs.commit?.focus();
  } catch (e) {
    toast(errText(e), 'err');
  } finally {
    S.aiBusy = false;
    notify();
  }
}

const NET: Record<Net, { verb: string; done: string; run: () => Promise<void> }> = {
  push: { verb: 'Push', done: 'Pushed', run: () => git.push() },
  pull: { verb: 'Pull', done: 'Pulled', run: () => git.pull() },
  fetch: { verb: 'Fetch', done: 'Fetched', run: () => git.fetch() },
};

export type Net = 'push' | 'pull' | 'fetch';

export async function network(name: Net): Promise<void> {
  if (name === 'pull' && !(await flush())) return;
  S.cancellable = true;
  try {
    await withBusy(NET[name].run);
    toast(NET[name].done, 'ok');
  } catch (e) {
    if (errKind(e) === 'Cancelled') toast('Cancelled', 'info');
    else void errorDialog(`${NET[name].verb} failed\n${errText(e)}`);
  } finally {
    S.cancellable = false;
    notify();
    await refresh();
    const st = await git.status().catch(() => null);
    const conflicts = st?.files.filter((f) => f.conflicted).map((f) => f.path) ?? [];
    if (conflicts.length) {
      const n = conflicts.length;
      const lead = `${name} left ${n} conflict${n > 1 ? 's' : ''}:`;
      toast(`${lead}\n  ${conflicts.join('\n  ')}\nFix the markers, then stage the file.`, 'warn');
    }
  }
}

async function stashPop(): Promise<void> {
  await guarded('stashPop', () => git.stashPop());
  const st = await git.status().catch(() => null);
  const conflicts = st?.files.filter((f) => f.conflicted).map((f) => f.path) ?? [];
  if (conflicts.length) toast(`stash pop left conflicts:\n  ${conflicts.join('\n  ')}`, 'warn');
}

async function discardAll(): Promise<void> {
  if (S.status?.files.some((f) => f.conflicted)) { toast('Resolve conflicts first', 'warn'); return; }
  let preview: string[] = [];
  try { preview = await git.discardPreview(); } catch (e) { toast(errText(e), 'err'); return; }
  const changed = S.status ? buildQueue(S.status).unstaged.filter((r) => !r.untracked && !r.conflicted).length : 0;
  const list = preview.length ? `\nUntracked entries removed:\n  ${preview.join('\n  ')}` : '';
  if (!(await confirmDialog(`Discard unstaged changes in ${changed} file${changed === 1 ? '' : 's'}?${list}`))) return;
  await guarded('discardAll', () => git.discardAll());
}

export async function checkout(): Promise<void> {
  let bs: Branch[] = [];
  try { bs = await git.branches(); } catch (e) { toast(errText(e), 'err'); return; }
  const opts = pinDefaultBranches(bs).map((br) => ({
    label: br.kind === 'local' ? br.name : `${br.remote}/${br.branch}`, detail: br.kind, value: br,
  }));
  const b = await pick(opts, 'Select a branch to checkout');
  if (b) await guarded('switchBranch', () => git.switchBranch(b));
}

export async function createBranch(): Promise<void> {
  const name = await promptDialog('New branch name');
  if (name) await guarded('createBranch', () => git.createBranch(name));
}

export const cancel = (): Promise<void> => git.cancel();

export function focusCommit(): void {
  S.tab = 'changes';
  notify();
  // React applies the tab change in a microtask queued by notify(); the focus has to land after it
  queueMicrotask(() => refs.commit?.focus());
}

export async function palette(): Promise<void> {
  const cmds: { label: string; hint?: string; run: () => unknown }[] = [
    { label: 'Git: Commit', hint: '⌘↩', run: focusCommit },
    { label: 'Git: Push', run: () => network('push') },
    { label: 'Git: Pull', run: () => network('pull') },
    { label: 'Git: Fetch', run: () => network('fetch') },
    { label: 'Git: Checkout to…', run: checkout },
    { label: 'Git: Create Branch…', run: createBranch },
    { label: 'Git: Stash', run: () => guarded('stashPush', () => git.stashPush()) },
    { label: 'Git: Pop Stash', run: stashPop },
    { label: 'Git: Stage All Changes', hint: '⌘⌥Y', run: stageAll },
    { label: 'Git: Unstage All Changes', run: unstageAll },
    { label: 'Git: Discard All Changes', run: discardAll },
    { label: 'Git: Stage File', hint: '⌘⇧Y', run: () => S.open && acceptFile(S.open.path) },
    { label: 'Git: Discard File', hint: '⌘⇧N', run: () => S.open && rejectFile(S.open.path) },
    { label: 'Git: Unstage File', run: () => S.open && unstageFile(S.open.path) },
    { label: 'Open Repository…', run: pickRepo },
    { label: 'Terminal: New Terminal', hint: '⌘T', run: () => newTerminal() },
    ...(S.termMenu?.shells ?? []).map((sh) => ({
      label: `Terminal: New ${sh.name}`,
      run: () => newTerminal({ t: 'Shell', path: sh.path }),
    })),
    ...(S.termMenu?.commands ?? []).map((c) => ({
      label: `Terminal: Run ${c}`,
      run: () => newTerminal({ t: 'Command', argv0: c }),
    })),
    { label: 'Terminal: Find…', run: findInTerminal },
    { label: 'Terminal: Find Next', run: () => onTerminal((id) => term.find(id, S.termFind)) },
    { label: 'Terminal: Find Previous', run: () => onTerminal((id) => term.find(id, S.termFind, true)) },
    { label: 'Terminal: Clear Buffer', run: () => onTerminal(term.clear) },
    { label: 'Terminal: Larger Text', run: () => term.setFontSize(term.fontSize() + 1) },
    { label: 'Terminal: Smaller Text', run: () => term.setFontSize(term.fontSize() - 1) },
    { label: 'Terminal: Kill Session', run: () => onTerminal(killTerminal) },
    { label: 'Terminal: Close Session', run: () => onTerminal(closeTerminal) },
  ];
  const unborn = S.status?.head === null;
  const shown = unborn ? cmds.filter((c) => !c.label.includes('Stash')) : cmds;
  const c = await pick(shown.map((x) => ({ label: x.label, hint: x.hint, value: x })), 'Type a command');
  if (c) void c.run();
}

/** The Files tree; ignored entries are listed too, so the tab shows what git is hiding. */
async function loadFiles(): Promise<void> {
  const listing = await git.listFiles();
  S.files = visibleFiles(listing.files, S.status!);
  S.ignoredBase = listing.ignored;
  // these came off disk rather than out of git's listing, so a refresh has to ask again. Only
  // the ones still on screen: a collapsed or deleted directory drops out instead of being
  // re-read on every refresh for the rest of the session
  const opened = [...S.ignoredKids.keys()].filter((p) => S.filesOpen.has(p));
  const kids = await Promise.all(opened.map((p) => git.listDir(p).catch(() => null)));
  // written in place rather than as a fresh Map: a directory opened while this was in flight is
  // not in `opened`, and replacing the Map wholesale would discard the read it just started
  opened.forEach((p, i) => {
    if (kids[i]) S.ignoredKids.set(p, kids[i]);
    else S.ignoredKids.delete(p);
  });
  for (const p of S.ignoredKids.keys()) if (!S.filesOpen.has(p)) S.ignoredKids.delete(p);
  rebuildIgnored();
}

async function quickOpen(): Promise<void> {
  try {
    const files = visibleFiles((await git.listFiles()).files,
      S.status ?? { head: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] });
    const p = await pick(files.map((f) => ({ label: f, value: f })), 'Search files by name');
    if (p) await openPlain(p);
  } catch (e) {
    toast(errText(e), 'err');
  }
}

export async function setTab(tab: Tab): Promise<void> {
  S.tab = tab;
  if (tab === 'files' && S.status) {
    try { await loadFiles(); } catch (e) { toast(errText(e), 'err'); }
  }
  notify();
  if (tab === 'terminals') await connectTerminals();
}

// ---------- terminals ----------

/** Set once the spawn we are waiting for is known, so an unprompted session, one restored on
 *  reconnect say, does not steal the view. */
let awaitingSpawn = 0;
let connecting: Promise<void> | null = null;

/** Nothing in here may throw. Tauri advances a channel's message index only once onmessage
 *  returns, so one escaping error parks every later event in its pending queue for the life
 *  of the connection: the sessions go on running with no way left to hear about them. */
export function onTermEvent(m: term.ServerMsg): void {
  try {
    switch (m.t) {
      case 'Hello':
        S.terminals = m.sessions;
        if (!m.sessions.some((t) => t.id === S.activeTerm)) S.activeTerm = m.sessions.at(-1)?.id ?? null;
        break;
      case 'Spawned':
        S.terminals = [...S.terminals.filter((t) => t.id !== m.info.id), m.info];
        if (m.req === awaitingSpawn) {
          S.activeTerm = m.info.id;
          awaitingSpawn = 0;
        }
        break;
      case 'Status':
        S.terminals = S.terminals.map((t) => (t.id === m.id ? { ...t, state: m.state, tier: m.tier } : t));
        break;
      case 'Command':
        if (m.code !== null && m.code !== 0) flag(m.id);
        break;
      case 'Exit':
        S.terminals = S.terminals.map((t) => (t.id === m.id ? { ...t, state: { t: 'Exited', code: m.code } } : t));
        flag(m.id);
        break;
      case 'Bell':
        flag(m.id);
        break;
      case 'Cwd':
        S.terminals = S.terminals.map((t) => (t.id === m.id ? { ...t, cwd: m.cwd } : t));
        break;
      case 'Closed':
        S.terminals = S.terminals.filter((t) => t.id !== m.id);
        S.termAttention.delete(m.id);
        if (S.activeTerm === m.id) S.activeTerm = S.terminals.at(-1)?.id ?? null;
        // last, because it is the one step here that reaches into xterm: a teardown that
        // fails must not leave the view pointing at a session that is already gone
        term.dispose(m.id);
        break;
      case 'Error':
        S.termError = m.message;
        toast(m.message, 'err');
        break;
    }
  } catch (e) {
    logError(e, `terminal event ${m.t}`);
    toast(errText(e), 'err');
  }
  notify();
}

/** Only a session you are not looking at can want attention. */
function flag(id: number): void {
  if (id !== S.activeTerm || S.tab !== 'terminals') S.termAttention.add(id);
}

/** Kept as the in-flight attempt rather than a flag: the menu runs a login shell, and a failed
 *  connect that left the flag set would leave every ⌘T with no shell to spawn and nothing said. */
async function connectTerminals(): Promise<void> {
  connecting ??= (async () => {
    await term.subscribe(onTermEvent);
    term.watchOutput(notify);
    S.termMenu = await term.menu();
  })();
  try {
    await connecting;
    S.termError = null;
  } catch (e) {
    connecting = null;
    S.termError = errText(e);
  }
  notify();
}

/** The sidebar's list is copied before the processes are listed, never after: a terminal opened in
 *  between is then at worst a process with no entry, never an entry with no process, which is the
 *  kind that gets offered a Kill. */
async function takeScan(): Promise<OrphanScan> {
  const listed = [...S.terminals];
  return { report: await term.orphans(), listed };
}

/** Bumped per opening, so a scan started for one dialog cannot land in the next. */
let orphansEpoch = 0;

export async function findOrphans(): Promise<void> {
  const epoch = ++orphansEpoch;
  try {
    const scan = await takeScan();
    // something else took the screen meanwhile, or this was opened again
    if (epoch !== orphansEpoch || S.palette || S.confirm || S.prompt || S.settingsOpen) return;
    S.orphans = scan;
  } catch (e) {
    logError(e, 'find orphans');
    toast(errText(e), 'err');
  }
  notify();
}

export function closeOrphans(): void {
  orphansEpoch++;
  S.orphans = null;
  notify();
}

// ---------- settings ----------
/** One at a time: two saves in flight could land in either order, and a read between a save and
 *  its result would show the old value. */
let settingsQueue: Promise<unknown> = Promise.resolve();
function inOrder<T>(fn: () => Promise<T>): Promise<T> {
  const run = settingsQueue.then(fn);
  settingsQueue = run.catch(() => {});
  return run;
}

/** What the file holds, as far as this window knows. A failed save goes back to it, not to the value
 *  before its own click: an earlier click may have failed too. */
let confirmed: Settings = { ...DEFAULTS };

function loadSettings(): Promise<void> {
  return inOrder(async () => {
    S.settings = confirmed = await git.settings();
    notify();
  });
}

/** Bumped per opening, so an earlier opening still reading the file cannot reopen it after Escape. */
let settingsEpoch = 0;

/** Reads the file first, so an edit made to it by hand shows up. */
export async function openSettings(): Promise<void> {
  const epoch = ++settingsEpoch;
  try {
    await loadSettings();
  } catch (e) {
    if (epoch === settingsEpoch) toast(`Settings could not be read: ${errText(e)}`, 'err');
    return;
  }
  // something else took the screen while the file was read, or this was opened again
  if (epoch !== settingsEpoch || !overlayIdle()) return;
  S.settingsOpen = true;
  notify();
}

export function closeSettings(): void {
  settingsEpoch++;
  S.settingsOpen = false;
  notify();
}

const same = (a: Settings, b: Settings) => (Object.keys(a) as SettingKey[]).every((k) => a[k] === b[k]);

export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  S.settings = { ...S.settings, [key]: value };
  notify();
  return inOrder(async () => {
    const sent = S.settings;
    // nothing to write, e.g. a change queued behind a failed save, which undid it
    if (same(sent, confirmed)) return;
    try {
      await git.saveSettings(sent);
      confirmed = sent;
    } catch (e) {
      // a failed write leaves the file as it was
      S.settings = confirmed;
      toast(`Settings not saved: ${errText(e)}`, 'err');
    }
    notify();
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Rescans until `pid` is gone, since the host signals a closed session's group after it replies. */
async function rescanOrphans(gone: number | null = null): Promise<void> {
  const epoch = orphansEpoch;
  for (let i = 0; i < 12; i++) {
    const scan = await takeScan();
    // closed, or closed and opened again, while this was in flight
    if (!S.orphans || epoch !== orphansEpoch) return;
    S.orphans = scan;
    notify();
    const all = [...scan.report.hosts.flatMap((h) => h.sessions), ...scan.report.escaped];
    if (gone === null || !all.some((p) => p.pid === gone)) return;
    await sleep(250);
  }
}

/** For a session whose id could not be read: list again, then replay whatever the list gained. */
async function relistUnknown(): Promise<void> {
  const before = new Set(S.terminals.map((t) => t.id));
  await term.relist(null);
  // the list arrives as a Hello event, not as this call's result
  for (let i = 0; i < 20 && S.terminals.every((t) => before.has(t.id)); i++) await sleep(100);
  const gained = S.terminals.filter((t) => !before.has(t.id));
  if (!gained.length) toast('The host listed no terminal the sidebar was missing, so nothing was restored.', 'err');
  for (const t of gained) await replay(t.id);
}

/** Whatever the view already holds for the session goes first, or its history shows twice. */
async function replay(id: number): Promise<void> {
  term.reset(id);
  await term.relist(id);
  // until the list lands, a rescan's copy of it would still say the session is missing
  for (let i = 0; i < 20 && !S.terminals.some((t) => t.id === id); i++) await sleep(100);
  if (!S.terminals.some((t) => t.id === id)) toast(`The host has no terminal #${id}, so nothing was restored.`, 'err');
}

export async function rescan(): Promise<void> {
  try {
    await rescanOrphans();
  } catch (e) {
    logError(e, 'rescan orphans');
    toast(errText(e), 'err');
  }
}

export async function orphanAction(a: OrphanAction): Promise<void> {
  const epoch = orphansEpoch;
  try {
    switch (a.t) {
      case 'relist': await (a.id === null ? relistUnknown() : replay(a.id)); break;
      case 'relay': await term.restoreOrphan(a.sock, a.id, a.pid); break;
      case 'signal': await term.killOrphan(a.pid); break;
      case 'close': {
        // the only kill the backend cannot check, since only this side knows which entry is which,
        // so a fresh scan has to agree with the row first
        const fresh = await takeScan();
        const same = orphanRows(fresh.report, fresh.listed)
          .some((r) => r.kill?.t === 'close' && r.kill.id === a.id && r.pid === a.pid);
        if (!same) {
          if (S.orphans && epoch === orphansEpoch) S.orphans = fresh;
          notify();
          toast('That terminal changed since the scan. Nothing was closed; check the new one.', 'err');
          return;
        }
        await term.close(a.id);
        // a record the host no longer has gets no Closed, and only its list can drop it
        await term.relist(null);
        break;
      }
    }
    // the dialog this action came from may have been closed and another opened meanwhile
    if (epoch === orphansEpoch) await rescanOrphans(a.t === 'close' ? a.pid : null);
  } catch (e) {
    logError(e, `orphan ${a.t}`);
    toast(errText(e), 'err');
  }
}

export async function newTerminal(kind?: term.SpawnKind): Promise<void> {
  await setTab('terminals');
  const pick = kind ?? (S.termMenu ? ({ t: 'Shell', path: S.termMenu.default } as const) : null);
  if (!pick) return;
  try {
    awaitingSpawn = await term.spawn(pick, ...term.size());
  } catch (e) {
    toast(errText(e), 'err');
  }
}

export function selectTerminal(id: number): void {
  S.activeTerm = id;
  S.termAttention.delete(id);
  S.tab = 'terminals';
  notify();
}

export async function killTerminal(id: number): Promise<void> {
  try { await term.kill(id); } catch (e) { toast(errText(e), 'err'); }
}

export async function closeTerminal(id: number): Promise<void> {
  try { await term.close(id); } catch (e) { toast(errText(e), 'err'); }
}

const onTerminal = (fn: (id: number) => unknown): void => { if (S.activeTerm !== null) void fn(S.activeTerm); };

async function findInTerminal(): Promise<void> {
  const q = await promptDialog('Find in terminal');
  if (q === null) return;
  S.termFind = q;
  onTerminal((id) => term.find(id, q));
}

// ---------- startup and repo switching ----------
export async function openRepo(path: string): Promise<void> {
  if (!(await flush())) {
    toast('This file changed on disk. Reload or Keep mine before switching repos.', 'warn');
    return;
  }
  try {
    const opened = await git.openRepo(path);
    S.root = opened.root;
    S.rootLabel = opened.label;
    // the badge already compares against the new root; this only freshens folders up to a sweep old
    term.checkCwd().catch((e: unknown) => logError(e, 'terminal folders'));
    S.title = opened.title;
    localStorage.setItem('codebaer.lastRepo', path);
    clearTimeout(S.saveTimer);
    S.open = null;
    S.selected = null;
    S.filesOpen.clear();
    S.ignoredKids.clear();
    await refresh();
    const first = S.status ? buildQueue(S.status).unstaged[0] : undefined;
    if (first) await openRow(first);
    else notify();
  } catch (e) {
    toast(errText(e), 'err');
    await pickRepo();
  }
}

export async function pickRepo(): Promise<void> {
  const dir = await openDialog({ directory: true, multiple: false, title: 'Open a git repository' });
  if (typeof dir === 'string') await openRepo(dir);
}

/** An open overlay owns the keyboard; Radix handles its own Escape. */
function overlayIdle(): boolean {
  return !S.palette && !S.confirm && !S.prompt && !S.orphans && !S.settingsOpen;
}

export function dispatch(a: Action): void {
  if (!overlayIdle()) return;
  const map: Record<Action, () => unknown> = {
    nextHunk: () => nextHunk(1), prevHunk: () => nextHunk(-1),
    accept, reject, unstage: unstageHunk,
    acceptFile: () => S.open && acceptFile(S.open.path),
    rejectFile: () => S.open && rejectFile(S.open.path),
    stageAll,
    nextFile: () => nextFile(1), prevFile: () => nextFile(-1),
    quickOpen, palette,
    save: () => { if (S.open?.dirty) void flush(); },
    toggleSidebar: () => {
      S.sidebarHidden = !S.sidebarHidden;
      localStorage.setItem('codebaer.sidebarHidden', String(S.sidebarHidden));
      notify();
    },
    focusList: () => refs.list?.focus(),
    focusEditor: () => view.focus(),
    focusCommit,
    filesTab: () => { void setTab('files').then(() => refs.list?.focus()); },
    escape: () => { if (S.open?.badge) { S.open.badge = null; notify(); } },
    newTerminal: () => void newTerminal(),
    terminalsTab: () => void setTab('terminals'),
    focusTerminal: () => { if (S.activeTerm !== null) term.focus(S.activeTerm); },
  };
  void map[a]();
}

export async function start(): Promise<void> {
  try {
    await git.gitVersion();
  } catch (e) {
    S.fatal = errText(e);
    notify();
    return;
  }
  loadSettings().catch((e: unknown) => logError(e, 'load settings'));
  installKeys(dispatch, (visible) => { S.chord = visible; notify(); });
  // not deferred to the first visit any more: the activity bar lists every session on every tab
  void connectTerminals();
  globalThis.addEventListener('blur', () => void flush());
  view.dom.addEventListener('keyup', notify);
  view.dom.addEventListener('mouseup', notify);
  await listen('repo-changed', () => void refresh());
  await listen<string>('open-repo', (e) => void openRepo(e.payload));
  // a menu item reaches us even while an overlay owns the keyboard, where dispatch() would have refused
  await listen('menu-open-folder', () => { if (overlayIdle()) void pickRepo(); });
  await listen<string>('menu-open-recent', (e) => { if (overlayIdle()) void openRepo(e.payload); });
  await listen('menu-orphans', () => { if (overlayIdle()) void findOrphans(); });
  await listen('menu-settings', () => { if (overlayIdle()) void openSettings(); });
  const initial = (await git.initialRepo()) ?? localStorage.getItem('codebaer.lastRepo');
  if (initial) await openRepo(initial);
  else await pickRepo();
}
