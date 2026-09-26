import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Status } from '#ipc/git';
import { logInfo } from '#ipc/log';
import { DEFAULTS } from '#ipc/settings';
import { S } from '#kernel/store';
import { g } from '#test-app';
import { tick } from '#test-setup';
import { fetched, onStatus, startAutoFetch } from './auto-fetch';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#ipc/log', async () => {
  const actual = await vi.importActual<typeof import('#ipc/log')>('#ipc/log');
  return { ...actual, logInfo: vi.fn() };
});

const tracking = (branch: string, upstream: string | null = `origin/${branch}`): Status =>
  ({ head: 'abc', branch, upstream, ahead: 0, behind: 0, files: [] });

async function read(st: Status): Promise<void> {
  S.status = st;
  onStatus();
  await tick();
}

// the module remembers the last repository it saw, so each test starts in one it has not
let repo = 0;

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  vi.mocked(logInfo).mockReset();
  S.root = `/repo-${++repo}`;
  S.settings = { ...DEFAULTS };
});

describe('auto fetch', () => {
  it('is on by default', () => {
    expect(DEFAULTS['general.auto-fetch']).toBe('on');
  });

  it('fetches on opening a repository and on switching branches, not on every refresh', async () => {
    await read(tracking('main'));
    await read(tracking('main'));
    expect(g.fetchBackground).toHaveBeenCalledTimes(1);
    await read(tracking('dev'));
    expect(g.fetchBackground).toHaveBeenCalledTimes(2);
    await read(tracking('main'));
    expect(g.fetchBackground).toHaveBeenCalledTimes(3);
  });

  it('fetches a repository opened while another one is fetching once that fetch ends', async () => {
    let finish = (): void => {};
    g.fetchBackground!.mockReturnValueOnce(new Promise((r) => { finish = () => r(undefined); }));
    await read(tracking('main'));
    S.root = `/repo-${++repo}`;
    await read(tracking('main'));
    expect(g.fetchBackground).toHaveBeenCalledTimes(1);
    finish();
    await tick();
    expect(g.fetchBackground).toHaveBeenCalledTimes(2);
  });

  it('leaves a branch with no upstream alone, and does nothing while off', async () => {
    await read(tracking('scratch', null));
    S.settings = { ...DEFAULTS, 'general.auto-fetch': 'off' };
    await read(tracking('main'));
    expect(g.fetchBackground).not.toHaveBeenCalled();
  });

  it('fetches again every few minutes, but not while the window is hidden', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      startAutoFetch();
      S.status = tracking('main');
      onStatus();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(g.fetchBackground).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(g.fetchBackground).toHaveBeenCalledTimes(2);
      visibility.mockReturnValue('hidden');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(g.fetchBackground).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('counts the user\'s own fetch, so the next one waits the full interval from it', async () => {
    vi.useFakeTimers();
    try {
      startAutoFetch();
      S.status = tracking('main');
      onStatus();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      fetched();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(g.fetchBackground).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(g.fetchBackground).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failure once until its reason changes', async () => {
    g.fetchBackground!.mockRejectedValue({ kind: 'Git', detail: 'Could not resolve host: github.com' });
    await read(tracking('main'));
    await read(tracking('dev'));
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('Could not resolve host'));
    g.fetchBackground!.mockRejectedValue({ kind: 'Git', detail: 'Permission denied (publickey).' });
    await read(tracking('main'));
    expect(logInfo).toHaveBeenCalledTimes(2);
  });
});
