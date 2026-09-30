import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refresh, withBusy } from '#core/session';
import { choiceDialog, confirmDialog } from '#kernel/dialogs';
import { S } from '#kernel/store';
import type { Outgoing, Stash } from '#ipc/git';
import { blob, file, g, mountApp, openUnstaged, status, type } from '#test-app';
import { tick } from '#test-setup';
import { age, commit, loadOutgoing, network, stash, undoCommit, unstash } from './git-ops';
import { gitOps } from './index';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn(), choiceDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const ROOT = '/repo/a';
const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;
const choiceMock = choiceDialog as unknown as ReturnType<typeof vi.fn>;

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  // an icon ask started while a test had the AI on can finish in a later test
  g.aiCommandIcons!.mockResolvedValue([]);
  g.aiRepoIcons!.mockResolvedValue([]);
  confirmMock.mockReset().mockResolvedValue(false);
  choiceMock.mockReset().mockResolvedValue(null);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
  S.root = ROOT;
});

describe('the open file with unsaved changes', () => {
  beforeEach(async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
  });

  it('is offered a save before a stash, which Cancel skips altogether', async () => {
    await stash('unstaged');
    expect(choiceMock).toHaveBeenCalledWith(expect.stringMatching(/^a\.txt has unsaved changes\n/),
      'Save & Stash', 'Stash Anyway');
    expect(g.stashPush!).not.toHaveBeenCalled();
  });

  it('is not asked about for a stash of the staged changes, which takes only the index', async () => {
    await stash('staged');
    expect(choiceMock).not.toHaveBeenCalled();
    expect(g.stashPush!).toHaveBeenCalledExactlyOnceWith(ROOT, 'staged', null);
    expect(S.open!.dirty).toBe(true);
  });

  it('is saved before the stash on Save & Stash, and left unsaved on Stash Anyway', async () => {
    choiceMock.mockResolvedValue('ok');
    await stash('unstaged');
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(g.stashPush!).toHaveBeenCalledOnce();

    type('more\n');
    g.writeFile!.mockClear();
    choiceMock.mockResolvedValue('alt');
    await stash('unstaged');
    expect(g.writeFile!).not.toHaveBeenCalled();
    expect(g.stashPush!).toHaveBeenCalledTimes(2);
    expect(S.open!.dirty).toBe(true);
  });

  it('stays unsaved through a commit and a pull, which take the index and the remote', async () => {
    S.commitMessage = 'a message';
    await commit();
    await network('pull');
    expect(g.commit!).toHaveBeenCalledOnce();
    expect(g.pull!).toHaveBeenCalledOnce();
    expect(choiceMock).not.toHaveBeenCalled();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});

describe('a successful commit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows a check on the button instead of a toast, then goes back to normal', async () => {
    S.toasts = [];
    S.commitMessage = 'a message';
    await commit();

    expect(S.toasts).toEqual([]);
    expect(S.committed).toBe(true);
    await vi.advanceTimersByTimeAsync(650);
    expect(S.committed).toBe(false);
  });
});

describe('a failed commit', () => {
  it('reports in a dialog rather than a toast, and stops the button spinning', async () => {
    S.toasts = [];
    S.commitMessage = 'a message';
    g.commit!.mockRejectedValue({ kind: 'Git', detail: 'pre-commit hook failed' });

    await commit();

    expect(S.toasts).toEqual([]);
    expect(S.confirm?.message).toBe('Commit failed\npre-commit hook failed');
    expect(S.confirm?.error).toBe(true);
    expect(S.committing).toBe(false);
    expect(S.committed).toBe(false);
    expect(S.commitMessage).toBe('a message');
    S.confirm!.resolve(false);
    S.confirm = null;
  });
});

