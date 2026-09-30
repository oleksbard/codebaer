import { errText, git } from '#ipc/git';
import { logError } from '#ipc/log';
import { installKeys } from '#kernel/keymap';
import { listenAll, register, run } from '#kernel/registry';
import { notify, S, subscribe } from '#kernel/store';
import { lastRepo, openRepo, pickRepo, reopenAtLaunch, view } from '#core/session';
import { startAutoFetch } from '#features/git-ops';
import { connectTerminals } from '#features/terminals';
import { restartedIntoUpdate, startUpdates } from '#features/updates';
import { loadSettings } from '#features/settings';
import { FEATURES } from './features';

register(FEATURES);

export async function start(): Promise<void> {
  try {
    await git.gitVersion();
  } catch (e) {
    S.fatal = errText(e);
    notify();
    return;
  }
  loadSettings().catch((e: unknown) => logError(e, 'load settings'));
  installKeys(run, (visible) => { S.chord = visible; notify(); });
  // not deferred to the first visit any more: the activity bar lists every session on every tab
  void connectTerminals();
  startAutoFetch();
  startUpdates().catch((e: unknown) => logError(e, 'updates'));
  // the backend asks before the window closes or the app quits only while it knows of unsaved changes
  let unsaved = false;
  subscribe(() => {
    if (!!S.open?.dirty === unsaved) return;
    unsaved = !unsaved;
    git.setUnsaved(unsaved).catch((e: unknown) => logError(e, 'set_unsaved'));
  });
  view.dom.addEventListener('keyup', notify);
  view.dom.addEventListener('mouseup', notify);
  await listenAll();
  try {
    const initial = (restartedIntoUpdate() ? null : await git.initialRepo()) ?? reopenAtLaunch();
    if (initial) await openRepo(initial);
    // only a first launch asks at once; after a close, the no-repo screen offers the repo again
    else if (lastRepo() === null) await pickRepo();
  } finally {
    S.starting = false;
    notify();
  }
}
