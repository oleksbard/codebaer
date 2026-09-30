import { settleAll } from '#core/session';
import { errText, git, type Update } from '#ipc/git';
import { logInfo } from '#ipc/log';
import { confirmDialog, toast } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';

/** After the launch, which has a repo to open. */
const FIRST_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;
const TICK_MS = 10 * 60_000;
const AFTER_UPDATE = 'codebaer.afterUpdate';
/** Longer than the download may take, and short enough that a relaunch which never started leaves no mark for a
 *  later launch to misread. */
const MARK_MS = 15 * 60_000;

let running: Promise<Update | null> | null = null;
let lastError = '';
let installing = false;

/** One at a time: a second would wait on the backend for the first one's download, and find the same. */
function check(): Promise<Update | null> {
  running ??= git.updateCheck().then((found) => {
    if (found !== null && S.update === null) {
      S.update = found;
      notify();
    }
    return found;
  }).finally(() => { running = null; });
  return running;
}

const due = (): boolean => S.update === null && S.settings['general.check-updates'] === 'on';

async function autoCheck(): Promise<void> {
  try {
    await check();
    lastError = '';
  } catch (e) {
    const text = errText(e);
    // offline, this fails every few hours: logged once until the reason changes
    if (text !== lastError) logInfo(`update check: ${text}`);
    lastError = text;
  }
}

export async function startUpdates(): Promise<void> {
  S.canUpdate = await git.updateEnabled();
  notify();
  if (!S.canUpdate) return;
  let last = 0;
  const auto = (): void => {
    if (!due()) return;
    last = Date.now();
    void autoCheck();
  };
  setTimeout(auto, FIRST_MS);
  // a tick rather than one long interval, which a sleeping laptop stretches
  setInterval(() => { if (Date.now() - last >= EVERY_MS) auto(); }, TICK_MS);
}

const ready = (u: Update): void => toast(`CodeBär ${u.version} is out. Install it from the button in the header.`);

export async function checkForUpdates(): Promise<void> {
  if (S.update !== null) {
    ready(S.update);
    return;
  }
  toast('Checking for updates…');
  try {
    const found = await check();
    if (found !== null) ready(found);
    else toast(`CodeBär ${await git.appVersion()} is the newest version`);
  } catch (e) {
    toast(`Could not check for updates: ${errText(e)}`, 'err');
  }
}

export async function restartToUpdate(): Promise<void> {
  const u = S.update;
  if (u === null || installing) return;
  installing = true;
  try {
    if (!(await settleAll())) return;
    const live = S.terminals.filter((t) => t.state.t !== 'Exited').length;
    if (!u.keeps_terminals && live > 0) {
      const which = live === 1 ? 'the running terminal' : `the ${live} running terminals`;
      const message = `CodeBär ${u.version} cannot take over running terminals, so restarting ends ${which}.`;
      if (!(await confirmDialog(message))) return;
    }
    toast(`Downloading CodeBär ${u.version}…`);
    // the new app is started with this one's arguments, whose repo may not be the open one any more
    localStorage.setItem(AFTER_UPDATE, String(Date.now()));
    await git.updateInstall();
    // the app quits a moment after this resolves; until then there is nothing left to click
    S.update = null;
    notify();
  } catch (e) {
    localStorage.removeItem(AFTER_UPDATE);
    toast(`Could not install the update: ${errText(e)}`, 'err');
  } finally {
    installing = false;
  }
}

/** True once, in the app that a restart into an update started. */
export function restartedIntoUpdate(): boolean {
  const at = Number(localStorage.getItem(AFTER_UPDATE));
  localStorage.removeItem(AFTER_UPDATE);
  return at > 0 && Date.now() - at < MARK_MS;
}

export function openReleaseNotes(): void {
  const page = S.update?.page;
  if (page) git.openUrl(page).catch((e: unknown) => toast(`Could not open the release notes: ${errText(e)}`, 'err'));
}
