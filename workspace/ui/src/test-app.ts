import { vi } from 'vitest';
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
  head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0,
  files: [{ path, indexStatus: x, worktreeStatus: y, untracked, conflicted }],
});

/** Mounts the real app, which main.tsx does on import. */
export async function mountApp(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  await tick();
}

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
