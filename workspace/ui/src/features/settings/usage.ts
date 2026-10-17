import { telemetry } from '#ipc/telemetry';
import { askDialog } from '#kernel/dialogs';
import { idle } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { setSetting } from './settings';

export const USAGE_ASK = 'Help improve CodeBär?\n'
  + 'CodeBär can send anonymous usage data: when the app opens, and how many repositories, hunks, files, commits, AI '
  + 'commit messages, pushes and terminals you had, with the app version and your OS. It never sends code, file '
  + 'names, paths or repository names. It helps a lot with the development of CodeBär. You can change this at any '
  + 'time in Settings.';

/** Asks once, on the launch the backend says. A launch that cannot ask, or whose question another dialog replaced,
 *  leaves it to the next launch. */
export async function startUsageData(): Promise<void> {
  S.usageDataAvailable = await telemetry.available();
  notify();
  if (!S.usageDataAvailable || !(await telemetry.promptDue()) || !idle()) return;
  const share = await askDialog(USAGE_ASK, { ok: 'Share usage data', cancel: 'No thanks' });
  if (share === null) return;
  if (share) {
    await setSetting('general.usage-data', 'on');
    // the save failed and said so: the user is asked again next time
    if (S.settings['general.usage-data'] !== 'on') return;
  }
  await telemetry.answered(share);
}
