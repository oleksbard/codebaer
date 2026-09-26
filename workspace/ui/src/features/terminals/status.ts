import type { Info } from '#ipc/terminal';
import { baseName, HOME_ROOT, within } from '#kernel/paths';
import type { DeepReadonly } from '#kernel/store';

/** `~/projects/x` beats a 60 character absolute path in a row that is 200px wide. */
export function shortCwd(cwd: string, home: string | null): string {
  if (home && cwd === home) return '~';
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** What a session is doing, in the words its tier can actually back up. A `process` tier
 *  session has no marks to read, so it never claims to know a command or how long it ran. */
export function statusLabel(s: DeepReadonly<Info>, now: number, home: string | null = null): string {
  switch (s.state.t) {
    case 'Starting':
      return 'starting';
    case 'Idle':
      return shortCwd(s.cwd, home);
    case 'Running':
      return s.state.command
        ? `${s.state.command} ${elapsed(now - s.state.since_ms)}`
        : `running ${elapsed(now - s.state.since_ms)}`;
    case 'Exited':
      return s.state.code === null ? 'exited' : `exited ${s.state.code}`;
  }
}

export const isExited = (s: DeepReadonly<Info>): boolean => s.state.t === 'Exited';

/** Edits made from outside the open repo never reach its review queue. `root` and `cwd` are
 *  both real paths, so a plain prefix check cannot be fooled by a symlink. */
export function outsideRepo(s: DeepReadonly<Info>, root: string | null): boolean {
  if (!root || isExited(s)) return false;
  return !within(s.cwd, root);
}

export function awayLabel(s: DeepReadonly<Info>, root: string | null, home: string | null): string | null {
  if (!outsideRepo(s, root)) return null;
  return s.state.t === 'Idle' ? 'outside the repo' : `outside the repo, in ${shortCwd(s.cwd, home)}`;
}

/** Home directory as the shells report it, so a label can shorten a path without asking Rust. */
export function homeFrom(cwd: string): string | null {
  if (!cwd.startsWith(HOME_ROOT)) return null;
  const rest = cwd.slice(HOME_ROOT.length);
  const user = rest.split('/')[0];
  return user ? `${HOME_ROOT}${user}` : null;
}

const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];

/** Which agent a session is, for the icon on its sidebar button. A `Command` session carries the
 *  program as its title; a shell only reveals one while it runs it, and only on the marks tier. */
export function agentOf(s: DeepReadonly<Info>): Agent | null {
  const running = s.state.t === 'Running' ? s.state.command : null;
  const name = baseName((running ?? s.title).split(' ')[0] ?? '').toLowerCase();
  return AGENTS.find((a) => a === name) ?? null;
}

export const kindOf = (s: DeepReadonly<Info>): string => agentOf(s) ?? (baseName(s.title) || 'terminal');

/** Numbered per kind in rail order over every session, so `claude:2` is the second claude
 *  button counted from the top whether or not the ones above it can take comments. */
export function termLabels(sessions: readonly DeepReadonly<Info>[]): Map<number, string> {
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const s of sessions) {
    const k = kindOf(s);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    out.set(s.id, `${k}:${n}`);
  }
  return out;
}

export const isTask = (s: DeepReadonly<Info>): boolean => s.task === true;

/** What the terminal rail lists: a task stays out of it until it is moved there. */
export const terminalsOf = <T extends DeepReadonly<Info>>(sessions: readonly T[]): T[] =>
  sessions.filter((s) => !isTask(s));
