import type { Channel } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import type { AppError, Blob, BlameLine, Branch, DiffStat, Eol, FileText, IconItem, IconSet, Listing, Opened, Recent,
  Rev, Scripts, StageResult, Status } from '#ipc/git';
import { DEFAULTS, type CustomCommand, type HiddenScripts, type Settings } from '#ipc/settings';
import type { Menu, Orphans, ServerMsg, SpawnKind, Task } from '#ipc/terminal';
import { isTheme } from '#ui/theme';
import { createPty } from './pty';
import { createRepo, type Snapshot } from './repo';
import type { Scenario } from './scenarios';

export type Call = { cmd: string; args: Record<string, unknown> };
export type MenuItem = 'open-folder' | 'open-recent' | 'orphans' | 'settings';

/** `window.__mock`, for Playwright and for poking at the page from devtools. */
export type MockApi = {
  scenario: string;
  /** Every command the page invoked, in order. */
  calls: Call[];
  /** Rewrites a file on disk the way an agent would, then fires the watcher unless `watcher` is false.
   *  null deletes it. */
  agentEdit(path: string, text: string | null, opts?: { watcher?: boolean }): void;
  emit(event: string, payload?: unknown): Promise<void>;
  /** What picking the item in the macOS menu bar sends. */
  menu(item: MenuItem, path?: string): Promise<void>;
  /** The next call to `cmd` rejects with `error`. */
  fail(cmd: string, error: AppError): void;
  state(): Snapshot;
  /** Everything a terminal session printed; the newest session for no id. */
  terminalText(id?: number): string;
  /** Resolves once no command or backend timer has been pending for a moment. */
  idle(): Promise<void>;
};

declare global {
  var __mock: MockApi | undefined;
}

export type Options = {
  /** How long push, pull, fetch and the AI answers take, so their busy state can be seen. */
  slow: number;
  /** Added to every command. */
  latency: number;
  theme: string | null;
  onIdle?: (idle: boolean) => void;
};

const QUIET_MS = 50;
const WATCHER_MS = 60;
const MENU_EVENTS: Record<MenuItem, string> = {
  'open-folder': 'menu-open-folder', 'open-recent': 'menu-open-recent',
  orphans: 'menu-orphans', settings: 'menu-settings',
};

