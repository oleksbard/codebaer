import { openPlain, selectAt } from '#core/session';
import { errText, git, type SearchFile, type SearchHit, type SearchMsg } from '#ipc/git';
import { epoch } from '#kernel/epoch';
import { notify, refs, S, type DeepReadonly } from '#kernel/store';

/** VS Code's wait before it searches as you type. */
const DEBOUNCE_MS = 300;

const runs = epoch();
let timer: ReturnType<typeof setTimeout> | undefined;

export const searchKey = (path: string, hit: { line: number; col: number }): string =>
  `${path}:${hit.line}:${hit.col}`;

const byPath = (a: SearchFile, b: SearchFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void runSearch(), DEBOUNCE_MS);
}

export function setQuery(query: string): void {
  S.searchQuery = query;
  notify();
  schedule();
}

export function setInclude(include: string): void {
  S.searchInclude = include;
  notify();
  schedule();
}

/** `quiet` keeps the old results on screen until the new ones are complete: a search run again because files
 *  changed would otherwise blank the list for a moment on every agent edit. */
export async function runSearch(quiet = false): Promise<void> {
  clearTimeout(timer);
  const live = runs.next();
  const query = S.searchQuery;
  S.searchStale = false;
  if (!query) {
    S.searchFiles = [];
    S.searchBusy = false;
    S.searchTruncated = false;
    S.searchError = null;
    notify();
    // stops a search still running for the last query
    await git.search('', '', () => {}).catch(() => {});
    return;
  }
  const found: SearchFile[] = [];
  if (!quiet) {
    S.searchFiles = [];
    S.searchTruncated = false;
  }
  S.searchError = null;
  S.searchBusy = true;
  notify();
  // the last batch and Done can arrive after the command itself resolves, so Done is what ends the search
  const onMsg = (m: SearchMsg): void => {
    if (!live()) return;
    if (m.t === 'Files') {
      found.push(...m.files);
      if (quiet) return;
    } else {
      S.searchTruncated = m.truncated;
      S.searchBusy = false;
    }
    S.searchFiles = [...found].sort(byPath);
    notify();
    if (m.t === 'Done' && S.searchStale && S.tab === 'search') void runSearch(true);
  };
  try {
    await git.search(query, S.searchInclude, onMsg);
  } catch (e) {
    if (!live()) return;
    S.searchFiles = [];
    S.searchBusy = false;
    S.searchError = errText(e);
    notify();
  }
}

/** Files changed: run the search again if it is on screen, else when it next is. A search still running finishes
 *  first and then runs again: a build writes files faster than a big repo is searched, so a restart on every
 *  change would never finish, and would leave a typed search's first files on screen as if they were all. */
export function searchChanged(): void {
  if (!S.searchQuery) return;
  if (S.tab === 'search' && !S.searchBusy) void runSearch(true);
  else S.searchStale = true;
}

export function showSearch(): void {
  S.tab = 'search';
  notify();
  if (S.searchStale) void runSearch(true);
}

export function focusSearch(): void {
  refs.search?.focus();
  refs.search?.select();
}

export function toggleSearchFile(path: string): void {
  if (!S.searchCollapsed.delete(path)) S.searchCollapsed.add(path);
  notify();
}

/** The file already open as a plain file only moves its selection: reading it again would cost a round trip on
 *  every arrow press. Not while another file opens (`S.selected` already names it), or that open lands after. */
type HitAt = Pick<DeepReadonly<SearchHit>, 'line' | 'col' | 'ranges'>;

export async function openHit(path: string, hit: HitAt): Promise<void> {
  const before = S.searchSelected;
  const key = searchKey(path, hit);
  S.searchSelected = key;
  const [from = 0, to = 0] = hit.ranges[0] ?? [];
  const at = { line: hit.line, col: hit.col, len: to - from };
  const shown = S.open?.path === path && S.open.view === 'plain' && !S.open.panel;
  if (shown && S.selected === `plain:${path}`) {
    selectAt(at);
    notify();
    return;
  }
  notify();
  await openPlain(path, at);
  // the user kept the unsaved file the open asked about, so the hit they left stays the selected one
  if (S.open?.path !== path && S.searchSelected === key) {
    S.searchSelected = before;
    notify();
  }
}

export function resetSearch(): void {
  runs.bump();
  clearTimeout(timer);
  S.searchFiles = [];
  S.searchBusy = false;
  S.searchTruncated = false;
  S.searchError = null;
  S.searchCollapsed.clear();
  S.searchSelected = null;
  S.searchStale = S.searchQuery !== '';
  // stops a search still running in the repo before
  void git.search('', '', () => {}).catch(() => {});
}
