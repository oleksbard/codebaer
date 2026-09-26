import { invoke } from '@tauri-apps/api/core';
import type { CustomCommand, Settings } from './settings';

export type Eol = 'lf' | 'crlf';
export type Rev = 'index' | 'head';

export type FileText = { text: string; eol: Eol; exists: boolean };
export type Blob = { text: string; eol: Eol; oid: string | null; exists: boolean };
export type StageResult = { oid: string | null };
export type Opened = { root: string; label: string; title: string | null };
export type Recent = { path: string; name: string; label: string };
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
  files: FileEntry[];
};
/** The review queue's size in lines: index to working tree, untracked files counted whole. */
export type DiffStat = { added: number; removed: number };
export type Script = { name: string; command: string };
export type Scripts = { runner: string; scripts: Script[] };
export type IconItem = { name: string; command: string };
/** The names to choose from; `ai_command_icons` answers with `<prefix>:<name>`. */
export type IconSet = { prefix: string; title: string; names: string[] };
export type Branch = { kind: 'local'; name: string } | { kind: 'remote'; remote: string; branch: string };

export type AppError =
  | { kind: 'Git' | 'Io' | 'InvalidPath' | 'Ai'; detail: string }
  | { kind: 'Stale'; detail: FileText }
  | { kind: 'Timeout' | 'Cancelled' | 'NotARepo' | 'StaleIndex' | 'NotUtf8' | 'Binary' | 'TooLarge'
    | 'Special' | 'Conflicted' };

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
  gitVersion: () => invoke<string>('git_version'),
  initialRepo: () => invoke<string | null>('initial_repo'),
  recentRepos: () => invoke<Recent[]>('recent_repos'),
  openRepo: (path: string) => invoke<Opened>('open_repo', { path }),
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
  settings: () => invoke<Settings>('settings_get'),
  saveSettings: (settings: Settings) => invoke<void>('settings_set', { settings }),
  commands: () => invoke<CustomCommand[]>('commands_get'),
  saveCommands: (commands: CustomCommand[]) => invoke<void>('commands_set', { commands }),
  packageScripts: () => invoke<Scripts | null>('package_scripts'),
  commandIcons: () => invoke<Record<string, string>>('command_icons_get'),
  saveCommandIcons: (picks: Record<string, string>) => invoke<void>('command_icons_set', { picks }),
  /** One id per item, in order; null where the AI named no icon from the sets. */
  aiCommandIcons: (items: IconItem[], sets: IconSet[]) =>
    invoke<(string | null)[]>('ai_command_icons', { items, sets }),
  branches: () => invoke<Branch[]>('branches'),
  switchBranch: (branch: Branch) => invoke<void>('switch_branch', { branch }),
  createBranch: (name: string) => invoke<void>('create_branch', { name }),
  push: () => invoke<void>('push'),
  pull: () => invoke<void>('pull'),
  fetch: () => invoke<void>('fetch'),
  cancel: () => invoke<void>('cancel'),
  stashPush: () => invoke<void>('stash_push'),
  stashPop: () => invoke<void>('stash_pop'),
  listFiles: () => invoke<Listing>('list_files'),
  listDir: (path: string) => invoke<string[]>('list_dir', { path }),
};
