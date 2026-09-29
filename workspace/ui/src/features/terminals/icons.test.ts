import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Info, TermState } from '#ipc/terminal';

vi.mock('#features/command-icons', async () => ({
  ...(await vi.importActual<object>('#features/command-icons')), ensureIcons: vi.fn(() => Promise.resolve()),
}));

const { ensureIcons } = await import('#features/command-icons');
const { S } = await import('#kernel/store');
const { ensureTermIcons, forgetIcon, iconFor, LONG_MS, restoreIcons, watchLong } = await import('./icons');

const running = (command: string | null, ago = 0): TermState => ({ t: 'Running', command, since_ms: Date.now() - ago });
const shell = (id: number, state: TermState = { t: 'Idle' }, pid = 100 + id): Info =>
  ({ id, pid, title: 'zsh', cwd: '/r', tier: 'marks', state });

/** What the host would send, so the timer finds the session in the state it last reported. */
function report(s: Info): void {
  S.terminals = [...S.terminals.filter((t) => t.id !== s.id), s];
  watchLong(s);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  S.terminals = [];
  S.termIcons = new Map();
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('a shell', () => {
  it('is named by the first command still running once it is long, and keeps that name', () => {
    report(shell(1, running('ls')));
    report(shell(1));
    vi.advanceTimersByTime(LONG_MS);
    expect(S.termIcons.has(1)).toBe(false);

    report(shell(1, running('pnpm dev')));
    vi.advanceTimersByTime(LONG_MS - 1);
    expect(S.termIcons.has(1)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(iconFor(S.terminals[0]!, S.termIcons)).toEqual({ name: '', command: 'pnpm dev', icon: null });

    report(shell(1, running('cargo test')));
    vi.advanceTimersByTime(LONG_MS);
    expect(S.termIcons.get(1)?.command).toBe('pnpm dev');
  });

  it('is named at once by a command that was already long when the list arrived', () => {
    S.terminals = [shell(1, running('pnpm dev', LONG_MS * 3))];
    restoreIcons(S.terminals);
    vi.advanceTimersByTime(0);
    expect(S.termIcons.get(1)?.command).toBe('pnpm dev');
  });

  it('is not named by an agent, which draws its own mark, nor by a run with no command', () => {
    report(shell(1, running('claude --resume')));
    report(shell(2, running(null)));
    vi.advanceTimersByTime(LONG_MS * 2);
    expect(S.termIcons.size).toBe(0);
    expect(iconFor(shell(2), S.termIcons)).toBeNull();
  });
});

it('picks for a program by its title, and for no agent', () => {
  const program: Info = { id: 3, title: 'htop', cwd: '/r', tier: 'process', state: running(null) };
  const agent: Info = { ...program, title: 'claude' };
  // a shell whose marks never came is still a shell
  const quiet: Info = { ...program, title: 'bash' };
  expect(iconFor(program, S.termIcons)).toEqual({ name: '', command: 'htop', icon: null });
  expect(iconFor(agent, S.termIcons)).toBeNull();
  expect(iconFor(quiet, S.termIcons)).toBeNull();
  // an ended session draws the same sign whatever it ran, so there is nothing to pick for
  expect(iconFor({ ...program, state: { t: 'Exited', code: 0 } }, S.termIcons)).toBeNull();
});

it('keeps each name across a reload by id and pid, and drops those of sessions that are gone', () => {
  report(shell(1, running('pnpm dev')));
  report(shell(2, running('ssh box')));
  vi.advanceTimersByTime(LONG_MS);
  expect(S.termIcons.size).toBe(2);

  // a newer host handed id 2 to another process
  const after = [shell(1), shell(2, { t: 'Idle' }, 999)];
  S.terminals = after;
  restoreIcons(after);
  expect([...S.termIcons]).toEqual([[1, { name: '', command: 'pnpm dev', icon: null }]]);

  S.terminals = [];
  forgetIcon(1);
  restoreIcons([shell(1)]);
  expect(S.termIcons.size).toBe(0);
});

describe('asking', () => {
  const ai = { name: '', command: 'pnpm dev', icon: null };
  const hand = { name: 'dev', command: 'vite', icon: 'lucide:play' };

  it('asks quietly for the icons it has none of, and never for a hand pick', () => {
    ensureTermIcons([ai, hand]);
    expect(ensureIcons).toHaveBeenCalledExactlyOnceWith([ai], { quiet: true });
  });

  it('with the AI off, loads the sets only to draw a hand pick', () => {
    S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
    ensureTermIcons([ai]);
    expect(ensureIcons).not.toHaveBeenCalled();
    ensureTermIcons([ai, hand]);
    expect(ensureIcons).toHaveBeenCalledExactlyOnceWith([], { quiet: true });
  });
});
