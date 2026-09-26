import type {
  AppError, BlameLine, Blob, Branch, DiffStat, Eol, FileEntry, FileText, Listing, StageResult, Status,
} from '#ipc/git';

export type Version = { text: string; eol: Eol };
/** null is absent at that stage. `kind` makes every read of the path fail the way the real one does. */
export type Entry = {
  head: Version | null; index: Version | null; work: Version | null;
  kind: 'binary' | 'large' | null; conflicted: boolean;
};

/** Omitted stages inherit: index from head, work from index. null is absent. */
export type FileSeed = {
  head?: string | null; index?: string | null; work?: string | null;
  eol?: Eol; kind?: 'binary' | 'large'; conflicted?: boolean;
};

export type RepoSeed = {
  files: Record<string, FileSeed>;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: Branch[];
  /** As `list_files` reports them: a wholly ignored directory ends in a slash. */
  ignored: string[];
  /** `list_dir` answers, keyed by directory without the trailing slash. */
  dirs: Record<string, string[]>;
  /** Commit summaries, newest first; blame and the HEAD oid come from these. */
  log: string[];
};

export type Snapshot = {
  branch: string | null; upstream: string | null; ahead: number; behind: number; head: string | null;
  files: Record<string, { head: string | null; index: string | null; work: string | null }>;
};

