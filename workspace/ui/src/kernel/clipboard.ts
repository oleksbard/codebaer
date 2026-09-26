import { errText } from '#ipc/git';
import type { MenuItem } from '#ui/ContextMenu';
import { toast } from './dialogs';

export async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast(`Copied ${path}`, 'ok');
  } catch (e) {
    toast(`Could not copy the path: ${errText(e)}`, 'err');
  }
}

export const copyItem = (path: string): MenuItem =>
  ({ label: 'Copy relative path', onSelect: () => void copyPath(path) });
