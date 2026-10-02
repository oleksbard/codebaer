import type { Channel } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import type { AppError, Blob, BlameLine, Branch, DiffStat, Eol, FileText, IconItem, IconSet, Listing, Opened, Outgoing,
  Recent, RepoItem, Rev, Scripts, SearchMsg, StageResult, Stash, StashKind, Status, Update } from '#ipc/git';
import {
  AI_PROVIDERS, DEFAULTS, type AiProvider, type CustomCommand, type HiddenScripts, type Settings,
} from '#ipc/settings';
import type { Menu, Orphans, ServerMsg, SpawnKind, Task } from '#ipc/terminal';
import { isTheme } from '#ui/theme';
import { createPty } from './pty';
import { createRepo, type Snapshot } from './repo';
import type { Scenario } from './scenarios';

export type Call = { cmd: string; args: Record<string, unknown> };
export type MenuItem = 'open-folder' | 'open-recent' | 'orphans' | 'settings' | 'ai-tools' | 'check-updates';

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
  /** Cmd-Q or the window's close button: the page is asked while it reported unsaved changes, else the app ends. */
  quit(): Promise<void>;
  exited(): boolean;
  /** The next call to `cmd` rejects with `error`. */
  fail(cmd: string, error: AppError): void;
  /** Calls to `cmd` wait, without an answer, until `release(cmd)`. A test that needs a command still running
   *  holds it, instead of racing `&slow` on a slow runner. `idle()` waits for a held call too. */
  hold(cmd: string): void;
  release(cmd: string): void;
  state(): Snapshot;
  /** Someone else pushes `n` commits to `upstream`; the next fetch or pull brings them in. */
  remotePush(upstream: string, n: number): void;
  /** Everything a terminal session printed; the newest session for no id. */
  terminalText(id?: number): string;
  /** Prints into a terminal session as its program would, for an agent's reply; the newest session for no id. */
  terminalWrite(text: string, id?: number): void;
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
  orphans: 'menu-orphans', settings: 'menu-settings', 'ai-tools': 'menu-ai-tools',
  'check-updates': 'menu-check-updates',
};

/** Browser mode's stand-in for the AI's icon pick: a word of the command or the repo name that names an icon. */
const ICON_WORDS: Record<string, string> = {
  build: 'lucide:hammer', dev: 'lucide:play', lint: 'lucide:brush-cleaning', test: 'lucide:flask-conical',
  vitest: 'lucide:flask-conical', format: 'lucide:wand-sparkles', tsc: 'lucide:file-check',
  chrome: 'simple-icons:googlechrome',
};
const REPO_WORDS: Record<string, string> = { shop: 'lucide:shopping-cart', router: 'lucide:route' };
const AI_ICONS_OFF: AppError = { kind: 'Ai', detail: 'AI icons are off. Turn them on in Settings.' };
/** What `AppState::root` fails for after `close_repo`, until the next `open_repo`, and in a folder with no repo. */
const NEEDS_REPO = new Set([
  'status', 'diff_stat', 'read_file', 'write_file', 'read_blob', 'read_image', 'image_stamp', 'blame', 'stage_content',
  'stage_path', 'unstage_path', 'revert_path', 'stage_all', 'unstage_all', 'discard_preview', 'discard_all', 'commit',
  'branches', 'switch_branch', 'create_branch', 'stash_push', 'stash_list', 'stash_pop', 'outgoing', 'undo_commit',
  'list_files', 'list_dir', 'push', 'pull', 'fetch', 'fetch_background', 'ai_commit_message', 'ai_stash_description',
]);
/** What `AppState::cwd` fails for: only after `close_repo`. */
const NEEDS_FOLDER = new Set(['package_scripts', 'task_run']);

function wordIcon(words: Record<string, string>, text: string, sets: IconSet[]): string | null {
  const known = new Set(sets.flatMap((s) => s.names.map((n) => `${s.prefix}:${n}`)));
  return text.toLowerCase().split(/[^a-z0-9]+/).map((w) => words[w]).find((id) => id !== undefined && known.has(id))
    ?? null;
}

