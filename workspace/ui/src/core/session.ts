import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { getChunks } from '@codemirror/merge';
import { unfoldAll } from '@codemirror/language';
import { foldToChanges } from '#editor/context-view';
import { buildState, onCursor, replaceDoc, replaceOriginal, type ViewKind } from '#editor/editor';
import { pickFolder } from '#ipc/dialog';
import { errKind, errText, git, staleText, type Eol } from '#ipc/git';
import { logInfo } from '#ipc/log';
import { toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { editorExtensions, features, run } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { buildQueue, decideRefresh, FLUSH_SET, plural, rowKey, type Row } from './model';
import type { Open } from './state';

const PANEL_KINDS = new Set(['Binary', 'NotUtf8', 'TooLarge', 'Special']);

export const view = new EditorView({ state: EditorState.create({ doc: '' }) });
const openEpoch = epoch();

// ---------- refresh ----------
export async function refresh(): Promise<void> {
  if (S.refreshing) { S.refreshAgain = true; return; }
  S.refreshing = true;
  try {
    S.status = await git.status();
    for (const f of features()) await f.onRefresh?.();
    await refreshOpen();
    // refreshOpen's replaceDoc/replaceOriginal map every fold away, and this is the path an agent
    // editing the open file takes
    refold();
    // a commit or a pull re-attributes the line under the cursor without the document changing
    onCursor.run();
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
  const live = openEpoch.current();
  const stale = () => !live() || S.open !== o;
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

// ---------- open ----------
/** Expands every directory above `path` so the Files tree shows the file that just opened. */
function reveal(path: string): void {
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) S.filesOpen.add(path.slice(0, i));
}

function afterOpen(): void {
  for (const f of features()) f.onOpen?.();
}

export async function openRow(row: Row): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  const live = openEpoch.next();
  S.selected = rowKey(row);
  reveal(row.path);
  if (row.conflicted) { await openConflict(row.path); onCursor.run(); notify(); return; }
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
    const state = await buildState(kind, row.path, doc, orig.text, markDirty, editorExtensions(),
      kind === 'unstaged' ? { accept: () => run('review.accept'), reject: () => run('review.reject') } : undefined);
    if (!live()) return;
    S.open = opened;
    view.setState(state);
    afterOpen();
    selectChunk(0);
  } catch (e) {
    if (!live()) return;
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
  onCursor.run();
  notify();
}

export async function openPlain(path: string): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  const live = openEpoch.next();
  S.selected = `plain:${path}`;
  reveal(path);
  try {
    const f = await git.readFile(path);
    const opened: Open = {
      path, view: 'plain', eol: f.eol, baseline: f.exists ? f.text : null, originalOid: null,
      originalExists: false, docOid: null, dirty: false, badge: null, panel: null, conflicted: false,
    };
    const state = await buildState('plain', path, f.text, null, markDirty, editorExtensions());
    if (!live()) return;
    S.open = opened;
    view.setState(state);
    afterOpen();
  } catch (e) {
    if (!live()) return;
    S.open = {
      path, view: 'plain', eol: 'lf', baseline: null, originalOid: null, originalExists: false,
      docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: false,
    };
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
  onCursor.run();
  notify();
}

export async function closeFile(): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  // bumping the epoch drops an open still in flight, which would otherwise land on the blank state
  openEpoch.bump();
  S.open = null;
  S.selected = null;
  view.setState(EditorState.create({ doc: '' }));
  onCursor.run();
  notify();
}

async function openConflict(path: string): Promise<void> {
  const live = openEpoch.next();
  try {
    const f = await git.readFile(path);
    const opened: Open = {
      path, view: 'unstaged', eol: f.eol, baseline: f.exists ? f.text : null, originalOid: null,
      originalExists: false, docOid: null, dirty: false, badge: null, panel: null, conflicted: true,
    };
    const state = await buildState('plain', path, f.text, null, markDirty, editorExtensions());
    if (!live()) return;
    S.open = opened;
    view.setState(state);
    afterOpen();
  } catch (e) {
    if (!live()) return;
    const opened: Open = {
      path, view: 'unstaged', eol: 'lf', baseline: null, originalOid: null, originalExists: false,
      docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: true,
    };
    S.open = opened;
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
}

export function selectChunk(i: number): void {
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

// ---------- startup and repo switching ----------
export async function openRepo(path: string): Promise<void> {
  for (const f of features()) if (f.onRepoChange?.confirm && !(await f.onRepoChange.confirm())) return;
  if (!(await flush())) {
    toast('This file changed on disk. Reload or Keep mine before switching repos.', 'warn');
    return;
  }
  try {
    const opened = await git.openRepo(path);
    S.root = opened.root;
    S.rootLabel = opened.label;
    S.title = opened.title;
    localStorage.setItem('codebaer.lastRepo', path);
    clearTimeout(S.saveTimer);
    S.open = null;
    S.selected = null;
    S.filesOpen.clear();
    for (const f of features()) f.onRepoChange?.reset();
    const before = S.status;
    await refresh();
    // scripts/smoke.sh waits for this line. refresh() leaves S.status as it was when it fails, or when it only
    // queues behind one already running, which a first open with no watcher yet cannot hit.
    const status = S.status;
    if (status && status !== before) logInfo(`opened ${opened.root}, ${plural(status.files.length, 'changed file')}`);
    const first = S.status ? buildQueue(S.status).unstaged[0] : undefined;
    if (first) await openRow(first);
    else notify();
  } catch (e) {
    toast(errText(e), 'err');
    await pickRepo();
  }
}

export async function pickRepo(): Promise<void> {
  const dir = await pickFolder('Open a git repository');
  if (dir !== null) await openRepo(dir);
}
