import type { AgentCall, AgentState, Info } from '#ipc/terminal';
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** A tool call in the words of what it does. The wording follows tzafrir/whats-agent-doing (MIT). */
export function activity(c: DeepReadonly<AgentCall>): string {
  const d = c.detail;
  const file = baseName(d) || d;
  switch (c.tool) {
    case 'Bash': case 'PowerShell': return d || 'Running a command';
    case 'Read': return `Reading ${file}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Editing ${file}`;
    case 'Write': return `Writing ${file}`;
    case 'Grep': return `Searching for "${d}"`;
    case 'Glob': return `Finding files ${d}`;
    case 'WebFetch': return `Fetching ${hostOf(d)}`;
    case 'WebSearch': return `Searching the web for "${d}"`;
    case 'Agent': case 'Task': return d ? `Running an agent: ${d}` : 'Running an agent';
    case 'TodoWrite': return 'Updating the todo list';
    case 'AskUserQuestion': return 'Asking you a question';
    case 'Skill': return `Using the ${d} skill`;
  }
  if (c.tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = c.tool.split('__');
    return `Using ${server}: ${name}`;
  }
  return `Using ${c.tool}`;
}

export type AgentTone = 'run' | 'wait' | 'idle';

/** What the agent does now. `since` starts the timer the label shows, and is null when nothing runs.
 *  `about` names the call an approval waits on; `turn` sums up the turn while it runs. */
export type AgentStatus = {
  tone: AgentTone; text: string; since: number | null; about: string | null; turn: string | null;
};

export function agentStatus(a: DeepReadonly<AgentState>, now: number): AgentStatus {
  const turn = a.turn_ms === null ? null : `Turn ${elapsed(now - a.turn_ms)} · ${plural(a.actions, 'action')}`;
  const busy = (text: string, since: number): AgentStatus => ({ tone: 'run', text, since, about: null, turn });
  switch (a.phase) {
    case 'working': {
      const open = a.calls.at(-1);
      const more = a.calls.length > 1 ? ` (+${a.calls.length - 1} more)` : '';
      if (open) return busy(activity(open) + more, open.since_ms);
      return busy(a.actions === 0 ? 'Reading your prompt' : 'Thinking', a.since_ms);
    }
    case 'compacting': return busy('Compacting the conversation', a.since_ms);
    case 'approval':
      return {
        tone: 'wait', text: 'Waiting for your approval', since: a.since_ms, about: a.ask && activity(a.ask), turn,
      };
    case 'question': return { tone: 'wait', text: 'Waiting for your answer', since: a.since_ms, about: null, turn };
    case 'idle': {
      const took = elapsed(a.took_ms ?? 0);
      const text = a.end === 'done' ? `Done in ${took} · ${plural(a.actions, 'action')}`
        : a.end === 'interrupted' ? `Interrupted after ${took}`
          : a.end === 'failed' ? `Stopped on an API error after ${took}`
            : 'Ready for a prompt';
      return { tone: 'idle', text, since: null, about: null, turn: null };
    }
  }
}

/** The agent wants you: it asks for something, or a turn it ran on its own just ended. Not after an
 *  interrupt, which is something you did. */
type MaybeAgent = DeepReadonly<AgentState> | null | undefined;

export function wantsYou(before: MaybeAgent, after: DeepReadonly<AgentState>): boolean {
  const asks = (a: MaybeAgent) => a?.phase === 'approval' || a?.phase === 'question';
  if (asks(after) && !asks(before)) return true;
  return !!before && before.phase !== 'idle' && after.phase === 'idle' && after.end !== 'interrupted';
}

/** The hook state when the session has one and is still running, else null: an output tell is all that is left. */
export const agentState = (s: DeepReadonly<Info>): DeepReadonly<AgentState> | null =>
  s.state.t === 'Exited' ? null : s.agent ?? null;

/** What a session is doing, in the words its tier can actually back up. A `process` tier
 *  session has no marks to read, so it never claims to know a command or how long it ran. */
export function statusLabel(s: DeepReadonly<Info>, now: number, home: string | null = null): string {
  const a = agentState(s);
  if (a) {
    const st = agentStatus(a, now);
    return st.since === null ? st.text : `${st.text} ${elapsed(now - st.since)}`;
  }
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

/** Where a session works, split so the badge can stress the place: `lead` comes before `name`, `tail` after. */
export type Place<R> = { repo: R | null; lead: string; name: string; tail: string };

/** The deepest known repo holding `cwd`, so a checkout nested in another names itself; else the folder. */
export function placeOf<R extends { path: string; name: string }>(
  cwd: string, home: string | null, repos: readonly R[],
): Place<R> {
  let repo: R | null = null;
  for (const r of repos) if (within(cwd, r.path) && r.path.length > (repo?.path.length ?? -1)) repo = r;
  if (repo) return { repo, lead: '', name: repo.name, tail: cwd.slice(repo.path.length) };
  const name = baseName(cwd);
  if (cwd === home || !name) return { repo: null, lead: '', name: cwd === home ? '~' : '/', tail: '' };
  return { repo: null, lead: `${shortCwd(cwd.slice(0, -name.length - 1), home)}/`, name, tail: '' };
}

/** Home directory as the shells report it, so a label can shorten a path without asking Rust. */
export function homeFrom(cwd: string): string | null {
  if (!cwd.startsWith(HOME_ROOT)) return null;
  const rest = cwd.slice(HOME_ROOT.length);
  const user = rest.split('/')[0];
  return user ? `${HOME_ROOT}${user}` : null;
}

const AGENTS = ['claude', 'codex', 'opencode'] as const;
export type Agent = (typeof AGENTS)[number];

export const agentNamed = (name: string): Agent | null => AGENTS.find((a) => a === name) ?? null;

/** Which agent a session is, for the icon on its sidebar button. A `Command` session carries the
 *  program as its title; a shell only reveals one while it runs it, and only on the marks tier. */
export function agentOf(s: DeepReadonly<Info>): Agent | null {
  const running = s.state.t === 'Running' ? s.state.command : null;
  return agentNamed(baseName((running ?? s.title).split(' ')[0] ?? '').toLowerCase());
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
