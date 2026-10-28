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

/** True when the text is on the clipboard; a failure shows as a toast. */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    toast(`Could not copy the ${what}: ${errText(e)}`, 'err');
    return false;
  }
}

export const copyItem = (path: string): MenuItem =>
  ({ label: 'Copy relative path', onSelect: () => void copyPath(path) });
