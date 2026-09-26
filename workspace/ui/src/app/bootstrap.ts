import { errText, git } from '#ipc/git';
import { logError } from '#ipc/log';
import { installKeys } from '#kernel/keymap';
import { listenAll, register, run } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { flush, openRepo, pickRepo, view } from '#core/session';
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
  globalThis.addEventListener('blur', () => void flush());
  view.dom.addEventListener('keyup', notify);
  view.dom.addEventListener('mouseup', notify);
  await listenAll();
  const initial = (await git.initialRepo()) ?? localStorage.getItem('codebaer.lastRepo');
  if (initial) await openRepo(initial);
  else await pickRepo();
}
