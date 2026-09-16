import { describe, expect, it } from 'vitest';
import { acceptText, buildQueue, decideRefresh, FLUSH_SET, rejectSpecialCase, rowKey, unstageText, visibleFiles } from './model';
import type { FileEntry, Status } from './git';

const f = (path: string, x = '.', y = '.', extra: Partial<FileEntry> = {}): FileEntry =>
  ({ path, indexStatus: x, worktreeStatus: y, untracked: false, conflicted: false, ...extra });
const status = (files: FileEntry[]): Status => ({ head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, files });

describe('buildQueue', () => {
  it('splits MM into both sections and keeps conflicts out of staged', () => {
    const q = buildQueue(status([f('a', 'M', 'M'), f('b', 'M', '.'), f('c', '.', 'M'), f('n', '.', '.', { untracked: true }), f('u', 'U', 'U', { conflicted: true })]));
    expect(q.unstaged.map((r) => r.path)).toEqual(['a', 'c', 'n', 'u']);
    expect(q.staged.map((r) => r.path)).toEqual(['a', 'b']);
    expect(q.unstaged.find((r) => r.path === 'u')?.conflicted).toBe(true);
  });
  it('shows a staged deletion plus recreated file in both sections as two rows', () => {
    const q = buildQueue(status([f('x', 'D', '.', { untracked: true })]));
    expect(q.staged.map((r) => r.letter)).toEqual(['D']);
    expect(q.unstaged.map((r) => r.letter)).toEqual(['?']);
    expect(rowKey(q.staged[0]!)).not.toEqual(rowKey(q.unstaged[0]!));
  });
});

describe('decideRefresh', () => {
  const disk = (text: string, exists = true) => ({ text, eol: 'lf' as const, exists });
  it('does nothing when disk equals baseline, including both absent', () => {
    expect(decideRefresh(disk('a'), 'a', true)).toBe('none');
    expect(decideRefresh(disk('', false), null, true)).toBe('none');
  });
  it('replaces when clean and badges when dirty', () => {
    expect(decideRefresh(disk('b'), 'a', false)).toBe('replace');
    expect(decideRefresh(disk('b'), 'a', true)).toBe('badge');
    expect(decideRefresh(disk('', false), 'a', true)).toBe('badge');
  });
});

describe('visibleFiles', () => {
  it('drops tracked files deleted from disk but keeps a recreated one', () => {
    const s = status([f('gone', '.', 'D'), f('back', 'D', '.', { untracked: true })]);
    expect(visibleFiles(['gone', 'back', 'other'], s)).toEqual(['back', 'other']);
  });
});

describe('special cases', () => {
  it('flush set matches the spec list and excludes commit and reads', () => {
    for (const k of ['stageContent', 'stagePath', 'unstagePath', 'revertPath', 'stageAll', 'unstageAll', 'discardAll', 'switchBranch', 'pull', 'stashPush', 'stashPop', 'openRepo']) expect(FLUSH_SET.has(k)).toBe(true);
    for (const k of ['commit', 'status', 'readBlob', 'readFile', 'push', 'listFiles', 'branches']) expect(FLUSH_SET.has(k)).toBe(false);
  });
  it('reject special cases', () => {
    expect(rejectSpecialCase(null, true)).toBe('restore');
    expect(rejectSpecialCase('text', false)).toBe('removeConfirm');
    expect(rejectSpecialCase('text', true)).toBe(null);
  });
  it('accept and unstage empty-doc rules', () => {
    expect(acceptText('', null)).toBe(null);
    expect(acceptText('', 'was')).toBe('');
    expect(acceptText('x', null)).toBe('x');
    expect(unstageText('', false)).toBe(null);
    expect(unstageText('', true)).toBe('');
  });
});
