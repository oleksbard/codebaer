import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '#ipc/git';
import type { Info } from '#ipc/terminal';
import { logInfo } from '#ipc/log';
import { DEFAULTS } from '#ipc/settings';
import { confirmDialog } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';
import { g, mountApp } from '#test-app';
import { tick } from '#test-setup';
import { updates } from './index';
import { checkForUpdates, openReleaseNotes, restartedIntoUpdate, restartToUpdate, startUpdates } from './updates';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});
vi.mock('#ipc/log', async () => {
  const actual = await vi.importActual<typeof import('#ipc/log')>('#ipc/log');
  return { ...actual, logInfo: vi.fn() };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn() };
});

const FOUND: Update = { version: '0.6.0', page: 'https://github.com/o/r/releases/tag/v0.6.0', keeps_terminals: true };
const MIN = 60_000;
const HOUR = 60 * MIN;

const term = (id: number, state: Info['state']): Info =>
  ({ id, title: 'zsh', cwd: '/tmp', tier: 'marks', state });
const toasts = (): string[] => S.toasts.map((t) => `${t.kind}: ${t.message}`);

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  vi.mocked(logInfo).mockReset();
  vi.mocked(confirmDialog).mockReset();
  S.settings = { ...DEFAULTS };
  S.canUpdate = false;
  S.update = null;
  S.toasts = [];
  S.terminals = [];
  S.comments = [];
  S.draft = null;
  S.open = null;
  localStorage.clear();
});

describe('automatic checks', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('never happen in a build that does not update itself', async () => {
    g.updateEnabled!.mockResolvedValue(false);
    await startUpdates();
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(S.canUpdate).toBe(false);
    expect(g.updateCheck).not.toHaveBeenCalled();
  });

  it('come half a minute after the start and every six hours after that', async () => {
    g.updateEnabled!.mockResolvedValue(true);
    g.updateCheck!.mockResolvedValue(null);
    await startUpdates();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(g.updateCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(g.updateCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(g.updateCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR + 10 * MIN);
    expect(g.updateCheck).toHaveBeenCalledTimes(2);
  });

  it('wait while the setting is off, and resume within minutes of it being turned on', async () => {
    g.updateEnabled!.mockResolvedValue(true);
    g.updateCheck!.mockResolvedValue(null);
    S.settings['general.check-updates'] = 'off';
    await startUpdates();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(g.updateCheck).not.toHaveBeenCalled();
    S.settings['general.check-updates'] = 'on';
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(g.updateCheck).toHaveBeenCalledTimes(1);
  });

  it('stop once an update is downloaded', async () => {
    g.updateEnabled!.mockResolvedValue(true);
    g.updateCheck!.mockResolvedValue(FOUND);
    await startUpdates();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(S.update).toEqual(FOUND);
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(g.updateCheck).toHaveBeenCalledTimes(1);
  });

  it('log a failure once until its reason changes, and show nothing', async () => {
    g.updateEnabled!.mockResolvedValue(true);
    g.updateCheck!.mockRejectedValue({ kind: 'Io', detail: 'offline' });
    await startUpdates();
    await vi.advanceTimersByTimeAsync(30_000 + 13 * HOUR);
    expect(g.updateCheck).toHaveBeenCalledTimes(3);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith('update check: offline');
    expect(S.toasts).toEqual([]);
  });
});

describe('Check for Updates', () => {
  it('says so when this is the newest version', async () => {
    g.updateCheck!.mockResolvedValue(null);
    g.appVersion!.mockResolvedValue('0.6.0');
    await checkForUpdates();
    expect(toasts()).toEqual(['info: Checking for updates…', 'info: CodeBär 0.6.0 is the newest version']);
  });

  it('points to the header once it has found one', async () => {
    g.updateCheck!.mockResolvedValue(FOUND);
    await checkForUpdates();
    expect(S.update).toEqual(FOUND);
    expect(toasts().at(-1)).toBe('info: CodeBär 0.6.0 is out. Install it from the button in the header.');
  });

  it('does not check again for an update it has already found', async () => {
    S.update = FOUND;
    await checkForUpdates();
    expect(g.updateCheck).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['info: CodeBär 0.6.0 is out. Install it from the button in the header.']);
  });

  it('is in the palette only in a build that updates itself', () => {
    const check = updates.commands.find((c) => c.id === 'updates.check')!;
    expect(check.when()).toBe(false);
    S.canUpdate = true;
    expect(check.when()).toBe(true);
  });

  it('offers Restart to Update in the palette only once an update is found', () => {
    const restart = updates.commands.find((c) => c.id === 'updates.restart')!;
    expect(restart.when()).toBe(false);
    S.update = FOUND;
    expect(restart.when()).toBe(true);
  });

  it('shows why a check failed', async () => {
    g.updateCheck!.mockRejectedValue({ kind: 'Io', detail: 'error sending request' });
    await checkForUpdates();
    expect(toasts().at(-1)).toBe('err: Could not check for updates: error sending request');
  });
});