describe('the branch row', () => {
  it('withBusy keeps a fast operation off the spinner', async () => {
    await withBusy(() => Promise.resolve());
    await new Promise((r) => setTimeout(r, 200));
    expect(S.busy).toBe(false);
  });

  it('withBusy shows the spinner once an operation outlives the delay', async () => {
    let release!: () => void;
    const slow = withBusy(() => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 200));
    expect(S.busy).toBe(true);
    release();
    await slow;
    expect(S.busy).toBe(false);
  });

  it('marks the ahead and behind counts only when there is something to push or pull', async () => {
    const { notify } = await import('#kernel/store');
    const tracked = (ahead: number, behind: number) => ({ ...status('a.txt'), upstream: 'origin/main', ahead, behind });

    S.status = tracked(2, 0);
    notify();
    await tick();
    // direct children only: Count wraps the number itself in another span
    let counts = [...document.querySelectorAll('.commit .ab > span')];
    expect(counts.map((c) => c.textContent)).toEqual(['↑2', '↓0']);
    expect(counts.map((c) => c.className)).toEqual(['on', '']);

    S.status = tracked(0, 3);
    notify();
    await tick();
    counts = [...document.querySelectorAll('.commit .ab > span')];
    expect(counts.map((c) => c.textContent)).toEqual(['↑0', '↓3']);
    expect(counts.map((c) => c.className)).toEqual(['', 'on']);

    S.status = status('a.txt');
    notify();
    await tick();
    expect(document.querySelector('.commit .ab')).toBeNull();
    expect(document.querySelector('.commit .branch .co')!.textContent).toBe('mainno upstream');
  });

  it('shows a spinner while busy, and Cancel only when the operation can be cancelled', async () => {
    const { notify } = await import('#kernel/store');
    S.busy = true;
    notify();
    await tick();
    expect(document.querySelector('.commit .branch .spinner')).not.toBeNull();
    expect(document.querySelector('.commit .branch .btn')).toBeNull();

    S.cancellable = true;
    notify();
    await tick();
    const cancel = document.querySelector<HTMLButtonElement>('.commit .branch .btn')!;
    expect(cancel.textContent).toBe('Cancel');

    cancel.click();

    expect(g.cancel!).toHaveBeenCalledTimes(1);
    S.busy = false;
    S.cancellable = false;
    notify();
    await tick();
    expect(document.querySelector('.commit .branch .spinner')).toBeNull();
  });
});

describe('the stash commands', () => {
  const shown = () =>
    gitOps.commands.filter((c) => /^git\.(un)?stash/.test(c.id) && (!('when' in c) || c.when())).length;

  it('are offered only on a repo with a commit and no conflict, and not with no repo open', () => {
    S.status = status('a.txt');
    expect(shown()).toBe(4);
    S.status = status('a.txt', 'U', 'U', false, true);
    expect(shown()).toBe(0);
    S.status = { ...status('a.txt'), head: null };
    expect(shown()).toBe(0);
    S.status = null;
    expect(shown()).toBe(0);
  });
});

