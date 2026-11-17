import { beforeEach, expect, it, vi } from 'vitest';
import type { Info } from '#ipc/terminal';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: { ...actual.git, aiSessionName: vi.fn() } };
});
vi.mock('#ipc/log', async () => {
  const actual = await vi.importActual<typeof import('#ipc/log')>('#ipc/log');
  return { ...actual, logError: vi.fn() };
});

const { git } = await import('#ipc/git');
const { logError } = await import('#ipc/log');
const { S } = await import('#kernel/store');
const { KEEP, forgetName, nameFrom, restoreNames } = await import('./names');
const { onTermEvent } = await import('./sessions');

const claude = (id: number, pid = 100 + id): Info =>
  ({ id, pid, title: 'claude', cwd: '/r', tier: 'process', state: { t: 'Running', command: null, since_ms: 0 } });
const ask = vi.mocked(git.aiSessionName);

beforeEach(() => {
  localStorage.clear();
  ask.mockReset();
  S.terminals = [claude(1), claude(2)];
  S.termNames = new Map();
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  forgetName(1);
  forgetName(2);
});

it('names a session from the prompt its hook reported, and keeps the name across a reload', async () => {
  ask.mockResolvedValue('Login bug');
  onTermEvent({ t: 'Prompt', id: 1, text: 'Fix the login bug' });
  await vi.waitFor(() => expect(S.termNames.get(1)).toBe('Login bug'));
  expect(ask).toHaveBeenCalledWith(['Fix the login bug'], null);

  S.termNames = new Map();
  restoreNames([claude(1), claude(2)]);
  expect(S.termNames.get(1)).toBe('Login bug');
  restoreNames([claude(1, 999)]);
  expect(S.termNames.has(1)).toBe(false);
});

it('asks with the current name and the recent prompts, and keeps the name when the AI is not sure', async () => {
  S.termNames.set(1, 'Login bug');
  ask.mockResolvedValue(null);
  for (let i = 1; i <= KEEP + 1; i++) await nameFrom(1, `prompt ${i}`);
  expect(ask).toHaveBeenLastCalledWith(Array.from({ length: KEEP }, (_, i) => `prompt ${i + 2}`), 'Login bug');
  expect(S.termNames.get(1)).toBe('Login bug');
});

it('keeps the answer to a prompt that quick follow-ups came after, then asks once more for them', async () => {
  let first: (name: string | null) => void = () => {};
  ask.mockImplementationOnce(() => new Promise((r) => { first = r; })).mockResolvedValueOnce(null);
  const asking = nameFrom(1, 'Fix the login bug');
  await nameFrom(1, 'yes');
  await nameFrom(1, 'go on');
  expect(ask).toHaveBeenCalledTimes(1);
  first('Login bug');
  await asking;
  expect(ask).toHaveBeenCalledTimes(2);
  expect(ask).toHaveBeenLastCalledWith(['Fix the login bug', 'yes', 'go on'], 'Login bug');
  expect(S.termNames.get(1)).toBe('Login bug');
});

it('gives nothing of a session to the one that a new host numbered the same', async () => {
  let answer: (name: string | null) => void = () => {};
  ask.mockImplementationOnce(() => new Promise((r) => { answer = r; })).mockResolvedValueOnce(null);
  const asking = nameFrom(1, 'Fix the login bug');
  onTermEvent({ t: 'Hello', proto: 5, sessions: [claude(1, 999)] });
  answer('Login bug');
  await asking;
  expect(S.termNames.has(1)).toBe(false);
  await nameFrom(1, 'Add a dark mode');
  expect(ask).toHaveBeenLastCalledWith(['Add a dark mode'], null);
});

it('asks nothing while the provider is off, and says nothing when the ask fails', async () => {
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
  await nameFrom(1, 'Fix the login bug');
  expect(ask).not.toHaveBeenCalled();

  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  ask.mockRejectedValue({ kind: 'Ai', detail: 'claude CLI not found' });
  await nameFrom(1, 'Fix the login bug');
  expect(S.termNames.has(1)).toBe(false);
  expect(logError).toHaveBeenCalled();
});

it('drops the answer for a session that closed while its ask ran', async () => {
  let answer: (name: string | null) => void = () => {};
  ask.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
  const asking = nameFrom(2, 'Fix the login bug');
  onTermEvent({ t: 'Closed', id: 2 });
  answer('Login bug');
  await asking;
  expect(S.termNames.has(2)).toBe(false);
});
