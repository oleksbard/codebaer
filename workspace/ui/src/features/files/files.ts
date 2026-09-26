import { visibleFiles } from '#core/model';
import { openPlain } from '#core/session';
import { errText, git } from '#ipc/git';
import { toast } from '#kernel/dialogs';
import { pick } from '#kernel/pick';
import { notify, S } from '#kernel/store';

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
      S.status ?? { head: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] });
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
