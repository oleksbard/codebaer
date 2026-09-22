import type { Info } from './terminal';

const HOME = '/Users/';

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
export function statusLabel(s: Info, now: number, home: string | null = null): string {
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

export const isExited = (s: Info): boolean => s.state.t === 'Exited';

/** Home directory as the shells report it, so a label can shorten a path without asking Rust. */
export function homeFrom(cwd: string): string | null {
  if (!cwd.startsWith(HOME)) return null;
  const rest = cwd.slice(HOME.length);
  const user = rest.split('/')[0];
  return user ? `${HOME}${user}` : null;
}

const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];

/** Which agent a session is, for the icon on its sidebar button. A `Command` session carries the
 *  program as its title; a shell only reveals one while it runs it, and only on the marks tier. */
export function agentOf(s: Info): Agent | null {
  const running = s.state.t === 'Running' ? s.state.command : null;
  const name = (running ?? s.title).split(' ')[0]?.split('/').pop()?.toLowerCase() ?? '';
  return AGENTS.find((a) => a === name) ?? null;
}
