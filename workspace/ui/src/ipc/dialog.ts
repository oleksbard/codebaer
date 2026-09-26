import { open } from '@tauri-apps/plugin-dialog';

/** The chosen folder, or null when the dialog was dismissed. */
export async function pickFolder(title: string): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false, title });
  return typeof dir === 'string' ? dir : null;
}
