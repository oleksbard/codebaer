import { beforeEach, expect, it, vi } from 'vitest';
import type { Branch } from '#ipc/git';

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
const g = git as unknown as Record<string, ReturnType<typeof vi.fn<(...args: never[]) => Promise<unknown>>>>;
const pickMock = vi.mocked(pick);
const promptMock = vi.mocked(promptDialog);

const main: Branch = { kind: 'local', name: 'main' };
const feat: Branch = { kind: 'local', name: 'feat' };
const offered = () => pickMock.mock.calls[0]![0];

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  g.branches!.mockResolvedValue([feat, main]);
  pickMock.mockReset();
  promptMock.mockReset();
});

it('offers creating a new branch above every branch', async () => {
  pickMock.mockResolvedValue(null);
  await checkout();
  expect(offered().map((it) => it.label)).toEqual(['+ Create new branch…', 'main', 'feat']);
});

it('creates the branch when the create row is picked', async () => {
  pickMock.mockImplementation(async (items) => items[0]!.value);
  promptMock.mockResolvedValue('topic');
  await checkout();
  expect(promptMock).toHaveBeenCalledWith('New branch name');
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
