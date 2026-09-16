import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { errKind, errText, git, staleText, type Branch, type Eol, type FileText, type Status } from './git';
import { acceptText, buildQueue, decideRefresh, FLUSH_SET, rejectSpecialCase, rowKey, unstageText, visibleFiles, type Row } from './model';
import {
  acceptChunk, buildState, chunkCount, chunkIndexAtCursor, getOriginalDoc, goToNextChunk, goToPreviousChunk, rejectChunk, replaceDoc, replaceOriginal, type ViewKind,
} from './editor';
import { getChunks } from '@codemirror/merge';
import { Queue, type Tab } from './queue';
import { esc, pick } from './palette';
import { confirmDialog, toast } from './toast';
import { installKeys, type Action } from './keys';

type Open = {
  path: string;
  view: ViewKind;
  eol: Eol;
  baseline: string | null;
  originalOid: string | null;
  originalExists: boolean;
  docOid: string | null;
  dirty: boolean;
  badge: FileText | null;
  panel: string | null;
  conflicted: boolean;
};

const PANEL_KINDS = new Set(['Binary', 'NotUtf8', 'TooLarge', 'Special']);
const PANEL_TEXT: Record<string, string> = {
  Binary: 'binary file', NotUtf8: 'not UTF-8', TooLarge: 'over 2 MB', Special: 'not a regular file',
};

export const S = {
  root: null as string | null,
  status: null as Status | null,
  files: [] as string[],
  tab: 'changes' as Tab,
  open: null as Open | null,
  selected: null as string | null,
  refreshing: false,
  refreshAgain: false,
  saveTimer: 0 as ReturnType<typeof setTimeout> | 0,
  flushing: null as Promise<boolean> | null,
  openEpoch: 0,
};