describe('stashing', () => {
  const setAi = (provider: 'claude' | 'off') => {
    S.settings = { ...S.settings, 'general.headless-ai-provider': provider };
  };
  beforeEach(() => { S.toasts = []; });
  afterEach(() => { setAi('off'); });

  it('asks the AI to describe the stash and stores its answer as the message', async () => {
    setAi('claude');
    g.aiStashDescription!.mockResolvedValue('Adds a thing. It helps.');
    await stash('staged');
    expect(g.aiStashDescription!).toHaveBeenCalledWith('staged');
    expect(g.stashPush!).toHaveBeenCalledExactlyOnceWith(ROOT, 'staged', 'Adds a thing. It helps.');
  });

  it('stashes without a description when the AI fails, and warns', async () => {
    setAi('claude');
    g.aiStashDescription!.mockRejectedValue({ kind: 'Ai', detail: 'claude took too long and was stopped' });
    await stash('unstaged');
    expect(g.stashPush!).toHaveBeenCalledExactlyOnceWith(ROOT, 'unstaged', null);
    expect(S.toasts.map((t) => [t.kind, t.message]))
      .toContainEqual(['warn', 'Stashing without a description\nclaude took too long and was stopped']);
  });

  it('does not ask the AI while it is off', async () => {
    setAi('off');
    g.stashPush!.mockResolvedValue(true);
    await stash('all');
    expect(g.aiStashDescription!).not.toHaveBeenCalled();
    expect(g.stashPush!).toHaveBeenCalledExactlyOnceWith(ROOT, 'all', null);
    expect(S.toasts).toEqual([]);
  });

  it('says so when there was nothing to stash', async () => {
    setAi('off');
    g.stashPush!.mockResolvedValue(false);
    await stash('unstaged');
    expect(S.toasts.map((t) => t.message)).toEqual(['No local changes to save']);
  });

  it('stashes nothing when another repo was opened while the AI wrote, and runs one stash at a time', async () => {
    setAi('claude');
    let answer: (text: string) => void = () => {};
    g.aiStashDescription!.mockReturnValue(new Promise((r) => { answer = r; }));
    const first = stash('unstaged');
    await vi.waitFor(() => expect(g.aiStashDescription!).toHaveBeenCalledOnce());
    await stash('unstaged');
    expect(g.aiStashDescription!).toHaveBeenCalledOnce();
    S.root = '/repo/b';
    answer('Describes repo a.');
    await first;
    expect(g.stashPush!).not.toHaveBeenCalled();
    expect(S.toasts.map((t) => t.message)).toEqual(['Nothing was stashed: another repository was opened']);
  });
});

describe('unstashing', () => {
  const now = Date.now();
  const entry = (index: number, extra: Partial<Stash>): Stash => ({
    index, oid: `oid${index}`, branch: 'main', message: 'm', wip: false, time: Math.floor(now / 1000) - 300, ...extra,
  });
  beforeEach(() => { S.toasts = []; S.palette = null; });

  it('says so when there is nothing to restore', async () => {
    g.stashList!.mockResolvedValue([]);
    await unstash();
    expect(S.palette).toBeNull();
    expect(S.toasts.map((t) => t.message)).toEqual(['No stashes to restore']);
  });

  it('lists each stash with its branch and age, and pops the one picked by its index and oid', async () => {
    g.stashList!.mockResolvedValue([
      entry(0, { message: 'Adds a thing.' }),
      entry(1, { message: '1a2b3c4 init', wip: true, branch: null }),
    ]);
    const done = unstash();
    await vi.waitFor(() => expect(S.palette).not.toBeNull());
    expect(S.palette!.wide).toBe(true);
    expect(S.palette!.items.map((i) => [i.label, i.sub])).toEqual([
      ['Adds a thing.', 'main · 5 minutes ago'], ['WIP on 1a2b3c4 init', '5 minutes ago'],
    ]);
    S.palette!.resolve(S.palette!.items[1]!.value);
    await done;
    expect(g.stashPop!).toHaveBeenCalledExactlyOnceWith(1, 'oid1');
  });

  it('warns when the staged changes came back unstaged, and only then', async () => {
    g.stashList!.mockResolvedValue([entry(0, {})]);
    for (const kept of [true, false]) {
      S.toasts = [];
      S.palette = null;
      g.stashPop!.mockResolvedValue(kept);
      const done = unstash();
      await vi.waitFor(() => expect(S.palette).not.toBeNull());
      S.palette!.resolve(S.palette!.items[0]!.value);
      await done;
      expect(S.toasts.some((t) => t.kind === 'warn' && t.message.includes('came back unstaged'))).toBe(!kept);
    }
  });

  it('tells the age in the largest unit that fits', () => {
    const at = (s: number) => age(Math.floor(now / 1000) - s, now);
    expect([at(5), at(90), at(7200), at(86_400 * 1.5), at(86_400 * 3), at(86_400 * 400)])
      .toEqual(['just now', '1 minute ago', '2 hours ago', 'yesterday', '3 days ago', 'last year']);
  });
});

