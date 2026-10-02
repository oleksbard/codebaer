import type { BlameLine, Branch, FileEntry, FileText } from '#ipc/git';

export type Section = 'unstaged' | 'staged';
export type Row = { section: Section; path: string; letter: string; untracked: boolean; conflicted: boolean };

export const rowKey = (r: { section: Section; path: string }) => `${r.section}:${r.path}`;

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export const split = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

export function buildQueue(s: { readonly files: readonly FileEntry[] }): { unstaged: Row[]; staged: Row[] } {
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

/** What each git letter means, for the tooltip on the letter the queue and the tree show. */
export const STATUS_LABEL: Record<string, string> = {
  A: 'Added', C: 'Copied', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed',
  U: 'Untracked', '!': 'Conflict',
};

const TONE: Record<string, string> = { M: 'M', T: 'M', D: 'D', '!': '!' };
const tone = (letter: string): string => TONE[letter] ?? 'A';

/** The tree's letter per file: what is left to review, else what is staged. A directory gets the tone
 *  its changed files share, a conflict below it wins, and a mix reads as modified. Only `listed` paths
 *  count, so a folder is never marked for a deletion the tree does not show. */
export function treeStatus(s: { readonly files: readonly FileEntry[] } | null, listed: ReadonlySet<string>): {
  files: Map<string, string>;
  dirs: Map<string, string>;
} {
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  if (!s) return { files, dirs };
  const q = buildQueue(s);
  for (const r of [...q.staged, ...q.unstaged]) if (listed.has(r.path)) files.set(r.path, r.letter);
  for (const [p, letter] of files) {
    const t = tone(letter);
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
      const dir = p.slice(0, i);
      const was = dirs.get(dir);
      dirs.set(dir, was === undefined || was === t ? t : was === '!' || t === '!' ? '!' : 'M');
    }
  }
  return { files, dirs };
}

export type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: string[] };

/** Groups paths into a directory tree. Sorting the paths first is what puts both the directories
 *  and the files of every node in name order, so no node needs a second sort. */
export function buildTree(files: readonly string[]): TreeDir {
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
  for (const p of [...new Set(files)].sort()) {
    // a trailing slash marks a directory listed without its contents: it gets a node, no leaf
    if (p.endsWith('/')) { dirAt(p.slice(0, -1)); continue; }
    const i = p.lastIndexOf('/');
    dirAt(i < 0 ? '' : p.slice(0, i)).files.push(p);
  }
  return root;
}

export type TreeLine =
  | { kind: 'dir'; dir: TreeDir; depth: number; parent: string }
  | { kind: 'file'; path: string; depth: number; parent: string };

/** The rows of the tree with the `open` folders expanded; nothing under a closed folder is visited. */
export function flattenTree(root: TreeDir, open: ReadonlySet<string>): TreeLine[] {
  const out: TreeLine[] = [];
  const walk = (node: TreeDir, depth: number): void => {
    for (const dir of node.dirs) {
      out.push({ kind: 'dir', dir, depth, parent: node.path });
      if (open.has(dir.path)) walk(dir, depth + 1);
    }
    for (const path of node.files) out.push({ kind: 'file', path, depth, parent: node.path });
  };
  walk(root, 0);
  return out;
}

export function decideRefresh(disk: FileText, baseline: string | null, dirty: boolean): 'none' | 'replace' | 'badge' {
  const diskText = disk.exists ? disk.text : null;
  if (diskText === baseline) return 'none';
  return dirty ? 'badge' : 'replace';
}

export function visibleFiles(list: readonly string[], s: { readonly files: readonly FileEntry[] }): string[] {
  const deleted = new Set(s.files
    .filter((e: FileEntry) => e.worktreeStatus === 'D' && !e.untracked).map((e) => e.path));
  return list.filter((p) => !deleted.has(p));
}

const DEFAULT_BRANCHES = ['main', 'master', 'develop'];

export function pinDefaultBranches(bs: Branch[]): Branch[] {
  const rank = (b: Branch) => {
    const i = b.kind === 'local' ? DEFAULT_BRANCHES.indexOf(b.name) : -1;
    return i < 0 ? DEFAULT_BRANCHES.length : i;
  };
  return [...bs].sort((a, b) => rank(a) - rank(b));
}

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
export function blameTip(b: BlameLine): { label: string; detail?: string } {
  if (ZERO_OID.test(b.oid)) return { label: 'uncommitted' };
  const date = new Date(b.time * 1000).toISOString().slice(0, 10);
  const detail = [b.oid.slice(0, 7), b.author, date].filter(Boolean).join(' · ');
  return b.summary ? { label: b.summary, detail } : { label: detail };
}

/** What the file bar shows of `blameTip`, which it keeps for the hover. */
export function blameShort(b: BlameLine, nowMs: number): string {
  if (ZERO_OID.test(b.oid)) return 'uncommitted';
  return [b.author, ago(nowMs / 1000 - b.time)].filter(Boolean).join(' · ');
}

/** A commit dated ahead of this machine's clock reads as just now. */
export function ago(secs: number): string {
  const m = Math.floor(secs / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (m < 1) return 'just now';
  if (h < 1) return `${m}m ago`;
  if (d < 1) return `${h}h ago`;
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