/** A stand-in for a git object id: 40 hex digits that change with the content. */
export function oidOf(s: string): string {
  let out = '';
  for (let seed = 0; out.length < 40; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

function fail(e: AppError): never {
  throw e;
}
function gitError(detail: string): never {
  throw { kind: 'Git', detail } satisfies AppError;
}
const same = (a: Version | null, b: Version | null): boolean =>
  a === b || (a !== null && b !== null && a.text === b.text && a.eol === b.eol);
const oidOfVersion = (v: Version): string => oidOf(`${v.eol}\0${v.text}`);

/** Lines as `--numstat` counts them: an unterminated last line is a line of its own. */
const linesOf = (v: Version | null): string[] => (v ? v.text.match(/[^\n]*\n|[^\n]+$/g) ?? [] : []);

/** `--numstat` for one file, from a longest common subsequence of lines. */
function lineStat(a: string[], b: string[]): DiffStat {
  let prev = Array.from({ length: b.length + 1 }, () => 0);
  for (const x of a) {
    const row = [0];
    b.forEach((y, j) => row.push(x === y ? prev[j]! + 1 : Math.max(prev[j + 1]!, row[j]!)));
    prev = row;
  }
  const common = prev[b.length]!;
  return { added: b.length - common, removed: a.length - common };
}

const ZERO = '0'.repeat(40);
const AUTHORS = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds'];
const EPOCH = 1_789_000_000;

function fromSeed(s: FileSeed): Entry {
  const eol = s.eol ?? 'lf';
  const v = (t: string | null): Version | null => (t === null ? null : { text: t, eol });
  const head = s.head ?? null;
  const index = s.index === undefined ? head : s.index;
  const work = s.work === undefined ? index : s.work;
  return { head: v(head), index: v(index), work: v(work), kind: s.kind ?? null, conflicted: s.conflicted ?? false };
}

/** The same rules as git's `ref-name` checks that `valid_ref_part` in git.rs applies. */
function validRef(s: string): void {
  const control = Array.from(s).some((c) => c < ' ' || c === '\x7f');
  if (s === '' || s.startsWith('-') || s.includes('..') || /[\s~^:?*[\\]/.test(s) || control) {
    gitError(`invalid branch name: ${JSON.stringify(s)}`);
  }
}

export type Repo = ReturnType<typeof createRepo>;

export function createRepo(seed: RepoSeed) {
  const files = new Map(Object.entries(seed.files).map(([p, s]) => [p, fromSeed(s)]));
  let { branch, upstream, ahead, behind } = seed;
  const branches: Branch[] = [...seed.branches];
  const log = [...seed.log];
  let head: string | null = log.length ? oidOf(log.join('\n')) : null;
  const stash: Map<string, Entry>[] = [];

  const entry = (path: string): Entry => {
    let e = files.get(path);
    if (!e) {
      e = { head: null, index: null, work: null, kind: null, conflicted: false };
      files.set(path, e);
    }
    return e;
  };
  const readable = (e: Entry): void => {
    if (e.kind === 'binary') fail({ kind: 'Binary' });
    if (e.kind === 'large') fail({ kind: 'TooLarge' });
  };
  const noConflicts = (): void => {
    if ([...files.values()].some((e) => e.conflicted)) fail({ kind: 'Conflicted' });
  };
  /** Porcelain v2 as `status::parse` folds it, including the `1 D.` plus `?` pair for a staged
   *  deletion whose file is back on disk. */
  const entryStatus = (path: string, e: Entry): FileEntry | null => {
    if (e.conflicted) return { path, indexStatus: 'U', worktreeStatus: 'U', untracked: false, conflicted: true };
    if (!e.index) {
      if (!e.head && !e.work) return null;
      return { path, indexStatus: e.head ? 'D' : '.', worktreeStatus: '.', untracked: !!e.work, conflicted: false };
    }
    const x = !e.head ? 'A' : same(e.head, e.index) ? '.' : 'M';
    const y = !e.work ? 'D' : same(e.index, e.work) ? '.' : 'M';
    if (x === '.' && y === '.') return null;
    return { path, indexStatus: x, worktreeStatus: y, untracked: false, conflicted: false };
  };
  const readFile = (path: string): FileText => {
    const e = files.get(path);
    if (!e?.work) return { text: '', eol: 'lf', exists: false };
    readable(e);
    return { text: e.work.text, eol: e.work.eol, exists: true };
  };
  const indexOid = (e: Entry | undefined): string | null => (e?.index ? oidOfVersion(e.index) : null);
  const untracked = (): string[] => [...files].filter(([, e]) => !e.index && e.work).map(([p]) => p).sort();

  return {
    status(): Status {
      const list = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => entryStatus(p, e));
      return { head, branch, upstream, ahead, behind, files: list.filter((f): f is FileEntry => f !== null) };
    },

    readFile,

    /** `diff_stat_impl`: a binary file and an untracked one over the size cap count nothing, and an
     *  unmerged path is diffed against ours, which is HEAD. */
    diffStat(): DiffStat {
      const sum = { added: 0, removed: 0 };
      for (const e of files.values()) {
        if (e.kind === 'binary' || (e.kind === 'large' && !e.index)) continue;
        const d = lineStat(linesOf(e.conflicted ? e.head : e.index), linesOf(e.work));
        sum.added += d.added;
        sum.removed += d.removed;
      }
      return sum;
    },

    readBlob(rev: 'index' | 'head', path: string): Blob {
      const e = files.get(path);
      if (e?.conflicted) fail({ kind: 'Conflicted' });
      const v = rev === 'index' ? e?.index : e?.head;
      if (!e || !v) return { text: '', eol: 'lf', oid: null, exists: false };
      readable(e);
      return { text: v.text, eol: v.eol, oid: oidOfVersion(v), exists: true };
    },

    /** `write_file_impl`: the write lands only on the text the caller last saw, or on no file for null. */
    writeFile(path: string, text: string, eol: Eol, expected: string | null): void {
      const current = readFile(path);
      const matches = expected === null ? !current.exists : current.exists && current.text === expected;
      if (!matches) fail({ kind: 'Stale', detail: current });
      entry(path).work = { text, eol };
    },

    stageContent(path: string, text: string | null, eol: Eol, expectedOid: string | null): StageResult {
      const e = files.get(path);
      if (e?.conflicted) fail({ kind: 'Conflicted' });
      if (indexOid(e) !== expectedOid) fail({ kind: 'StaleIndex' });
      const target = entry(path);
      target.index = text === null ? null : { text, eol };
      return { oid: indexOid(target) };
    },

    stagePath(path: string): void {
      const e = entry(path);
      e.index = e.work;
      e.conflicted = false;
    },

    unstagePath(path: string): void {
      const e = entry(path);
      e.index = e.head;
      e.conflicted = false;
    },

    revertPath(path: string): void {
      const e = files.get(path);
      if (!e) return;
      if (e.conflicted) fail({ kind: 'Conflicted' });
      e.work = e.index;
    },

    stageAll(): void {
      for (const e of files.values()) { e.index = e.work; e.conflicted = false; }
    },

    unstageAll(): void {
      for (const e of files.values()) { e.index = e.head; e.conflicted = false; }
    },

    discardPreview: untracked,

    discardAll(): void {
      noConflicts();
      for (const e of files.values()) e.work = e.index;
    },

    commit(message: string): void {
      if ([...files.values()].some((e) => e.conflicted)) {
        gitError('error: Committing is not possible because you have unmerged files.');
      }
      if ([...files.values()].every((e) => same(e.head, e.index))) gitError('no changes added to commit');
      for (const [p, e] of files) {
        e.head = e.index;
        if (!e.head && !e.work) files.delete(p);
      }
      log.unshift(message.split('\n')[0] ?? message);
      head = oidOf(log.join('\n'));
      if (upstream) ahead += 1;
    },

    branches: (): Branch[] => [...branches],

    switchBranch(b: Branch): void {
      if (b.kind === 'local') {
        validRef(b.name);
        if (!branches.some((x) => x.kind === 'local' && x.name === b.name)) {
          gitError(`fatal: invalid reference: ${b.name}`);
        }
        branch = b.name;
        upstream = branches.some((x) => x.kind === 'remote' && x.branch === b.name) ? `origin/${b.name}` : null;
      } else {
        validRef(b.remote);
        validRef(b.branch);
        if (!branches.some((x) => x.kind === 'local' && x.name === b.branch)) {
          branches.push({ kind: 'local', name: b.branch });
        }
        branch = b.branch;
        upstream = `${b.remote}/${b.branch}`;
      }
      ahead = 0;
      behind = 0;
    },

    createBranch(name: string): void {
      validRef(name);
      if (branches.some((x) => x.kind === 'local' && x.name === name)) {
        gitError(`fatal: a branch named '${name}' already exists`);
      }
      branches.push({ kind: 'local', name });
      branch = name;
      upstream = null;
      ahead = 0;
      behind = 0;
    },

    /** `stash push --include-untracked`: index and worktree both go back to HEAD. */
    stashPush(): void {
      const saved = new Map<string, Entry>();
      for (const [p, e] of files) {
        if (!same(e.head, e.index) || !same(e.index, e.work)) saved.set(p, { ...e });
      }
      if (!saved.size) return;
      noConflicts();
      stash.unshift(saved);
      for (const [p, e] of saved) {
        const back = files.get(p)!;
        back.index = e.head;
        back.work = e.head;
      }
    },

    stashPop(): void {
      const saved = stash.shift();
      if (!saved) gitError('No stash entries found.');
      for (const [p, e] of saved) {
        const back = entry(p);
        back.index = e.index;
        back.work = e.work;
      }
    },

    listFiles(): Listing {
      const listed = [...files].filter(([, e]) => e.index || e.work).map(([p]) => p).sort();
      return { files: listed, ignored: [...seed.ignored] };
    },

    listDir: (path: string): string[] => seed.dirs[path] ?? [],

    blame(path: string, line: number, contents: string): BlameLine {
      const text = contents.split('\n')[line - 1];
      const committed = files.get(path)?.head?.text.split('\n') ?? [];
      if (text === undefined || !committed.includes(text) || !head) {
        return { oid: ZERO, author: 'External file (--contents)', time: EPOCH, summary: '' };
      }
      const n = committed.indexOf(text) % Math.max(log.length, 1);
      return {
        oid: oidOf(`${n}:${log[n] ?? ''}`),
        author: AUTHORS[n % AUTHORS.length]!,
        time: EPOCH - n * 86_400,
        summary: log[n] ?? '',
      };
    },

    /** `push_args`: a branch with no upstream is pushed with --set-upstream to origin, or to the only remote. */
    push(): void {
      if (!upstream) {
        if (!branch) gitError('fatal: You are not currently on a branch.');
        const remotes = [...new Set(branches.flatMap((b) => (b.kind === 'remote' ? [b.remote] : [])))];
        if (!remotes.length) gitError('this repository has no remote to push to');
        const target = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null;
        if (!target) gitError(`no default push remote; set remote.pushDefault (remotes: ${remotes.join(', ')})`);
        if (!branches.some((b) => b.kind === 'remote' && b.remote === target && b.branch === branch)) {
          branches.push({ kind: 'remote', remote: target, branch });
        }
        upstream = `${target}/${branch}`;
      }
      ahead = 0;
    },

    pull(): void {
      if (!upstream) gitError('There is no tracking information for the current branch.');
      behind = 0;
    },

    stagedPaths: (): string[] => [...files].filter(([, e]) => !same(e.head, e.index)).map(([p]) => p).sort(),

    /** What an agent does: rewrites a file on disk, or deletes it for null. */
    agentWrite(path: string, text: string | null, eol: Eol = 'lf'): void {
      entry(path).work = text === null ? null : { text, eol };
    },

    snapshot(): Snapshot {
      const out: Snapshot['files'] = {};
      for (const [p, e] of files) {
        out[p] = { head: e.head?.text ?? null, index: e.index?.text ?? null, work: e.work?.text ?? null };
      }
      return { branch, upstream, ahead, behind, head, files: out };
    },
  };
}
