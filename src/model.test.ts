import { describe, expect, it } from 'vitest';
import { acceptText, blameText, buildQueue, buildTree, decideRefresh, FLUSH_SET, rejectSpecialCase, rowKey, unstageText, visibleFiles } from './model';
import type { FileEntry, Status } from './git';

const f = (path: string, x = '.', y = '.', extra: Partial<FileEntry> = {}): FileEntry =>
  ({ path, indexStatus: x, worktreeStatus: y, untracked: false, conflicted: false, ...extra });
const status = (files: FileEntry[]): Status => ({ head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, files });

describe('buildTree', () => {
  it('nests every path segment, keeps root files at the top level, and orders both by name', () => {
    const t = buildTree(['src/app/z.ts', 'README.md', 'src/a.ts', 'src/app/api/q.ts', 'docs/g.md']);
    expect(t.files).toEqual(['README.md']);
    expect(t.dirs.map((d) => d.name)).toEqual(['docs', 'src']);
    const src = t.dirs.find((d) => d.name === 'src')!;
    expect(src.files).toEqual(['src/a.ts']);
    expect(src.dirs.map((d) => d.path)).toEqual(['src/app']);
    const app = src.dirs[0]!;
    expect(app.files).toEqual(['src/app/z.ts']);
    expect(app.dirs[0]!.path).toBe('src/app/api');
    expect(app.dirs[0]!.files).toEqual(['src/app/api/q.ts']);
  });
});

describe('buildQueue', () => {
  it('splits MM into both sections and keeps conflicts out of staged', () => {
    const q = buildQueue(status([f('a', 'M', 'M'), f('b', 'M', '.'), f('c', '.', 'M'), f('n', '.', '.', { untracked: true }), f('u', 'U', 'U', { conflicted: true })]));
    expect(q.unstaged.map((r) => r.path)).toEqual(['a', 'c', 'n', 'u']);
    expect(q.staged.map((r) => r.path)).toEqual(['a', 'b']);
    expect(q.unstaged.find((r) => r.path === 'u')?.conflicted).toBe(true);
    expect(q.unstaged.find((r) => r.path === 'u')?.letter).toBe('!');
    expect(q.unstaged.find((r) => r.path === 'n')?.letter).toBe('U');
  });
  it('shows a staged deletion plus recreated file in both sections as two rows', () => {
    const q = buildQueue(status([f('x', 'D', '.', { untracked: true })]));
    expect(q.staged.map((r) => r.letter)).toEqual(['D']);
    expect(q.unstaged.map((r) => r.letter)).toEqual(['U']);
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

describe('blameText', () => {
  it('formats a commit and collapses the zero oid', () => {
    expect(blameText({ oid: '9081303b08673ef3d8b67ebd7250f199e248a0db', author: 'Ada', time: 1789629173, summary: 'Rebuild the UI' }))
      .toBe('9081303 · Ada · 2026-09-17 · Rebuild the UI');
    expect(blameText({ oid: '0'.repeat(40), author: 'External file (--contents)', time: 0, summary: 'from standard input' }))
      .toBe('uncommitted');
  });
});
