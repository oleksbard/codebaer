import { afterAll, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { openRow, view } from '#core/session';
import { git, type Blob, type FileText, type Status } from '#ipc/git';
import { S } from '#kernel/store';
import { tick } from './test-setup';

/** A test file that uses these mocks `#ipc/git` itself, before its imports, as vi.mock has to be per file. */
export const g = git as unknown as Record<string, ReturnType<typeof vi.fn<(...args: never[]) => Promise<unknown>>>>;

export const blob = (text: string, oid: string | null = 'oid1'): Blob =>
  ({ text, eol: 'lf', oid, exists: oid !== null });
export const file = (text: string, exists = true): FileText => ({ text, eol: 'lf', exists });
export const status = (path: string, x = '.', y = 'M', untracked = false, conflicted = false): Status => ({
  head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, stash: 0,
  files: [{ path, indexStatus: x, worktreeStatus: y, untracked, conflicted }],
});

let root: Root | undefined;

/** Mounts the real app, which main.tsx does on import. */
export async function mountApp(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  ({ root } = await import('./main'));
  await tick();
}

// Vitest deletes jsdom's globals when it stops the worker, and a render landing in that turn (a toast timing out,
// the refresh a guarded action leaves running) leaves React a passive-effect task that reads `window` and fails the
// run. Unmounted, the app renders nothing more; the second tick lets React run the task the unmount queued.
afterAll(async () => {
  root?.unmount();
  root = undefined;
  await tick();
  await tick();
});

/** Opens `path` in the Unstaged view through the real open path. */
export async function openUnstaged(path: string, index: Blob, disk: FileText): Promise<void> {
  g.readBlob!.mockResolvedValue(index);
  g.readFile!.mockResolvedValue(disk);
  g.status!.mockResolvedValue(S.status);
  await openRow({ section: 'unstaged', path, letter: 'M', untracked: false, conflicted: false });
  g.readBlob!.mockClear();
  g.readFile!.mockClear();
}

export function type(text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/** The action `id` (its `data-all`) of a section header in the change queue: its own button when it has one, else
 *  its item in the header menu, which this opens. */
export async function headerItem(sec: 'unstaged' | 'staged', id: string): Promise<HTMLElement> {
  // an open menu is modal, so one left open by the test before is closed first
  if (document.querySelector('.queue-menu')) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
  }
  const header = `details[data-sec="${sec}"] summary`;
  const own = document.querySelector<HTMLElement>(`${header} [data-all="${id}"]`);
  if (own) return own;
  document.querySelector<HTMLElement>(`${header} [data-all="menu"]`)!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  return document.querySelector<HTMLElement>(`.queue-menu [data-all="${id}"]`)!;
}
