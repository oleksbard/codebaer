import { invoke } from '@tauri-apps/api/core';
import type { AiProvider, CustomCommand, HiddenScripts, Settings } from './settings';

export type Eol = 'lf' | 'crlf';
export type Rev = 'index' | 'head';

export type FileText = { text: string; eol: Eol; exists: boolean };
export type Blob = { text: string; eol: Eol; oid: string | null; exists: boolean };
export type StageResult = { oid: string | null };
export type Opened = { root: string; label: string; title: string | null };
export type Recent = { path: string; name: string; label: string; favorite: boolean };
/** A newer release, downloaded and verified. `keeps_terminals` is false when it cannot carry the running terminal
 *  sessions over, which its restart then ends. */
export type Update = { version: string; page: string | null; keeps_terminals: boolean };
/** A wholly ignored directory arrives as one entry with a trailing slash. */
export type Listing = { files: string[]; ignored: string[] };
export type BlameLine = { oid: string; author: string; time: number; summary: string };

export type FileEntry = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  conflicted: boolean;
};
export type Status = {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Stash entries; git before 2.35 reports none. */
  stash: number;
  files: FileEntry[];
};
/** The review queue's size in lines: index to working tree, untracked files counted whole. */
export type DiffStat = { added: number; removed: number };
export type Script = { name: string; command: string };
export type Scripts = { runner: string; scripts: Script[] };
export type IconItem = { name: string; command: string };
/** The names to choose from; `ai_command_icons` answers with `<prefix>:<name>`. */
export type IconSet = { prefix: string; title: string; names: string[] };
/** `name` is the one the switcher shows; the backend adds the folder name and a line from the README. */
export type RepoItem = { path: string; name: string };
export type Branch = { kind: 'local'; name: string } | { kind: 'remote'; remote: string; branch: string };
/** `unstaged` takes the untracked files too and leaves the index; `all` takes everything. */
export type StashKind = 'all' | 'staged' | 'unstaged';
/** `index` is the n of `stash@{n}`; `wip` marks git's own `WIP on <branch>: <commit>` message; `time` is in
 *  seconds. */
export type Stash = {
  index: number; oid: string; branch: string | null; message: string; wip: boolean; time: number;
};
/** `summary` is the subject line; `time` is the author date, in seconds. */
export type Commit = { oid: string; summary: string; author: string; time: number };
/** The commits a push would send, newest first; `more` when there are more than the backend lists. */
export type Outgoing = { commits: Commit[]; more: boolean };

export type AppError =
  | { kind: 'Git' | 'Io' | 'InvalidPath' | 'Ai'; detail: string }
  | { kind: 'Stale'; detail: FileText }
  | { kind: 'Timeout' | 'Cancelled' | 'NotARepo' | 'StaleIndex' | 'NotUtf8' | 'Binary' | 'TooLarge'
    | 'Special' | 'Conflicted' | 'WatchLimit' };

export function errKind(e: unknown): string {
  return typeof e === 'object' && e !== null && 'kind' in e ? String(e.kind) : 'Unknown';
}
const KIND_TEXT: Record<string, string> = {
  Timeout: 'git took too long and was stopped',
  Cancelled: 'cancelled',
  NotARepo: 'that folder is not a git repository',
  StaleIndex: 'the index changed under you',
  NotUtf8: 'this file is not UTF-8',
  Binary: 'this file is binary',
  TooLarge: 'this file is over 2 MB',
  Special: 'this path is not a regular file',
  Conflicted: 'this path is unmerged; resolve the markers and stage it',
  WatchLimit: 'too many folders to watch: raise the fs.inotify.max_user_watches sysctl, then open the repo again',
};

export function errText(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'detail' in e) {
    const d = e.detail;
    return typeof d === 'string' ? d : JSON.stringify(d);
  }
  const kind = errKind(e);
  return kind === 'Unknown' ? String(e) : KIND_TEXT[kind] ?? kind;
}
export function staleText(e: unknown): FileText | null {
  return errKind(e) === 'Stale' ? (e as { detail: FileText }).detail : null;
}

