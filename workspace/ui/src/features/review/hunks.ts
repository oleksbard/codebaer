import { acceptText, buildQueue, rejectSpecialCase, rowKey, unstageText } from '#core/model';
import { flush, guarded, openRow, refresh, selectChunk, view } from '#core/session';
import {
  acceptChunk, chunkCount, chunkIndexAtCursor, getOriginalDoc, goToNextChunk, goToPreviousChunk, rejectChunk,
  replaceDoc, replaceOriginal,
} from '#editor/editor';
import { errKind, errText, git } from '#ipc/git';
import { confirmDialog, toast } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';

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
    // a file opened while this was in flight owns the view now, and this index is not its own
    if (idx && S.open === o) {
      replaceOriginal(view, idx.text); o.originalOid = idx.oid; o.originalExists = idx.exists;
    }
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
    if (idx && S.open === o) { replaceDoc(view, idx.text); o.docOid = idx.oid; }
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

export function nextFile(dir: 1 | -1): void {
  if (!S.status) return;
  const q = buildQueue(S.status);
  const rows = [...q.unstaged, ...q.staged];
  if (!rows.length) return;
  const i = rows.findIndex((r) => rowKey(r) === S.selected);
  const idx = i === -1 ? (dir > 0 ? 0 : rows.length - 1) : (i + dir + rows.length) % rows.length;
  void openRow(rows[idx]!);
}

export async function discardAll(): Promise<void> {
  if (S.status?.files.some((f) => f.conflicted)) { toast('Resolve conflicts first', 'warn'); return; }
  let preview: string[] = [];
  try { preview = await git.discardPreview(); } catch (e) { toast(errText(e), 'err'); return; }
  const changed = S.status ? buildQueue(S.status).unstaged.filter((r) => !r.untracked && !r.conflicted).length : 0;
  const list = preview.length ? `\nUntracked entries removed:\n  ${preview.join('\n  ')}` : '';
  if (!(await confirmDialog(`Discard unstaged changes in ${changed} file${changed === 1 ? '' : 's'}?${list}`))) return;
  await guarded('discardAll', () => git.discardAll());
}
