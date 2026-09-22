import { describe, expect, it } from 'vitest';
import { agentOf, elapsed, homeFrom, shortCwd, statusLabel } from './terminal-status';
import type { Info } from './terminal';

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
  });

  it('names the agent a shell is running right now', () => {
    expect(agentOf({ ...base, state: { t: 'Running', command: 'claude --resume', since_ms: 0 } })).toBe('claude');
  });

  it('has nothing to show for a plain shell or an unrelated command', () => {
    expect(agentOf(base)).toBe(null);
    expect(agentOf({ ...base, state: { t: 'Running', command: 'pnpm test', since_ms: 0 } })).toBe(null);
  });
});