export const git = {
  appVersion: () => invoke<string>('app_version'),
  gitVersion: () => invoke<string>('git_version'),
  initialRepo: () => invoke<string | null>('initial_repo'),
  setUnsaved: (unsaved: boolean) => invoke<void>('set_unsaved', { unsaved }),
  quit: () => invoke<void>('quit'),
  /** Only main's macOS packages update themselves. */
  updateEnabled: () => invoke<boolean>('update_enabled'),
  /** Null when this is the newest release. Reads the release's manifest only. */
  updateCheck: () => invoke<Update | null>('update_check'),
  /** Downloads the update found last, puts it in place of the app and restarts, which begins as this resolves. */
  updateInstall: () => invoke<void>('update_install'),
  /** The open repo included. */
  recentRepos: () => invoke<Recent[]>('recent_repos'),
  favoriteRepo: (path: string, favorite: boolean) => invoke<Recent[]>('favorite_repo', { path, favorite }),
  openRepo: (path: string) => invoke<Opened>('open_repo', { path }),
  /** Stops the watcher; every repo command then fails with NotARepo until the next open. */
  closeRepo: () => invoke<void>('close_repo'),
  status: () => invoke<Status>('status'),
  diffStat: () => invoke<DiffStat>('diff_stat'),
  readBlob: (rev: Rev, path: string) => invoke<Blob>('read_blob', { rev, path }),
  readFile: (path: string) => invoke<FileText>('read_file', { path }),
  blame: (path: string, line: number, contents: string, eol: Eol) =>
    invoke<BlameLine>('blame', { path, line, contents, eol }),
  writeFile: (path: string, text: string, eol: Eol, expected: string | null) =>
    invoke<void>('write_file', { path, text, eol, expected }),
  stageContent: (path: string, text: string | null, eol: Eol, expectedOid: string | null) =>
    invoke<StageResult>('stage_content', { path, text, eol, expectedOid }),
  stagePath: (path: string) => invoke<void>('stage_path', { path }),
  unstagePath: (path: string) => invoke<void>('unstage_path', { path }),
  revertPath: (path: string) => invoke<void>('revert_path', { path }),
  stageAll: () => invoke<void>('stage_all'),
  unstageAll: () => invoke<void>('unstage_all'),
  discardPreview: () => invoke<string[]>('discard_preview'),
  discardAll: () => invoke<void>('discard_all'),
  commit: (message: string) => invoke<void>('commit', { message }),
  aiCommitMessage: () => invoke<string>('ai_commit_message'),
  /** null when there is nothing to stash. */
  aiStashDescription: (kind: StashKind) => invoke<string | null>('ai_stash_description', { kind }),
  settings: () => invoke<Settings>('settings_get'),
  saveSettings: (settings: Settings) => invoke<void>('settings_set', { settings }),
  commands: () => invoke<CustomCommand[]>('commands_get'),
  saveCommands: (commands: CustomCommand[]) => invoke<void>('commands_set', { commands }),
  hiddenScripts: () => invoke<HiddenScripts>('hidden_scripts_get'),
  saveHiddenScripts: (hidden: HiddenScripts) => invoke<void>('hidden_scripts_set', { hidden }),
  packageScripts: () => invoke<Scripts | null>('package_scripts'),
  commandIcons: () => invoke<Record<string, string>>('command_icons_get'),
  saveCommandIcons: (picks: Record<string, string>) => invoke<void>('command_icons_set', { picks }),
  /** One id per item, in order; null where the AI named no icon from the sets. */
  aiCommandIcons: (items: IconItem[], sets: IconSet[]) =>
    invoke<(string | null)[]>('ai_command_icons', { items, sets }),
  /** Like `aiCommandIcons`, for the repos in the switcher. */
  aiRepoIcons: (items: RepoItem[], sets: IconSet[]) => invoke<(string | null)[]>('ai_repo_icons', { items, sets }),
  /** Every provider but off whose CLI the backend can find; it asks a login shell, so it can take a second. */
  installedAiProviders: () => invoke<AiProvider[]>('installed_ai_providers'),
  /** An https page only, in the default browser. */
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  branches: () => invoke<Branch[]>('branches'),
  switchBranch: (branch: Branch) => invoke<void>('switch_branch', { branch }),
  createBranch: (name: string) => invoke<void>('create_branch', { name }),
  push: () => invoke<void>('push'),
  pull: () => invoke<void>('pull'),
  fetch: () => invoke<void>('fetch'),
  /** Skips, and resolves, while a push, pull or fetch runs or the setting is off. */
  fetchBackground: () => invoke<void>('fetch_background'),
  cancel: () => invoke<void>('cancel'),
  /** Refused unless `root` is still the open repo. Without a message git writes its own. False when there was
   *  nothing to stash. */
  stashPush: (root: string, kind: StashKind, message: string | null) =>
    invoke<boolean>('stash_push', { root, kind, message }),
  /** Newest first. */
  stashList: () => invoke<Stash[]>('stash_list'),
  /** `oid` is the stash as listed: the pop fails when `stash@{index}` is another one by now. */
  stashPop: (index: number, oid: string) => invoke<void>('stash_pop', { index, oid }),
  /** Past the upstream, or with no upstream on no remote; none without a remote. */
  outgoing: () => invoke<Outgoing>('outgoing'),
  /** A soft reset of HEAD, which must still be `oid` and on no remote. Resolves to the commit's message. */
  undoCommit: (oid: string) => invoke<string>('undo_commit', { oid }),
  listFiles: () => invoke<Listing>('list_files'),
  listDir: (path: string) => invoke<string[]>('list_dir', { path }),
};
