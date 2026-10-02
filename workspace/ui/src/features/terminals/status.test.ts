import { describe, expect, it } from 'vitest';
import {
  activity, agentOf, agentStatus, awayLabel, elapsed, homeFrom, outsideRepo, placeOf, shortCwd, statusLabel, termLabels,
  terminalsOf, wantsYou,
} from './status';
import type { AgentState, Info } from '#ipc/terminal';

const base: Info = { id: 1, title: 'zsh', cwd: '/Users/me/projects/x', tier: 'marks', state: { t: 'Idle' } };

describe('statusLabel', () => {
  it('shows the directory when a shell is sitting at its prompt', () => {
    expect(statusLabel(base, 0, '/Users/me')).toBe('~/projects/x');
  });

  it('names the command and how long it has been running', () => {
    const s: Info = { ...base, state: { t: 'Running', command: 'pnpm test', since_ms: 1000 } };
    expect(statusLabel(s, 253_000)).toBe('pnpm test 4m12s');
  });

  it('claims no command for a session with no marks to read', () => {
    const s: Info = { ...base, tier: 'process', title: 'claude', state: { t: 'Running', command: null, since_ms: 0 } };
    expect(statusLabel(s, 5000)).toBe('running 5s');
  });

  it('reports a non-zero exit', () => {
    expect(statusLabel({ ...base, state: { t: 'Exited', code: 1 } }, 0)).toBe('exited 1');
  });

  it('does not invent an exit code it was not given', () => {
    expect(statusLabel({ ...base, state: { t: 'Exited', code: null } }, 0)).toBe('exited');
  });
});

describe('elapsed', () => {
  it('counts in the largest unit that stays readable', () => {
    expect(elapsed(0)).toBe('0s');
    expect(elapsed(59_000)).toBe('59s');
    expect(elapsed(60_000)).toBe('1m00s');
    expect(elapsed(3_600_000)).toBe('1h00m');
    expect(elapsed(-5)).toBe('0s');
  });
});

describe('shortCwd', () => {
  it('shortens only inside the home directory', () => {
    expect(shortCwd('/Users/me/x', '/Users/me')).toBe('~/x');
    expect(shortCwd('/Users/me', '/Users/me')).toBe('~');
    expect(shortCwd('/tmp/x', '/Users/me')).toBe('/tmp/x');
    // a sibling user whose name merely starts the same way is not inside our home
    expect(shortCwd('/Users/meredith/x', '/Users/me')).toBe('/Users/meredith/x');
    expect(shortCwd('/tmp/x', null)).toBe('/tmp/x');
  });
});

describe('homeFrom', () => {
  it('derives the home directory from any path under it', () => {
    expect(homeFrom('/Users/me/projects/x')).toBe('/Users/me');
    expect(homeFrom('/Users/me')).toBe('/Users/me');
    expect(homeFrom('/tmp/x')).toBe(null);
  });
});

describe('agentOf', () => {
  it('names the agent a command session was spawned as', () => {
    expect(agentOf({ ...base, title: 'claude', tier: 'process' })).toBe('claude');
    expect(agentOf({ ...base, title: 'codex', tier: 'process' })).toBe('codex');
    expect(agentOf({ ...base, title: 'opencode', tier: 'process' })).toBe('opencode');
  });

  it('names the agent a shell is running right now', () => {
    expect(agentOf({ ...base, state: { t: 'Running', command: 'claude --resume', since_ms: 0 } })).toBe('claude');
  });

  it('has nothing to show for a plain shell or an unrelated command', () => {
    expect(agentOf(base)).toBe(null);
    expect(agentOf({ ...base, state: { t: 'Running', command: 'pnpm test', since_ms: 0 } })).toBe(null);
  });
});