describe('the commits a push would send', () => {
  const last = { oid: 'b'.repeat(40), summary: 'Add the thing', author: 't', time: 1 };
  const one: Outgoing = { commits: [last], more: false };
  beforeEach(() => {
    S.outgoing = { commits: [], more: false };
    S.commitMessage = '';
    S.toasts = [];
  });

  it('are read on every refresh, without holding it up, and dropped with the repo', async () => {
    g.status!.mockResolvedValue(S.status);
    let answer: (o: Outgoing) => void = () => {};
    g.outgoing!.mockReturnValue(new Promise<Outgoing>((r) => { answer = r; }));
    await refresh();
    expect(S.outgoing.commits).toEqual([]);
    answer(one);
    await tick();
    expect(S.outgoing).toEqual(one);
    gitOps.onRepoChange.reset();
    expect(S.outgoing.commits).toEqual([]);
  });

  it('are none when the read fails, without failing the refresh', async () => {
    S.outgoing = one;
    g.status!.mockResolvedValue(S.status);
    g.outgoing!.mockRejectedValue({ kind: 'Git', detail: 'bad revision' });
    await refresh();
    await tick();
    expect(S.outgoing.commits).toEqual([]);
    expect(S.toasts).toEqual([]);
  });

  it('are not written by a read that a newer one started after', async () => {
    let first: (o: Outgoing) => void = () => {};
    g.outgoing!.mockReturnValueOnce(new Promise<Outgoing>((r) => { first = r; }))
      .mockResolvedValueOnce({ commits: [], more: false });
    const older = loadOutgoing();
    await loadOutgoing();
    first(one);
    await older;
    expect(S.outgoing.commits).toEqual([]);
  });

  it('are not written for a repo switched from while they were read', async () => {
    let answer: (o: Outgoing) => void = () => {};
    g.outgoing!.mockReturnValue(new Promise<Outgoing>((r) => { answer = r; }));
    const load = loadOutgoing();
    S.root = '/repo/b';
    answer(one);
    await load;
    expect(S.outgoing.commits).toEqual([]);
  });

  it('put the reverted commit\'s message into an empty commit box', async () => {
    S.outgoing = one;
    g.undoCommit!.mockResolvedValue('Add the thing\n\nWhy it was added');
    await undoCommit();
    expect(g.undoCommit).toHaveBeenCalledWith(last.oid);
    expect(S.commitMessage).toBe('Add the thing\n\nWhy it was added');
    expect(S.toasts.map((t) => t.message)).toEqual(['Reverted "Add the thing"\nIts changes are staged.']);
  });

  it('keep a message already typed, and show a failed revert', async () => {
    S.outgoing = one;
    S.commitMessage = 'mine';
    g.undoCommit!.mockResolvedValue('Add the thing');
    await undoCommit();
    expect(S.commitMessage).toBe('mine');
    expect(S.toasts.map((t) => t.message))
      .toEqual(['Reverted "Add the thing"\nIts changes are staged, and the commit box kept what you typed.']);
    S.toasts = [];
    g.undoCommit!.mockRejectedValue({ kind: 'Git', detail: 'The last commit changed. Look at the commits again.' });
    await undoCommit();
    expect(S.commitMessage).toBe('mine');
    expect(S.toasts.map((t) => [t.kind, t.message]))
      .toEqual([['err', 'The last commit changed. Look at the commits again.']]);
  });

  it('leave the box of a repo opened during the revert alone', async () => {
    S.outgoing = one;
    let answer: (m: string) => void = () => {};
    g.undoCommit!.mockReturnValue(new Promise<string>((r) => { answer = r; }));
    const undo = undoCommit();
    S.root = '/repo/b';
    answer('Add the thing');
    await undo;
    expect(S.commitMessage).toBe('');
    expect(S.toasts).toEqual([]);
  });

  it('offer the revert in the palette only while there is one', () => {
    const cmd = gitOps.commands.find((c) => c.id === 'git.undoCommit')!;
    expect('when' in cmd && cmd.when()).toBe(false);
    S.outgoing = one;
    expect('when' in cmd && cmd.when()).toBe(true);
  });
});
