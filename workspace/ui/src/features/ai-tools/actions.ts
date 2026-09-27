import { errText, git } from '#ipc/git';
import { logError } from '#ipc/log';
import type { AiProvider } from '#ipc/settings';
import { toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { notify, S } from '#kernel/store';
import type { Tool } from './catalog';

/** Bumped per check and on close, so a check started for one dialog cannot land in the next. */
const checks = epoch();

async function check(): Promise<void> {
  const live = checks.next();
  let installed: AiProvider[] | null = null;
  try {
    installed = await git.installedAiProviders();
  } catch (e) {
    logError(e, 'installed AI tools');
  }
  const cur = S.aiTools;
  if (!live() || !cur) return;
  if (installed) cur.installed = installed;
  cur.failed = !installed;
  cur.checking = false;
  notify();
}

export function openAiTools(): void {
  S.aiTools = { installed: null, checking: true, failed: false };
  notify();
  void check();
}

/** Run when the window gets the focus back, so a tool installed meanwhile moves to the installed cards. */
export function checkAgain(): void {
  if (!S.aiTools || S.aiTools.checking) return;
  S.aiTools.checking = true;
  notify();
  void check();
}

export function closeAiTools(): void {
  checks.bump();
  S.aiTools = null;
  notify();
}

export async function openGuide(tool: Tool): Promise<void> {
  try {
    await git.openUrl(tool.url);
  } catch (e) {
    logError(e, `open ${tool.url}`);
    toast(`Could not open ${tool.url}: ${errText(e)}`, 'err');
  }
}

export async function copyInstall(tool: Tool): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(tool.install);
    return true;
  } catch (e) {
    toast(`Could not copy the command: ${errText(e)}`, 'err');
    return false;
  }
}