describe('outsideRepo', () => {
  const at = (cwd: string, extra: Partial<Info> = {}): Info => ({ ...base, cwd, ...extra });
  const root = '/Users/me/projects/x';

  it('counts the root and every folder under it as inside', () => {
    expect(outsideRepo(at('/Users/me/projects/x'), root)).toBe(false);
    expect(outsideRepo(at('/Users/me/projects/x/src/app'), root)).toBe(false);
  });

  it('flags a folder anywhere else', () => {
    expect(outsideRepo(at('/Users/me/projects'), root)).toBe(true);
    expect(outsideRepo(at('/tmp'), root)).toBe(true);
    // a sibling whose name merely starts the same way is a different repo
    expect(outsideRepo(at('/Users/me/projects/x-old'), root)).toBe(true);
  });

  it('flags nothing while no repo is open', () => {
    expect(outsideRepo(at('/tmp'), null)).toBe(false);
  });

  it('leaves an exited session alone, since it can no longer edit anything', () => {
    expect(outsideRepo(at('/tmp', { state: { t: 'Exited', code: 0 } }), root)).toBe(false);
  });
});

describe('awayLabel', () => {
  const root = '/Users/me/projects/x';

  it('says nothing for a session inside the repo', () => {
    expect(awayLabel(base, root, '/Users/me')).toBe(null);
  });

  it('does not repeat the folder an idle label already shows', () => {
    expect(awayLabel({ ...base, cwd: '/Users/me/other' }, root, '/Users/me')).toBe('outside the repo');
  });

  it('names the folder when the label is busy showing a command', () => {
    const s: Info = { ...base, cwd: '/Users/me/other', state: { t: 'Running', command: 'claude', since_ms: 0 } };
    expect(awayLabel(s, root, '/Users/me')).toBe('outside the repo, in ~/other');
  });
});

const session = (id: number, title: string, over: Partial<Info> = {}): Info =>
  ({ id, title, cwd: '/r', tier: 'marks', state: { t: 'Idle' }, ...over });

describe('terminal labels', () => {
  it('numbers per kind over the whole rail, counting exited and away sessions', () => {
    const labels = termLabels([
      session(3, 'zsh'),
      session(5, 'claude'),
      session(6, 'codex'),
      session(7, 'claude', { cwd: '/elsewhere' }),
      session(8, 'claude', { state: { t: 'Exited', code: 0 } }),
      session(9, 'claude'),
      session(10, 'zsh', { state: { t: 'Running', command: 'claude --resume', since_ms: 0 } }),
    ]);
    expect([...labels.values()])
      .toEqual(['zsh:1', 'claude:1', 'codex:1', 'claude:2', 'claude:3', 'claude:4', 'claude:5']);
  });
});

describe('the rail', () => {
  const task = (id: number): Info => ({
    id, title: 'pnpm test', cwd: '/r', tier: 'process', state: { t: 'Running', command: null, since_ms: 0 }, task: true,
  });
  const shell = (id: number): Info => ({ id, title: 'zsh', cwd: '/r', tier: 'marks', state: { t: 'Idle' } });

  it('keeps tasks out of the rail until one is moved there', () => {
    expect(terminalsOf([shell(1), task(2), { ...task(3), task: false }]).map((s) => s.id)).toEqual([1, 3]);
  });
});

describe('where a session outside the repo works', () => {
  const HOME = '/Users/me';
  const web = { path: '/Users/me/projects/web', name: 'Web' };
  const repos = [web, { path: '/Users/me/projects/web/vendor/lib', name: 'lib' }];

  it('names the repo holding the folder, with the path below it', () => {
    expect(placeOf('/Users/me/projects/web', HOME, repos)).toEqual({ repo: web, lead: '', name: 'Web', tail: '' });
    expect(placeOf('/Users/me/projects/web/src/pages', HOME, repos))
      .toEqual({ repo: web, lead: '', name: 'Web', tail: '/src/pages' });
  });

  it('names the innermost of two nested repos, and not a sibling that only shares a prefix', () => {
    expect(placeOf('/Users/me/projects/web/vendor/lib/src', HOME, repos))
      .toMatchObject({ name: 'lib', tail: '/src' });
    expect(placeOf('/Users/me/projects/website', HOME, repos))
      .toEqual({ repo: null, lead: '~/projects/', name: 'website', tail: '' });
  });

  it('falls back to the folder, and shortens the path to it', () => {
    expect(placeOf('/Users/me/notes', HOME, [])).toEqual({ repo: null, lead: '~/', name: 'notes', tail: '' });
    expect(placeOf('/Users/me', HOME, [])).toEqual({ repo: null, lead: '', name: '~', tail: '' });
    expect(placeOf('/tmp', HOME, [])).toEqual({ repo: null, lead: '/', name: 'tmp', tail: '' });
    expect(placeOf('/', HOME, [])).toEqual({ repo: null, lead: '', name: '/', tail: '' });
  });
});

