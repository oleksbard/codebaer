import { errText, git } from '#ipc/git';
import { logInfo } from '#ipc/log';
import { S } from '#kernel/store';

const EVERY_MS = 3 * 60_000;
const TICK_MS = 30_000;

/** When this module last started a fetch, or the user's Fetch or Pull last succeeded. */
let last = 0;
/** The repository, branch and upstream of the last status read. */
let seen = '';
let running = false;
/** One of those changed while a fetch ran, which may have been another repository's or another remote's. */
let again = false;
let lastError = '';

const on = (): boolean => S.settings['general.auto-fetch'] === 'on' && Boolean(S.status?.upstream);

/** No state to write afterwards: the new remote-tracking refs fire the watcher, whose refresh shows the counts. */
async function fetchNow(): Promise<void> {
  running = true;
  last = Date.now();
  try {
    await git.fetchBackground();
    lastError = '';
  } catch (e) {
    const text = errText(e);
    // offline, this fails every few minutes: logged once until the reason changes
    if (text !== lastError) logInfo(`auto fetch: ${text}`);
    lastError = text;
  } finally {
    running = false;
    if (again) {
      again = false;
      if (on()) void fetchNow();
    }
  }
}

/** A repository, branch or upstream that differs from the last status read starts a fetch, or queues one behind
 *  the fetch this module has running. The backend skips it while the user's own push, pull or fetch runs. */
export function onStatus(): void {
  const key = JSON.stringify([S.root, S.status?.branch, S.status?.upstream]);
  if (key === seen) return;
  seen = key;
  if (running) again = true;
  else if (on()) void fetchNow();
}

export function fetched(): void {
  last = Date.now();
}

export function startAutoFetch(): void {
  setInterval(() => {
    if (!on() || running || document.visibilityState === 'hidden' || Date.now() - last < EVERY_MS) return;
    void fetchNow();
  }, TICK_MS);
}
