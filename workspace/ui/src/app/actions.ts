import type { Tab } from '#core/state';
import { showFiles } from '#features/files';
import { showTerminals } from '#features/terminals';
import { notify, S } from '#kernel/store';

export function toggleSidebar(): void {
  S.sidebarHidden = !S.sidebarHidden;
  localStorage.setItem('codebaer.sidebarHidden', String(S.sidebarHidden));
  notify();
}

export function setSideWidth(w: number): void {
  S.sideWidth = w;
}

export async function setTab(tab: Tab): Promise<void> {
  if (tab === 'files') await showFiles();
  else if (tab === 'terminals') await showTerminals();
  else { S.tab = tab; notify(); }
}