/** Files per message, so a search over the big scenario streams as the real one does. */
const SEARCH_BATCH = 200;
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
  const favorites = new Set(sc.favorites);
  let closed = false;
  let searches = 0;
  /** `find` answers Folder for the scenario's root: until `git_init`, or for good with no git. */
  let plain = sc.plain || sc.gitMissing;
  const calls: Call[] = [];
  const failures = new Map<string, AppError>();
  const holds = new Map<string, { gate: Promise<void>; open(): void }>();
  let unsaved = false;
  let exited = false;

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

  /** `recent_repos`: the open repo included, favorites first, each group in the recents' order. */
  const recents = (): Recent[] => [...sc.recents]
    .sort((a, b) => Number(favorites.has(b)) - Number(favorites.has(a)))
    // `Recent::new` names a repo as `open_repo` titles it; only the scenario's own repo has files to read
    .map((path) => ({
      path,
      name: (path === sc.root ? title() : null) ?? basename(path),
      label: label(path),
      favorite: favorites.has(path),
    }));

  const pty = createPty({
    root: sc.root, menu: sc.menu, sessions: sc.sessions, orphans: sc.orphans,
    status: () => repo.status(), scripts, commands: () => commands, later,
  });

  /** One entry per command in `generate_handler![]` in lib.rs, plus the plugin calls the page makes. */
  const handlers: Record<string, (args: never) => unknown> = {
    app_version: (): string => '0.0.0-mock',
    git_version: (): string => {
      if (sc.gitMissing) throw { kind: 'Io', detail: 'git: No such file or directory (os error 2)' } satisfies AppError;
      return 'git version 2.50.1';
    },
    initial_repo: (): string | null => sc.initial,
    set_unsaved: ({ unsaved: on }: { unsaved: boolean }) => { unsaved = on; },
    quit: () => { exited = true; },
    update_enabled: (): boolean => sc.updates !== null,
    update_check: async (): Promise<Update | null> => {
      await sleep(opts.slow);
      return sc.updates?.found ?? null;
    },
    update_install: () => { exited = true; },
    log_error: ({ message }: { message: string }) => console.error(`[backend] ${message}`),
    log_info: ({ message }: { message: string }) => console.info(`[backend] ${message}`),
    recent_repos: (): Recent[] => recents(),
    favorite_repo: ({ path, favorite }: { path: string; favorite: boolean }): Recent[] => {
      if (favorite && sc.recents.includes(path)) favorites.add(path);
      else favorites.delete(path);
      return recents();
    },
    open_repo: ({ path }: { path: string }): Opened => {
      if (path.replace(/\/+$/, '') !== sc.root) throw { kind: 'NotARepo' } satisfies AppError;
      closed = false;
      return { root: sc.root, label: label(sc.root), title: title(), git: !plain };
    },
    git_init: ({ root }: { root: string }) => {
      if (sc.gitMissing) throw { kind: 'Io', detail: 'git: No such file or directory (os error 2)' } satisfies AppError;
      if (closed || !plain) throw { kind: 'NotARepo' } satisfies AppError;
      if (root !== sc.root) {
        throw { kind: 'Git', detail: 'Another folder was opened, so no repository was made.' } satisfies AppError;
      }
      plain = false;
    },
    close_repo: () => { closed = true; },
    status: (): Status => repo.status(),
    diff_stat: (): DiffStat => repo.diffStat(),
    read_file: ({ path }: { path: string }): FileText => repo.readFile(path),
    write_file: ({ path, text, eol, expected }: { path: string; text: string; eol: Eol; expected: string | null }) =>
      mutate(() => repo.writeFile(path, text, eol, expected)),
    read_blob: ({ rev, path }: { rev: Rev; path: string }): Blob => repo.readBlob(rev, path),
    read_image: ({ rev, path }: { rev: Rev | null; path: string }): ArrayBuffer => repo.readImage(rev, path),
    image_stamp: ({ rev, path }: { rev: Rev | null; path: string }): string | null => repo.imageStamp(rev, path),
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
    stash_push: ({ root, kind, message }: { root: string; kind: StashKind; message: string | null }): boolean => {
      if (root !== sc.root) {
        throw { kind: 'Git', detail: 'Another repository was opened, so nothing was stashed.' } satisfies AppError;
      }
      return mutate(() => repo.stashPush(kind, message));
    },
    stash_list: (): Stash[] => repo.stashList(),
    stash_pop: ({ index, oid }: { index: number; oid: string }) => mutate(() => repo.stashPop(index, oid)),
    outgoing: (): Outgoing => repo.outgoing(),
    undo_commit: ({ oid }: { oid: string }): string => {
      const detail = 'a push or pull is already running';
      if (cancelNet) throw { kind: 'Git', detail } satisfies AppError;
      return mutate(() => repo.undoCommit(oid));
    },
    list_files: (): Listing => repo.listFiles(),
    list_dir: ({ path }: { path: string }): string[] => repo.listDir(path),
    // as search.rs: a new search stops the one before, and an empty query only does that, even with no repo open
    search: async ({ query, include, run, out }: {
      query: string; include: string; run: number; out: Channel<SearchMsg>;
    }) => {
      const gen = run;
      if (run <= searches) return;
      searches = run;
      if (!query) return;
      if (closed || plain) throw { kind: 'NotARepo' } satisfies AppError;
      const { files, truncated } = repo.search(query, include);
      for (let i = 0; i < files.length; i += SEARCH_BATCH) {
        if (gen !== searches) return;
        out.onmessage({ t: 'Files', files: files.slice(i, i + SEARCH_BATCH) });
        await sleep(0);
      }
      if (gen === searches) out.onmessage({ t: 'Done', truncated });
    },
    push: () => net(() => repo.push()),
    pull: () => net(() => repo.pull()),
    fetch: () => net(() => repo.fetch()),
    // no FETCH_HEAD, so like the real one it fires the watcher only when a remote-tracking ref moves
    fetch_background: async () => {
      if (settings['general.auto-fetch'] === 'off' || cancelNet) return;
      await sleep(opts.slow);
      if (repo.fetch()) changed();
    },
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
    ai_stash_description: async ({ kind }: { kind: StashKind }): Promise<string | null> => {
      if (settings['general.headless-ai-provider'] === 'off') {
        throw { kind: 'Ai', detail: 'AI stash descriptions are off. Turn them on in Settings.' } satisfies AppError;
      }
      const paths = repo.stashPaths(kind);
      if (!paths.length) return null;
      await sleep(opts.slow);
      const what = paths.length === 1 ? basename(paths[0]!) : `${basename(paths[0]!)} and ${paths.length - 1} more`;
      return `Changes ${what}. Written by browser mode from the stashed paths, not by an AI.`;
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
      if (settings['general.headless-ai-provider'] === 'off') throw AI_ICONS_OFF;
      await sleep(opts.slow);
      return items.map((it) => wordIcon(ICON_WORDS, `${it.name} ${it.command}`, sets));
    },
    ai_repo_icons: async ({ items, sets }: { items: RepoItem[]; sets: IconSet[] }): Promise<(string | null)[]> => {
      if (settings['general.headless-ai-provider'] === 'off') throw AI_ICONS_OFF;
      await sleep(opts.slow);
      return items.map((it) => wordIcon(REPO_WORDS, it.name, sets));
    },
    // the backend finds the CLIs the way it finds the terminal menu's commands
    installed_ai_providers: (): AiProvider[] => AI_PROVIDERS.filter((p) => sc.menu.commands.includes(p)),
    open_url: () => {},
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
      await holds.get(cmd)?.gate;
      const injected = failures.get(cmd);
      if (injected) {
        failures.delete(cmd);
        throw injected;
      }
      if ((closed || plain) && NEEDS_REPO.has(cmd)) throw { kind: 'NotARepo' } satisfies AppError;
      if (closed && NEEDS_FOLDER.has(cmd)) throw { kind: 'NotARepo' } satisfies AppError;
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
    quit: async () => { if (unsaved) await emit('quit-requested'); else exited = true; },
    exited: () => exited,
    fail: (cmd, error) => { failures.set(cmd, error); },
    hold: (cmd) => {
      if (holds.has(cmd)) return;
      let open = (): void => {};
      const gate = new Promise<void>((r) => { open = r; });
      holds.set(cmd, { gate, open });
    },
    release: (cmd) => {
      holds.get(cmd)?.open();
      holds.delete(cmd);
    },
    state: () => repo.snapshot(),
    remotePush: (upstream, n) => repo.remotePush(upstream, n),
    terminalText: (id) => pty.text(id),
    terminalWrite: (text, id) => pty.print(text, id),
    idle: () => new Promise((resolve) => {
      const check = (): void => { if (pending) onSettle.push(check); else resolve(); };
      setTimeout(check, QUIET_MS);
    }),
  };

  return { invoke, api, commands: Object.keys(handlers) };
}
