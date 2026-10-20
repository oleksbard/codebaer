import { visibleFiles } from '#core/model';
import { guarded, openPlain } from '#core/session';
import { findInFolder } from '#features/search';
import { errKind, errText, git } from '#ipc/git';
import { copyItem, copyPath } from '#kernel/clipboard';
import { promptDialog, toast } from '#kernel/dialogs';
import { pick } from '#kernel/pick';
import { within } from '#kernel/paths';
import { platform } from '#kernel/platform';
import { notify, S } from '#kernel/store';
import type { MenuItem } from '#ui/ContextMenu';

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

/** The Files tree; ignored entries are listed too, so the tab shows what git is hiding. */
export async function loadFiles(): Promise<void> {
  const listing = await git.listFiles();
  S.files = visibleFiles(listing.files, S.status!);
  S.ignoredBase = listing.ignored;
  S.emptyDirs = listing.empty;
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

export async function quickOpen(): Promise<void> {
  try {
    const files = visibleFiles((await git.listFiles()).files,
      S.status ?? { head: null, branch: null, upstream: null, ahead: 0, behind: 0, stash: 0, files: [] });
    const p = await pick(files.map((f) => ({ label: f, value: f })), 'Search files by name');
    if (p) await openPlain(p);
  } catch (e) {
    toast(errText(e), 'err');
  }
}

export async function showFiles(): Promise<void> {
  S.tab = 'files';
  if (S.status) {
    try { await loadFiles(); } catch (e) { toast(errText(e), 'err'); }
  }
  notify();
}

const REVEAL = platform() === 'macos' ? 'Reveal in Finder' : 'Open containing folder';

async function reveal(path: string): Promise<void> {
  try {
    await git.revealPath(path);
  } catch (e) {
    toast(errText(e), 'err');
  }
}

export function fileMenu(path: string): MenuItem[] {
  return [
    { label: REVEAL, onSelect: () => void reveal(path) },
    { label: 'Copy path', onSelect: () => void copyPath(S.root === null ? path : `${S.root}/${path}`) },
    copyItem(path),
  ];
}

/** A name may hold slashes, which make the folders between. The file is written empty with no expected text, which
 *  the backend refuses as Stale when something is already there. */
export async function create(dir: string, kind: 'file' | 'folder'): Promise<void> {
  const root = S.root;
  const typed = await promptDialog(kind === 'file' ? 'New file name' : 'New folder name');
  // the backend drops `.` and empty segments too, so the path that opens is the one the tree lists
  const name = (typed ?? '').split('/').map((p) => p.trim()).filter((p) => p && p !== '.').join('/');
  if (!name || S.root !== root) return;
  const path = `${dir}/${name}`;
  const made = await guarded(async () => {
    try {
      if (kind === 'file') await git.writeFile(path, '', 'lf', null);
      else await git.createDir(path);
    } catch (e) {
      throw errKind(e) === 'Stale' || errKind(e) === 'Special' ? { kind: 'Io', detail: `${path} already exists` } : e;
    }
    return true;
  });
  if (!made || S.root !== root) return;
  const open = kind === 'file' ? path.slice(0, path.lastIndexOf('/')) : path;
  const shown = [open];
  for (let i = open.lastIndexOf('/'); i >= 0; i = open.lastIndexOf('/', i - 1)) shown.unshift(open.slice(0, i));
  for (const d of shown) S.filesOpen.add(d);
  notify();
  // git lists nothing inside an ignored folder, so each one on the way down is read off disk again, in order: a
  // read lists the next folder as ignored
  for (const d of shown) {
    if (!within(d, dir) || (!S.ignoredKids.has(d) && !S.ignored.includes(`${d}/`))) continue;
    S.ignoredKids.delete(d);
    await expandIgnored(d);
  }
  if (kind === 'file') await openPlain(path);
}

/** Search skips what git ignores, so an ignored folder has nothing to find in. */
export function dirMenu(path: string, ignored: boolean): MenuItem[] {
  const find: MenuItem[] = ignored ? [] : [{ label: 'Find in folder…', onSelect: () => findInFolder(path) }];
  return [
    { label: 'Create file…', onSelect: () => void create(path, 'file') },
    { label: 'Create folder…', onSelect: () => void create(path, 'folder') },
    ...find,
    ...fileMenu(path),
  ];
}