/** Browser mode's stand-in for the AI's icon pick: a word of the command that names an icon. */
const ICON_WORDS: Record<string, string> = {
  build: 'lucide:hammer', dev: 'lucide:play', lint: 'lucide:brush-cleaning', test: 'lucide:flask-conical',
  vitest: 'lucide:flask-conical', format: 'lucide:wand-sparkles', tsc: 'lucide:file-check',
  chrome: 'simple-icons:googlechrome',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const basename = (p: string): string => p.split('/').at(-1) ?? p;
/** `recents::label`, with the home folder read off the path since a browser has no $HOME. */
const label = (p: string): string => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');

export function createBackend(name: string, sc: Scenario, opts: Options) {
  const repo = createRepo(sc.repo);
  let settings: Settings = {
    ...DEFAULTS,
    'general.headless-ai-provider': sc.ai,
    ...(isTheme(opts.theme) ? { 'appearance.theme': opts.theme } : {}),
  };
  let commands: CustomCommand[] = [...sc.commands];
  let hiddenScripts: HiddenScripts = {};
  let icons: Record<string, string> = {};
  const calls: Call[] = [];
  const failures = new Map<string, AppError>();

  let pending = 0;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let idle = false;
  const onSettle: (() => void)[] = [];
  const begin = (): void => {
    pending++;
    clearTimeout(quiet);
    if (idle) { idle = false; opts.onIdle?.(false); }
  };
  const end = (): void => {
    if (--pending) return;
    quiet = setTimeout(() => {
      if (pending) return;
      if (!idle) { idle = true; opts.onIdle?.(true); }
      for (const f of onSettle.splice(0)) f();
    }, QUIET_MS);
  };
  const later = (ms: number, fn: () => void): (() => void) => {
    begin();
    let done = false;
    const settle = (): void => { if (!done) { done = true; end(); } };
    const t = setTimeout(() => { try { fn(); } finally { settle(); } }, ms);
    return () => { clearTimeout(t); settle(); };
  };

  let watcher: ReturnType<typeof setTimeout> | undefined;
  /** The debounced `repo-changed` that watcher.rs sends after anything touches the worktree or .git. */
  const changed = (): void => {
    if (watcher === undefined) begin();
    clearTimeout(watcher);
    watcher = setTimeout(() => {
      watcher = undefined;
      void emit('repo-changed').finally(end);
    }, WATCHER_MS);
  };
  const mutate = <T>(fn: () => T): T => {
    const out = fn();
    changed();
    return out;
  };

  let cancelNet: (() => void) | null = null;
  const net = (fn: () => void): Promise<void> => new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cancelNet = null;
      try { mutate(fn); resolve(); } catch (e) { reject(e); }
    }, opts.slow);
    cancelNet = () => {
      clearTimeout(t);
      cancelNet = null;
      reject({ kind: 'Cancelled' } satisfies AppError);
    };
  });

  type Package = { name?: string; packageManager?: string; scripts?: Record<string, string> };
  const readPackage = (): Package | null => {
    const f = repo.readFile('package.json');
    if (!f.exists) return null;
    try {
      return JSON.parse(f.text) as Package;
    } catch (e) {
      throw { kind: 'Io', detail: `package.json: ${String(e)}` } satisfies AppError;
    }
  };

  /** `tasks::scripts_at`, read from package.json as it is on disk now. */
  const scripts = (): Scripts | null => {
    const pkg = readPackage();
    if (!pkg) return null;
    const list = Object.entries(pkg.scripts ?? {}).map(([n, command]) => ({ name: n, command }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const runner = ['pnpm', 'yarn', 'bun', 'npm'].find((r) => pkg.packageManager?.split('@')[0] === r) ?? 'npm';
    return list.length ? { runner, scripts: list } : null;
  };

  /** `repo_title`: the README's first heading, else the package name. */
  const title = (): string | null => {
    const heading = repo.readFile('README.md').text.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim();
    if (heading) return heading;
    try {
      return readPackage()?.name?.trim() || null;
    } catch {
      return null;
    }
  };

  const pty = createPty({
    root: sc.root, menu: sc.menu, sessions: sc.sessions, orphans: sc.orphans,
    status: () => repo.status(), scripts, commands: () => commands, later,
  });

  /** One entry per command in `generate_handler![]` in lib.rs, plus the plugin calls the page makes. */
  const handlers: Record<string, (args: never) => unknown> = {
    git_version: (): string => {
      if (sc.gitMissing) throw { kind: 'Io', detail: 'git: No such file or directory (os error 2)' } satisfies AppError;
      return 'git version 2.50.1';
    },
    initial_repo: (): string | null => sc.initial,
    log_error: ({ message }: { message: string }) => console.error(`[backend] ${message}`),
    log_info: ({ message }: { message: string }) => console.info(`[backend] ${message}`),
    recent_repos: (): Recent[] => sc.recents.map((path) => ({ path, name: basename(path), label: label(path) })),
    open_repo: ({ path }: { path: string }): Opened => {
      if (path.replace(/\/+$/, '') !== sc.root) throw { kind: 'NotARepo' } satisfies AppError;
      return { root: sc.root, label: label(sc.root), title: title() };
    },
    status: (): Status => repo.status(),
    diff_stat: (): DiffStat => repo.diffStat(),
    read_file: ({ path }: { path: string }): FileText => repo.readFile(path),
    write_file: ({ path, text, eol, expected }: { path: string; text: string; eol: Eol; expected: string | null }) =>
      mutate(() => repo.writeFile(path, text, eol, expected)),
    read_blob: ({ rev, path }: { rev: Rev; path: string }): Blob => repo.readBlob(rev, path),
    blame: ({ path, line, contents }: { path: string; line: number; contents: string }): BlameLine =>
      repo.blame(path, line, contents),
    stage_content: (a: { path: string; text: string | null; eol: Eol; expectedOid: string | null }): StageResult =>
      mutate(() => repo.stageContent(a.path, a.text, a.eol, a.expectedOid)),
    stage_path: ({ path }: { path: string }) => mutate(() => repo.stagePath(path)),
    unstage_path: ({ path }: { path: string }) => mutate(() => repo.unstagePath(path)),
    revert_path: ({ path }: { path: string }) => mutate(() => repo.revertPath(path)),
    stage_all: () => mutate(() => repo.stageAll()),
    unstage_all: () => mutate(() => repo.unstageAll()),
    discard_preview: (): string[] => repo.discardPreview(),
    discard_all: () => mutate(() => repo.discardAll()),
    commit: ({ message }: { message: string }) => mutate(() => repo.commit(message)),
    branches: (): Branch[] => repo.branches(),
    switch_branch: ({ branch }: { branch: Branch }) => mutate(() => repo.switchBranch(branch)),
    create_branch: ({ name: n }: { name: string }) => mutate(() => repo.createBranch(n)),
    stash_push: () => mutate(() => repo.stashPush()),
    stash_pop: () => mutate(() => repo.stashPop()),
    list_files: (): Listing => repo.listFiles(),
    list_dir: ({ path }: { path: string }): string[] => repo.listDir(path),
    push: () => net(() => repo.push()),
    pull: () => net(() => repo.pull()),
    fetch: () => net(() => {}),
    cancel: () => cancelNet?.(),
    ai_commit_message: async (): Promise<string> => {
      if (settings['general.headless-ai-provider'] === 'off') {
        throw { kind: 'Ai', detail: 'AI commit messages are off. Turn them on in Settings.' } satisfies AppError;
      }
      const staged = repo.stagedPaths();
      if (!staged.length) throw { kind: 'Ai', detail: 'Nothing is staged' } satisfies AppError;
      await sleep(opts.slow);
      const what = staged.length === 1 ? basename(staged[0]!) : `${basename(staged[0]!)} and ${staged.length - 1} more`;
      return `Update ${what}\n\nWritten by browser mode from the staged paths, not by an AI.`;
    },
    settings_get: (): Settings => ({ ...settings }),
    settings_set: ({ settings: s }: { settings: Settings }) => { settings = { ...s }; },
    commands_get: (): CustomCommand[] => [...commands],
    commands_set: ({ commands: c }: { commands: CustomCommand[] }) => { commands = [...c]; },
    hidden_scripts_get: (): HiddenScripts => structuredClone(hiddenScripts),
    hidden_scripts_set: ({ hidden }: { hidden: HiddenScripts }) => { hiddenScripts = structuredClone(hidden); },
    command_icons_get: (): Record<string, string> => ({ ...icons }),
    command_icons_set: ({ picks }: { picks: Record<string, string> }) => { icons = { ...icons, ...picks }; },
    ai_command_icons: async ({ items, sets }: { items: IconItem[]; sets: IconSet[] }): Promise<(string | null)[]> => {
      if (settings['general.headless-ai-provider'] === 'off') {
        throw { kind: 'Ai', detail: 'AI command icons are off. Turn them on in Settings.' } satisfies AppError;
      }
      await sleep(opts.slow);
      const known = new Set(sets.flatMap((s) => s.names.map((n) => `${s.prefix}:${n}`)));
      return items.map((it) => `${it.name} ${it.command}`.toLowerCase().split(/[^a-z0-9]+/)
        .map((w) => ICON_WORDS[w]).find((id) => id !== undefined && known.has(id)) ?? null);
    },
    package_scripts: (): Scripts | null => scripts(),
    task_run: ({ task }: { task: Task }): number => pty.runTask(task),
    term_menu: (): Menu => sc.menu,
    term_subscribe: ({ out, ev }: { out: Channel<ArrayBuffer | number[]>; ev: Channel<ServerMsg> }) =>
      pty.subscribe(out, ev),
    term_spawn: ({ kind }: { kind: SpawnKind }): number => pty.spawn(kind),
    term_input: ({ id, data }: { id: number; data: string }) => pty.input(id, data),
    term_input_bytes: () => {},
    term_resize: () => {},
    term_kill: ({ id }: { id: number }) => pty.kill(id),
    term_close: ({ id }: { id: number }) => pty.close(id),
    term_promote: ({ id }: { id: number }) => pty.promote(id),
    term_check_cwd: () => {},
    term_relist: ({ id }: { id: number | null }) => pty.relist(id),
    term_orphans: (): Orphans => pty.orphans(),
    term_restore: ({ pid }: { pid: number }) => pty.restore(pid),
    term_kill_orphan: ({ pid }: { pid: number }) => pty.killOrphan(pid),
    'plugin:dialog|open': (): string | null => sc.pick,
  };

  async function invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    calls.push({ cmd, args });
    begin();
    try {
      if (opts.latency) await sleep(opts.latency);
      const injected = failures.get(cmd);
      if (injected) {
        failures.delete(cmd);
        throw injected;
      }
      const h = handlers[cmd];
      if (!h) {
        console.error(`[mock] no handler for ${cmd}`);
        throw { kind: 'Io', detail: `browser mode has no ${cmd}` } satisfies AppError;
      }
      // Tauri resolves a unit command with null
      return (await (h as (a: unknown) => unknown)(args)) ?? null;
    } finally {
      end();
    }
  }

  const api: MockApi = {
    scenario: name,
    calls,
    agentEdit: (path, text, opts) => {
      repo.agentWrite(path, text);
      if (opts?.watcher !== false) changed();
    },
    emit: (event, payload) => emit(event, payload),
    menu: (item, path) => emit(MENU_EVENTS[item], path),
    fail: (cmd, error) => { failures.set(cmd, error); },
    state: () => repo.snapshot(),
    terminalText: (id) => pty.text(id),
    idle: () => new Promise((resolve) => {
      const check = (): void => { if (pending) onSettle.push(check); else resolve(); };
      setTimeout(check, QUIET_MS);
    }),
  };

  return { invoke, api, commands: Object.keys(handlers) };
}