describe('the header', () => {
  it('shows a downloaded update and nothing before', async () => {
    notify();
    await tick();
    expect(document.querySelector('.update-pill')).toBeNull();
    S.update = FOUND;
    notify();
    await tick();
    expect(document.querySelector('.update-pill')?.textContent).toBe('Update to 0.6.0 ▾');
  });
});

describe('Restart to Update', () => {
  it('installs an update that keeps the terminals without asking', async () => {
    S.update = FOUND;
    S.terminals = [term(1, { t: 'Idle' })];
    await restartToUpdate();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(g.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('asks before an update that cannot take over the running terminals ends them', async () => {
    S.update = { ...FOUND, keeps_terminals: false };
    S.terminals = [term(1, { t: 'Idle' }), term(2, { t: 'Running', command: 'vite', since_ms: 0 })];
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await restartToUpdate();
    expect(confirmDialog).toHaveBeenCalledWith(
      'CodeBär 0.6.0 cannot take over running terminals, so restarting ends the 2 running terminals.',
    );
    expect(g.updateInstall).not.toHaveBeenCalled();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await restartToUpdate();
    expect(g.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('does not ask about terminals that have exited', async () => {
    S.update = { ...FOUND, keeps_terminals: false };
    S.terminals = [term(1, { t: 'Exited', code: 0 })];
    await restartToUpdate();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(g.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('asks about pending comments first, as a repo switch does, and stops on Cancel', async () => {
    S.update = FOUND;
    S.comments = [{} as (typeof S.comments)[number]];
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await restartToUpdate();
    expect(confirmDialog).toHaveBeenCalledWith('Discard 1 pending comment?');
    expect(g.updateInstall).not.toHaveBeenCalled();
  });

  it('installs once however often it is chosen, also after the install has returned', async () => {
    S.update = FOUND;
    await Promise.all([restartToUpdate(), restartToUpdate()]);
    await restartToUpdate();
    expect(g.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('leaves the new app a mark to reopen the repo open now, which it reads once', async () => {
    S.update = FOUND;
    await restartToUpdate();
    expect(toasts()).toEqual(['info: Downloading CodeBär 0.6.0…']);
    expect(restartedIntoUpdate()).toBe(true);
    expect(restartedIntoUpdate()).toBe(false);
  });

  it('ignores a mark older than any restart, left by a relaunch that never started', () => {
    localStorage.setItem('codebaer.afterUpdate', String(Date.now() - 16 * MIN));
    expect(restartedIntoUpdate()).toBe(false);
  });

  it('shows why the install failed, keeps the update and leaves no mark', async () => {
    S.update = FOUND;
    g.updateInstall!.mockRejectedValue({ kind: 'Io', detail: 'Permission denied' });
    await restartToUpdate();
    expect(toasts().at(-1)).toBe('err: Could not install the update: Permission denied');
    expect(S.update).toEqual(FOUND);
    expect(restartedIntoUpdate()).toBe(false);
  });
});

describe("What's New", () => {
  it('opens the release page', () => {
    S.update = FOUND;
    openReleaseNotes();
    expect(g.openUrl).toHaveBeenCalledWith(FOUND.page);
  });
});
