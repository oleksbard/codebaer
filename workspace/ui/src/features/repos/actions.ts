import { split } from '#core/model';
import { lastRepo } from '#core/session';
import { glyph } from '#features/command-icons';
import { errText, git, type Recent } from '#ipc/git';
import { logError } from '#ipc/log';
import { toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { notify, S } from '#kernel/store';
import { keepPickedIcon } from './avatar';

/** The open repo's name in the header: its title, else its folder. */
export const repoName = (root: string, title: string | null): string => title ?? split(root)[1];

/** The repo opened last, as the recents name it; null once it has left them. */
export async function lastOpened(): Promise<Recent | null> {
  const path = lastRepo();
  if (path === null) return null;
  try {
    return (await git.recentRepos()).find((r) => r.path === path) ?? null;
  } catch (e) {
    logError(e, 'recent repos');
    return null;
  }
}

/** Bumped by every open, toggle and close, so an answer that lands late is dropped. */
const prefsEpoch = epoch();

/** The favorite mark is read afresh: the palette opens this too, without the switcher's list. */
export async function openRepoPrefs(): Promise<void> {
  const root = S.root;
  if (root === null) return;
  const live = prefsEpoch.next();
  let favorite = false;
  try {
    favorite = (await git.recentRepos()).some((r) => r.path === root && r.favorite);
  } catch (e) {
    logError(e, 'recent repos');
  }
  if (!live() || S.root !== root) return;
  S.repoPrefs = { path: root, name: repoName(root, S.title), label: S.rootLabel ?? root, favorite };
  notify();
}

export function closeRepoPrefs(): void {
  prefsEpoch.bump();
  S.repoPrefs = null;
  notify();
}

export async function setFavorite(favorite: boolean): Promise<void> {
  const prefs = S.repoPrefs;
  if (!prefs) return;
  const live = prefsEpoch.next();
  prefs.favorite = favorite;
  notify();
  let list: Recent[] | null = null;
  try {
    list = await git.favoriteRepo(prefs.path, favorite);
  } catch (e) {
    logError(e, 'favorite repo');
    toast(`Could not change the favorite: ${errText(e)}`, 'err');
  }
  if (!live() || S.repoPrefs !== prefs) return;
  // the backend keeps a favorite only for a repo in its recents
  prefs.favorite = list ? list.some((r) => r.path === prefs.path && r.favorite) : !favorite;
  notify();
}

/** Null hands the icon back to the AI. */
export function setRepoIcon(id: string | null): void {
  const prefs = S.repoPrefs;
  if (!prefs) return;
  const g = id === null ? null : glyph(id);
  if (id !== null && !g) return;
  keepPickedIcon(prefs.path, id !== null && g ? { id, ...g } : null);
  notify();
}
