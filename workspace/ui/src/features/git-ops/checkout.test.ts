import { beforeEach, expect, it, vi } from 'vitest';
import type { BranchInfo } from '#ipc/git';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});
vi.mock('#kernel/pick', async () => {
  const actual = await vi.importActual<typeof import('#kernel/pick')>('#kernel/pick');
  return { ...actual, pick: vi.fn() };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, promptDialog: vi.fn() };
});

const { git } = await import('#ipc/git');
const { pick } = await import('#kernel/pick');
const { promptDialog } = await import('#kernel/dialogs');
const { checkout } = await import('./git-ops');
const { S } = await import('#kernel/store');
const g = git as unknown as Record<string, ReturnType<typeof vi.fn<(...args: never[]) => Promise<unknown>>>>;
const pickMock = vi.mocked(pick);
const promptMock = vi.mocked(promptDialog);

const now = Math.floor(Date.now() / 1000);
const tip = (hoursAgo: number, mine = true) =>
  ({ author: mine ? 'Me' : 'Dana Kim', time: now - hoursAgo * 3600, mine });
const main: BranchInfo = { kind: 'local', name: 'main', ...tip(2, false) };
const feat: BranchInfo = { kind: 'local', name: 'feat', ...tip(5) };
const offered = () => pickMock.mock.calls[0]![0];
const rows = () => offered().map(({ label, detail, note, group, dim }) => ({ label, detail, note, group, dim }));

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  g.branches!.mockResolvedValue([feat, main]);
  S.status = null;
  pickMock.mockReset();
  promptMock.mockReset();
});

it('offers creating a new branch above every branch', async () => {
  pickMock.mockResolvedValue(null);
  await checkout();
  expect(offered().map((it) => it.label)).toEqual(['+ Create new branch…', 'feat', 'main']);
});

it('heads your branches and the others only when both exist, and dims the others', async () => {
  S.status = { head: null, branch: 'feat', upstream: null, ahead: 0, behind: 0, stash: 0, files: [] };
  g.branches!.mockResolvedValue([
    feat, main,
    { kind: 'remote', remote: 'origin', branch: 'feat', ...tip(5) },
    { kind: 'remote', remote: 'origin', branch: 'mine', ...tip(30) },
    { kind: 'remote', remote: 'origin', branch: 'theirs', ...tip(1, false) },
  ]);
  pickMock.mockResolvedValue(null);
  await checkout();
  expect(rows().slice(1)).toEqual([
    { label: 'feat', detail: 'current', note: '5 hours ago', group: 'Yours', dim: false },
    { label: 'origin/mine', detail: 'remote', note: 'yesterday', group: 'Yours', dim: false },
    { label: 'main', detail: 'local', note: '2 hours ago', group: 'Others', dim: false },
    { label: 'origin/theirs', detail: 'Dana Kim', note: '1 hour ago', group: 'Others', dim: true },
  ]);

  pickMock.mockClear();
  g.branches!.mockResolvedValue([feat]);
  await checkout();
  expect(rows().map((r) => r.group)).toEqual([undefined, undefined]);
});

it('creates the branch when the create row is picked', async () => {
  pickMock.mockImplementation(async (items) => items[0]!.value);
  promptMock.mockResolvedValue('topic');
  await checkout();
  expect(promptMock).toHaveBeenCalledWith('New branch name', true);
  expect(git.createBranch).toHaveBeenCalledWith('topic');
  expect(git.switchBranch).not.toHaveBeenCalled();
});

it('creates nothing when the name prompt is cancelled', async () => {
  pickMock.mockImplementation(async (items) => items[0]!.value);
  promptMock.mockResolvedValue(null);
  await checkout();
  expect(git.createBranch).not.toHaveBeenCalled();
  expect(git.switchBranch).not.toHaveBeenCalled();
});

it('switches to a picked branch', async () => {
  pickMock.mockResolvedValue(feat);
  await checkout();
  expect(git.switchBranch).toHaveBeenCalledWith(feat);
  expect(git.createBranch).not.toHaveBeenCalled();
});