document.getElementById('app')!.innerHTML = `
<div class="app" id="shell">
  <header class="head">
    <div class="brand"><img src="/icon.png" alt="">CodeBär</div>
    <div class="branch"><button id="branch-btn" title="Checkout to…"><span id="branch-name">…</span><span id="ab"></span></button>
      <span class="spin" id="spin"></span><button class="kbtn" id="cancel-btn" hidden>Cancel</button><span id="repo-name"></span></div>
    <div class="right"><button class="kbtn" id="palette-btn">Commands <kbd>⌘⇧P</kbd></button></div>
  </header>
  <aside class="side" id="side"></aside>
  <main class="main"><div class="tbar" id="tbar"></div><div id="banner"></div><div class="editor-host" id="host"></div><div class="blank" id="blank"></div></main>
  <footer class="foot"><span id="queue-info"></span><span class="save" id="save-info"></span></footer>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const view = new EditorView({ state: EditorState.create({ doc: '' }), parent: $('host') });
const queue = new Queue($('side'), {
  openRow: (row) => void openRow(row),
  openPlain: (path) => void openPlain(path),
  stageFile: (path) => void guarded('stagePath', () => git.stagePath(path)),
  revertFile: (path) => void rejectFile(path),
  unstageFile: (path) => void guarded('unstagePath', () => git.unstagePath(path)),
  commit: (msg) => void commit(msg),
  setTab: (tab) => void setTab(tab),
  stageAll: () => void guarded('stageAll', () => git.stageAll()),
  unstageAll: () => void guarded('unstageAll', () => git.unstageAll()),
});

// ---------- rendering ----------
function renderQueue() {
  if (!S.status) return;
  const q = buildQueue(S.status);
  queue.render(q, S.files, S.selected, S.tab);
  const n = q.unstaged.length;
  $('queue-info').textContent = n ? `${n} file${n > 1 ? 's' : ''} to review` : 'nothing left to review';
}
function renderHeader() {
  const st = S.status;
  if (!st) return;
  $('branch-name').textContent = st.head === null ? 'no commits' : st.branch ?? st.head.slice(0, 8);
  $('ab').textContent = st.upstream ? `↑${st.ahead} ↓${st.behind}` : 'no upstream';
  $('repo-name').textContent = S.root ?? '';
}
function renderFoot() {
  const o = S.open;
  const el = $('save-info');
  el.className = 'save' + (o?.dirty ? ' dirty' : '');
  el.textContent = o?.dirty ? 'unsaved' : '';
}
function renderTitle() {
  const o = S.open;
  const tbar = $('tbar');
  const banner = $('banner');
  const blank = $('blank');
  if (!o) {
    tbar.innerHTML = '';
    banner.innerHTML = '';
    $('host').hidden = true;
    blank.hidden = false;
    const n = S.status ? buildQueue(S.status).unstaged.length : 0;
    blank.innerHTML = `<div><img src="/icon.png" alt=""><h2>${n ? `${n} files to review` : 'Nothing left to review'}</h2><p>${n ? 'Pick a file on the left, or press ⌥F5 to start at the first hunk.' : 'Write a message and commit with ⌘↩, or wait for the agent.'}</p></div>`;
    return;
  }
  const [dir, name] = (() => { const i = o.path.lastIndexOf('/'); return i < 0 ? ['', o.path] : [o.path.slice(0, i + 1), o.path.slice(i + 1)]; })();
  const title = `<span class="file"><span class="dir">${esc(dir)}</span>${esc(name)}</span>`;
  const badge = o.badge ? `<span class="pill warn">changed on disk<button data-act="reload">Reload</button><button data-act="keepMine">Keep mine</button></span>` : '';
  if (o.panel) {
    $('host').hidden = true;
    blank.hidden = false;
    // git refuses revert_path and stage_content on an unmerged path, so a conflicted
    // record gets the panel text and nothing to press
    const btns = o.conflicted ? ''
      : o.view === 'unstaged' ? `<button class="btn" data-act="rejectFile">Reject file</button> <button class="btn primary" data-act="acceptFile">Accept file</button>`
      : o.view === 'staged' ? `<button class="btn" data-act="unstageFile">Unstage file</button>` : '';
    tbar.innerHTML = `${title}<span class="pos">${PANEL_TEXT[o.panel] ?? o.panel}</span><div class="right">${badge}</div>`;
    banner.innerHTML = '';
    blank.innerHTML = `<div><h2>${PANEL_TEXT[o.panel] ?? o.panel}</h2>${btns ? `<p>Whole-file actions only.</p><p>${btns}</p>` : ''}</div>`;
    return;
  }
  $('host').hidden = false;
  blank.hidden = true;
  if (o.conflicted) {
    tbar.innerHTML = `${title}<span class="pos">conflict</span><div class="right">${badge}<button class="btn primary" data-act="acceptFile">Mark resolved</button></div>`;
    banner.innerHTML = `<div class="banner conflict">Resolve the markers, then stage the file.</div>`;
    return;
  }
  const chunks = chunkCount(view.state);
  const at = chunkIndexAtCursor(view.state);
  const pos = o.view === 'plain' ? 'working tree' : chunks ? `hunk ${Math.max(at, 0) + 1} of ${chunks}` : o.view === 'staged' ? 'nothing staged' : 'no unstaged changes';
  const pill = o.view === 'plain' ? 'whole file, current state' : o.view === 'staged' ? 'HEAD → index · read only' : 'index → working tree';
  const btns = o.view === 'unstaged' && chunks ? `<button class="btn" data-act="reject">Reject <kbd>⌘N</kbd></button><button class="btn primary" data-act="accept">Accept <kbd>⌘Y</kbd></button>`
    : o.view === 'staged' && chunks ? `<button class="btn" data-act="unstage">Unstage <kbd>⌘K ⌘N</kbd></button>`
    : o.view === 'plain' && hasUnstaged(o.path) ? `<button class="btn" data-act="viewChanges">View changes</button>` : '';
  tbar.innerHTML = `${title}<span class="pos">${pos}</span><div class="right">${badge}<span class="pill">${pill}</span>${btns}</div>`;
  const changed = S.status?.files.some((f) => f.path === o.path && (o.view === 'staged' ? f.indexStatus !== '.' : f.worktreeStatus !== '.' || f.untracked));
  banner.innerHTML = o.view !== 'plain' && chunks === 0 && changed
    ? `<div class="banner">line endings, filters, or file mode only. ${o.view === 'unstaged' ? '<button class="btn" data-act="rejectFile">Reject file</button> <button class="btn primary" data-act="acceptFile">Accept file</button>' : '<button class="btn" data-act="unstageFile">Unstage file</button>'}</div>`
    : '';
}
function hasUnstaged(path: string): boolean {
  return !!S.status?.files.some((f) => f.path === path && (f.worktreeStatus !== '.' || f.untracked));
}
function renderAll() { renderHeader(); renderQueue(); renderTitle(); renderFoot(); }

document.querySelector('main')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!b || !S.open) return;
  const p = S.open.path;
  const acts: Record<string, () => unknown> = {
    accept, reject, unstage: unstageHunk,
    acceptFile: () => guarded('stagePath', () => git.stagePath(p)),
    rejectFile: () => rejectFile(p),
    unstageFile: () => guarded('unstagePath', () => git.unstagePath(p)),
    viewChanges: () => openRow({ section: 'unstaged', path: p, letter: 'M', untracked: false, conflicted: false }),
    reload: async () => {
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
      } catch (e) {
        toast(errText(e), 'err');
      }
      renderAll();
    },
    keepMine: () => { const o = S.open!; if (!o.badge) return; o.baseline = o.badge.exists ? o.badge.text : null; o.badge = null; void flush(); },
  };
  void acts[b.dataset.act!]?.();
});

// ---------- refresh ----------
export async function refresh(): Promise<void> {
  if (S.refreshing) { S.refreshAgain = true; return; }
  S.refreshing = true;
  try {
    S.status = await git.status();
    if (S.tab === 'files') S.files = visibleFiles(await git.listFiles(), S.status);
    await refreshOpen();
    renderAll();
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
      if (orig.oid !== o.originalOid) { replaceOriginal(view, orig.text); o.originalOid = orig.oid; o.originalExists = orig.exists; }
    }
    if (o.view === 'staged') {
      const idx = await git.readBlob('index', o.path);
      if (stale()) return;
      if (idx.oid !== o.docOid) { replaceDoc(view, idx.text); o.docOid = idx.oid; o.eol = idx.eol; }
    } else {
      const disk = await git.readFile(o.path);
      if (stale()) return;
      const d = decideRefresh(disk, o.baseline, o.dirty);
      if (d === 'replace') { replaceDoc(view, disk.text); o.baseline = disk.exists ? disk.text : null; o.eol = disk.eol; o.badge = null; }
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
  renderFoot();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => void flush(), 300);
}

async function flush(): Promise<boolean> {
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
      renderFoot();
      renderTitle();
      return true;
    } catch (e) {
      const stale = staleText(e);
      if (stale) { o.badge = stale; renderTitle(); return false; }
      toast(`not saved: ${errText(e)}`, 'err');
      return false;
    } finally {
      S.flushing = null;
    }
  })();
  S.flushing = p;
  return p;
}

export async function guarded<T>(name: keyof typeof git, fn: () => Promise<T>): Promise<T | undefined> {
  if (FLUSH_SET.has(name) && !(await flush())) {
    toast(S.open?.badge ? 'This file changed on disk. Reload or Keep mine first.' : 'not saved, see the error above', 'warn');
    return undefined;
  }
  try {
    return await fn();
  } catch (e) {
    toast(errText(e), 'err');
    return undefined;
  } finally {
    void refresh();
  }
}

// ---------- open ----------
export async function openRow(row: Row): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  const epoch = ++S.openEpoch;
  S.selected = rowKey(row);
  if (row.conflicted) { await openConflict(row.path); renderAll(); return; }
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
    const opened: Open = { path: row.path, view: kind, eol, baseline, originalOid: orig.oid, originalExists: orig.exists, docOid, dirty: false, badge: null, panel: null, conflicted: false };
    const state = await buildState(kind, row.path, doc, orig.text, markDirty, kind === 'unstaged' ? { accept: () => void accept(), reject: () => void reject() } : undefined);
    if (epoch !== S.openEpoch) return;
    S.open = opened;
    view.setState(state);
    selectChunk(0);
  } catch (e) {
    if (epoch !== S.openEpoch) return;
    // the panel is set for every error kind, not only the four with panel copy: it is what
    // disables accept, reject and flush. Without it the failed open leaves the previous file's
    // document mounted under this path, and one file's text reaches another file's index or disk
    S.open = { path: row.path, view: kind, eol: 'lf', baseline: null, originalOid: null, originalExists: false, docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: false };
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
  renderAll();
}

async function openPlain(path: string): Promise<void> {
  if (!(await flush())) return;
  clearTimeout(S.saveTimer);
  const epoch = ++S.openEpoch;
  S.selected = `plain:${path}`;
  try {
    const f = await git.readFile(path);
    const opened: Open = { path, view: 'plain', eol: f.eol, baseline: f.exists ? f.text : null, originalOid: null, originalExists: false, docOid: null, dirty: false, badge: null, panel: null, conflicted: false };
    const state = await buildState('plain', path, f.text, null, markDirty);
    if (epoch !== S.openEpoch) return;
    S.open = opened;
    view.setState(state);
  } catch (e) {
    if (epoch !== S.openEpoch) return;
    S.open = { path, view: 'plain', eol: 'lf', baseline: null, originalOid: null, originalExists: false, docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: false };
    view.setState(EditorState.create({ doc: '' }));
    if (!PANEL_KINDS.has(errKind(e))) toast(errText(e), 'err');
  }
  renderAll();
}

async function openConflict(path: string): Promise<void> {
  const epoch = ++S.openEpoch;
  try {
    const f = await git.readFile(path);
    const opened: Open = { path, view: 'unstaged', eol: f.eol, baseline: f.exists ? f.text : null, originalOid: null, originalExists: false, docOid: null, dirty: false, badge: null, panel: null, conflicted: true };
    const state = await buildState('plain', path, f.text, null, markDirty);
    if (epoch !== S.openEpoch) return;
    S.open = opened;
    view.setState(state);
  } catch (e) {
    if (epoch !== S.openEpoch) return;
    const opened: Open = { path, view: 'unstaged', eol: 'lf', baseline: null, originalOid: null, originalExists: false, docOid: null, dirty: false, badge: null, panel: errKind(e), conflicted: true };
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

// ---------- hunk actions ----------
async function accept(): Promise<void> {
  const o = S.open;
  if (!o || o.view !== 'unstaged' || o.panel || o.conflicted) return;
  if (chunkIndexAtCursor(view.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  if (!(await flush())) return;
  acceptChunk(view);
  const text = acceptText(getOriginalDoc(view.state).toString(), o.baseline);
  try {
    const r = await git.stageContent(o.path, text, o.eol, o.originalOid);
    o.originalOid = r.oid;
    o.originalExists = r.oid !== null;
  } catch (e) {
    const idx = await git.readBlob('index', o.path).catch(() => null);
    if (idx) { replaceOriginal(view, idx.text); o.originalOid = idx.oid; o.originalExists = idx.exists; }
    if (errKind(e) === 'StaleIndex') toast('index changed under you, your accept was dropped, re-diffed', 'warn');
    else toast(errText(e), 'err');
  }
  await refresh();
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
    if (!confirmDialog(`Delete ${o.path}?\nIts content is not in git and cannot be recovered.`)) return;
    try { await git.revertPath(o.path); o.baseline = null; o.dirty = false; } catch (e) { toast(errText(e), 'err'); }
    await refresh();
    return;
  }
  if (chunkIndexAtCursor(view.state) < 0) { toast('Put the cursor in a hunk first', 'info'); return; }
  rejectChunk(view);
  await flush();
  await refresh();
}

async function unstageHunk(): Promise<void> {
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

async function rejectFile(path: string): Promise<void> {
  if (!confirmDialog(`Discard unstaged changes in ${path}?\nAccepted hunks stay staged.`)) return;
  await guarded('revertPath', () => git.revertPath(path));
}

function nextHunk(dir: 1 | -1): void {
  const o = S.open;
  const moved = o && o.view === 'unstaged' && !o.panel && !o.conflicted && (dir > 0 ? goToNextChunk(view) : goToPreviousChunk(view));
  if (moved) { renderTitle(); return; }
  const rows = S.status ? buildQueue(S.status).unstaged : [];
  if (!rows.length) { toast('Nothing left to review', 'info'); return; }
  const i = rows.findIndex((r) => rowKey(r) === S.selected);
  const idx = i === -1 ? (dir > 0 ? 0 : rows.length - 1) : (i + dir + rows.length) % rows.length;
  const next = rows[idx]!;
  void openRow(next).then(() => { if (dir < 0) selectChunk(chunkCount(view.state) - 1); renderTitle(); });
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
async function commit(msg: string): Promise<void> {
  if (!msg) { toast('Type a commit message first', 'err'); queue.focusCommit(); return; }
  try {
    await git.commit(msg);
    queue.clearMessage();
    toast('Committed', 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
  void refresh();
}

async function network(name: 'push' | 'pull'): Promise<void> {
  if (name === 'pull' && !(await flush())) return;
  $('spin').classList.add('on');
  $('cancel-btn').hidden = false;
  try {
    await (name === 'push' ? git.push() : git.pull());
    toast(name === 'push' ? 'Pushed' : 'Pulled', 'ok');
  } catch (e) {
    if (errKind(e) === 'Cancelled') toast('Cancelled', 'info');
    else toast(errText(e), 'err');
  } finally {
    $('spin').classList.remove('on');
    $('cancel-btn').hidden = true;
    await refresh();
    const st = await git.status().catch(() => null);
    const conflicts = st?.files.filter((f) => f.conflicted).map((f) => f.path) ?? [];
    if (conflicts.length) toast(`${name} left ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}:\n  ${conflicts.join('\n  ')}\nFix the markers, then stage the file.`, 'warn');
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
  if (!confirmDialog(`Discard unstaged changes in ${changed} file${changed === 1 ? '' : 's'}?${list}`)) return;
  await guarded('discardAll', () => git.discardAll());
}

async function checkout(): Promise<void> {
  let bs: Branch[] = [];
  try { bs = await git.branches(); } catch (e) { toast(errText(e), 'err'); return; }
  const b = await pick(bs.map((br) => ({ label: br.kind === 'local' ? br.name : `${br.remote}/${br.branch}`, detail: br.kind, value: br })), 'Select a branch to checkout');
  if (b) await guarded('switchBranch', () => git.switchBranch(b));
}

async function palette(): Promise<void> {
  const cmds: { label: string; hint?: string; run: () => unknown }[] = [
    { label: 'Git: Commit', hint: '⌘↩', run: () => { S.tab = 'changes'; renderQueue(); queue.focusCommit(); } },
    { label: 'Git: Push', run: () => network('push') },
    { label: 'Git: Pull', run: () => network('pull') },
    { label: 'Git: Checkout to…', run: checkout },
    { label: 'Git: Stash', run: () => guarded('stashPush', () => git.stashPush()) },
    { label: 'Git: Pop Stash', run: stashPop },
    { label: 'Git: Stage All Changes', hint: '⌘⌥Y', run: () => guarded('stageAll', () => git.stageAll()) },
    { label: 'Git: Unstage All Changes', run: () => guarded('unstageAll', () => git.unstageAll()) },
    { label: 'Git: Discard All Changes', run: discardAll },
    { label: 'Git: Stage File', hint: '⌘⇧Y', run: () => S.open && guarded('stagePath', () => git.stagePath(S.open!.path)) },
    { label: 'Git: Discard File', hint: '⌘⇧N', run: () => S.open && rejectFile(S.open.path) },
    { label: 'Git: Unstage File', run: () => S.open && guarded('unstagePath', () => git.unstagePath(S.open!.path)) },
    { label: 'Open Repository…', run: pickRepo },
  ];
  const unborn = S.status?.head === null;
  const shown = unborn ? cmds.filter((c) => !c.label.includes('Stash')) : cmds;
  const c = await pick(shown.map((x) => ({ label: x.label, hint: x.hint, value: x })), 'Type a command');
  if (c) void c.run();
}

async function quickOpen(): Promise<void> {
  try {
    const files = visibleFiles(await git.listFiles(), S.status ?? { head: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] });
    const p = await pick(files.map((f) => ({ label: f, value: f })), 'Search files by name');
    if (p) await openPlain(p);
  } catch (e) {
    toast(errText(e), 'err');
  }
}

async function setTab(tab: Tab): Promise<void> {
  S.tab = tab;
  if (tab === 'files' && S.status) {
    try { S.files = visibleFiles(await git.listFiles(), S.status); } catch (e) { toast(errText(e), 'err'); }
  }
  renderQueue();
}

// ---------- startup and repo switching ----------
async function openRepo(path: string): Promise<void> {
  if (!(await flush())) { toast('This file changed on disk. Reload or Keep mine before switching repos.', 'warn'); return; }
  try {
    S.root = await git.openRepo(path);
    localStorage.setItem('codebaer.lastRepo', path);
    clearTimeout(S.saveTimer);
    S.open = null;
    S.selected = null;
    await refresh();
    const first = S.status ? buildQueue(S.status).unstaged[0] : undefined;
    if (first) await openRow(first);
    else renderAll();
  } catch (e) {
    toast(errText(e), 'err');
    await pickRepo();
  }
}

async function pickRepo(): Promise<void> {
  const dir = await openDialog({ directory: true, multiple: false, title: 'Open a git repository' });
  if (typeof dir === 'string') await openRepo(dir);
}

function dispatch(a: Action): void {
  const map: Record<Action, () => unknown> = {
    nextHunk: () => nextHunk(1), prevHunk: () => nextHunk(-1),
    accept, reject, unstage: unstageHunk,
    acceptFile: () => S.open && guarded('stagePath', () => git.stagePath(S.open!.path)),
    rejectFile: () => S.open && rejectFile(S.open.path),
    stageAll: () => guarded('stageAll', () => git.stageAll()),
    nextFile: () => nextFile(1), prevFile: () => nextFile(-1),
    quickOpen, palette,
    save: () => { if (S.open?.dirty) void flush(); },
    toggleSidebar: () => $('shell').classList.toggle('nosidebar'),
    focusList: () => queue.focusList(),
    focusEditor: () => view.focus(),
    focusCommit: () => { S.tab = 'changes'; renderQueue(); queue.focusCommit(); },
    filesTab: () => { void setTab('files').then(() => queue.focusList()); },
    escape: () => { if (S.open?.badge) { S.open.badge = null; renderTitle(); } },
  };
  void map[a]();
}

async function start(): Promise<void> {
  try {
    await git.gitVersion();
  } catch (e) {
    document.getElementById('app')!.innerHTML = `<div class="fatal">CodeBär needs git on this machine. ${esc(errText(e))}</div>`;
    return;
  }
  installKeys(dispatch);
  $('branch-btn').onclick = () => void checkout();
  $('palette-btn').onclick = () => void palette();
  $('cancel-btn').onclick = () => void git.cancel();
  globalThis.addEventListener('blur', () => void flush());
  view.dom.addEventListener('keyup', renderTitle);
  view.dom.addEventListener('mouseup', renderTitle);
  await listen('repo-changed', () => void refresh());
  await listen<string>('open-repo', (e) => void openRepo(e.payload));
  const initial = (await git.initialRepo()) ?? localStorage.getItem('codebaer.lastRepo');
  if (initial) await openRepo(initial);
  else await pickRepo();
}

// vitest imports this module for its side effects and drives the exported functions itself
if (!import.meta.env.VITEST) void start();