describe('agent state', () => {
  const idle: AgentState = {
    phase: 'idle', since_ms: 0, turn_ms: null, took_ms: null, end: null, actions: 0, calls: [], last: null, ask: null,
    subagents: 0, rev: 0,
  };
  const call = (tool: string, detail: string, since_ms = 1000) => ({ id: tool, tool, detail, since_ms });
  const working: AgentState = { ...idle, phase: 'working', since_ms: 1000, turn_ms: 1000 };

  it('names each tool call by what it does', () => {
    expect(activity(call('Bash', 'Run the cart tests'))).toBe('Run the cart tests');
    expect(activity(call('Edit', '/r/src/cart.ts'))).toBe('Editing cart.ts');
    expect(activity(call('Grep', 'applyCoupon('))).toBe('Searching for "applyCoupon("');
    expect(activity(call('WebFetch', 'https://example.com/a?b'))).toBe('Fetching example.com');
    expect(activity(call('mcp__github__get_issue', ''))).toBe('Using github: get_issue');
    expect(activity(call('Frobnicate', ''))).toBe('Using Frobnicate');
  });

  it('says what a turn is doing, and how long the newest open call has run', () => {
    expect(agentStatus(working, 4000)).toEqual(
      { tone: 'run', text: 'Reading your prompt', since: 1000, about: null, turn: 'Turn 3s · 0 actions' });
    const two = { ...working, actions: 2, calls: [call('Read', '/a.ts', 2000), call('Grep', 'x', 3000)] };
    expect(agentStatus(two, 4000)).toMatchObject({ text: 'Searching for "x" (+1 more)', since: 3000 });
    expect(agentStatus({ ...working, actions: 2 }, 4000).text).toBe('Thinking');
    const ask = { ...working, phase: 'approval' as const, ask: call('Bash', 'Build it') };
    expect(agentStatus(ask, 4000))
      .toMatchObject({ tone: 'wait', text: 'Waiting for your approval', about: 'Build it' });
  });

  it('sums up a finished turn by how it ended', () => {
    const ended = (end: AgentState['end']) => agentStatus({ ...idle, end, took_ms: 65_000, actions: 5 }, 0).text;
    expect(ended('done')).toBe('Done in 1m05s · 5 actions');
    expect(ended('interrupted')).toBe('Interrupted after 1m05s');
    expect(ended('failed')).toBe('Stopped on an API error after 1m05s');
    expect(ended(null)).toBe('Ready for a prompt');
  });

  it('wants you when it asks, or when a turn ends on its own, but not after you interrupted it', () => {
    expect(wantsYou(working, { ...working, phase: 'approval' })).toBe(true);
    expect(wantsYou({ ...working, phase: 'approval' }, { ...working, phase: 'approval' })).toBe(false);
    expect(wantsYou(working, { ...idle, end: 'done' })).toBe(true);
    expect(wantsYou(working, { ...idle, end: 'interrupted' })).toBe(false);
    expect(wantsYou(undefined, idle)).toBe(false);
  });

  it('labels a claude session from its hooks, and an exited one from its exit', () => {
    const s: Info = {
      id: 1, title: 'claude', cwd: '/r', tier: 'process', state: { t: 'Running', command: null, since_ms: 0 },
      agent: { ...working, calls: [call('Read', '/r/a.ts', 1000)] },
    };
    expect(statusLabel(s, 6000)).toBe('Reading a.ts 5s');
    expect(statusLabel({ ...s, state: { t: 'Exited', code: 0 } }, 6000)).toBe('exited 0');
  });
});
