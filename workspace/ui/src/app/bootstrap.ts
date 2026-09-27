import { errText, git } from '#ipc/git';
import { logError } from '#ipc/log';
import { installKeys } from '#kernel/keymap';
import { listenAll, register, run } from '#kernel/registry';
import { notify, S, subscribe } from '#kernel/store';
import { openRepo, pickRepo, view } from '#core/session';
import { startAutoFetch } from '#features/git-ops';
import { connectTerminals } from '#features/terminals';
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
  const initial = (await git.initialRepo()) ?? localStorage.getItem('codebaer.lastRepo');
  if (initial) await openRepo(initial);
  else await pickRepo();
}
