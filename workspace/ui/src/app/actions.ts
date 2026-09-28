import type { Tab } from '#core/state';
import { showFiles } from '#features/files';
import { showTerminals } from '#features/terminals';
import { errText, git } from '#ipc/git';
import { toast } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';

export function toggleSidebar(): void {
  S.sidebarHidden = !S.sidebarHidden;
  localStorage.setItem('codebaer.sidebarHidden', String(S.sidebarHidden));
  notify();
}

/** The native menu's About panel on macOS; Linux has no menu bar. */
export async function about(): Promise<void> {
  try {
    toast(`CodeBär ${await git.appVersion()}`);
  } catch (e) {
    toast(`Could not read the version: ${errText(e)}`, 'err');
  }
}

export function setSideWidth(w: number): void {
  S.sideWidth = w;
}

export async function setTab(tab: Tab): Promise<void> {
  if (tab === 'files') await showFiles();
  else if (tab === 'terminals') await showTerminals();
  else { S.tab = tab; notify(); }
}
