import type { BlameLine, FileEntry, FileText, Status } from './git';

export type Section = 'unstaged' | 'staged';
export type Row = { section: Section; path: string; letter: string; untracked: boolean; conflicted: boolean };

export const rowKey = (r: { section: Section; path: string }) => `${r.section}:${r.path}`;

export const split = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

export function buildQueue(s: Status): { unstaged: Row[]; staged: Row[] } {
  const unstaged: Row[] = [];
  const staged: Row[] = [];
  for (const e of s.files) {
    // VS Code's SCM alphabet: U untracked, ! conflicted (git itself prints ? and U)
    if (e.conflicted) {
      unstaged.push({ section: 'unstaged', path: e.path, letter: '!', untracked: false, conflicted: true });
      continue;
    }
    if (e.worktreeStatus !== '.' || e.untracked) {
      const letter = e.untracked && e.worktreeStatus === '.' ? 'U' : e.worktreeStatus;
      unstaged.push({ section: 'unstaged', path: e.path, letter, untracked: e.untracked, conflicted: false });
    }
    if (e.indexStatus !== '.') {
      staged.push({ section: 'staged', path: e.path, letter: e.indexStatus, untracked: false, conflicted: false });
    }
  }
  return { unstaged, staged };
}

export type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: string[] };

/** Groups paths into a directory tree. Sorting the paths first is what puts both the directories
 *  and the files of every node in name order, so no node needs a second sort. */
export function buildTree(files: string[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [] };
  const seen = new Map<string, TreeDir>([['', root]]);
  const dirAt = (path: string): TreeDir => {
    const hit = seen.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf('/');
    const node: TreeDir = { name: path.slice(i + 1), path, dirs: [], files: [] };
    dirAt(i < 0 ? '' : path.slice(0, i)).dirs.push(node);
    seen.set(path, node);
    return node;
  };
  for (const p of [...files].sort()) {
    const i = p.lastIndexOf('/');
    dirAt(i < 0 ? '' : p.slice(0, i)).files.push(p);
  }
  return root;
}

export function decideRefresh(disk: FileText, baseline: string | null, dirty: boolean): 'none' | 'replace' | 'badge' {
  const diskText = disk.exists ? disk.text : null;
  if (diskText === baseline) return 'none';
  return dirty ? 'badge' : 'replace';
}

export function visibleFiles(list: string[], s: Status): string[] {
  const deleted = new Set(s.files
    .filter((e: FileEntry) => e.worktreeStatus === 'D' && !e.untracked).map((e) => e.path));
  return list.filter((p) => !deleted.has(p));
}

export const FLUSH_SET: ReadonlySet<string> = new Set([
  'stageContent', 'stagePath', 'unstagePath', 'revertPath', 'stageAll', 'unstageAll', 'discardAll',
  'switchBranch', 'pull', 'stashPush', 'stashPop', 'openRepo',
]);

export function rejectSpecialCase(
  baseline: string | null, originalExists: boolean,
): 'restore' | 'removeConfirm' | null {
  if (baseline === null) return 'restore';
  if (!originalExists) return 'removeConfirm';
  return null;
}

export const acceptText = (text: string, baseline: string | null): string | null =>
  text === '' && baseline === null ? null : text;
export const unstageText = (text: string, headExists: boolean): string | null =>
  text === '' && !headExists ? null : text;

const ZERO_OID = /^0+$/;

/** A line that is not in HEAD blames to the zero oid, where git's own author and summary read
 *  "External file (--contents)" and "Version of <file> from standard input". */
export function blameText(b: BlameLine): string {
  if (ZERO_OID.test(b.oid)) return 'uncommitted';
  const date = new Date(b.time * 1000).toISOString().slice(0, 10);
  return [b.oid.slice(0, 7), b.author, date, b.summary].filter(Boolean).join(' · ');
}
