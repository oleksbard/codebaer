import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IconItem, IconSet } from '#ipc/git';

vi.mock('#ipc/git', async () => ({
  ...(await vi.importActual<object>('#ipc/git')),
  git: { commandIcons: vi.fn(), saveCommandIcons: vi.fn(), aiCommandIcons: vi.fn() },
}));

const { git } = await import('#ipc/git');
const { S } = await import('#kernel/store');
const { ensureIcons, glyph, iconKey, loadIconSets, searchIcons } = await import('./icons');

const item = (name: string, command: string): IconItem => ({ name, command });
/** What the AI is told for each call, with the long name lists left out. */
const asked = () => vi.mocked(git.aiCommandIcons).mock.calls.map(([items]) => items);

beforeAll(async () => {
  vi.mocked(git.commandIcons).mockResolvedValue({ [iconKey('dev', 'vite')]: 'lucide:play' });
  await loadIconSets();
});

beforeEach(() => {
  vi.mocked(git.aiCommandIcons).mockReset();
  vi.mocked(git.saveCommandIcons).mockReset().mockResolvedValue();
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  S.toasts = [];
});

describe('glyph', () => {
  it('draws an icon from either set by its id, and a renamed one by its old name', () => {
    expect(glyph('lucide:hammer')).toMatchObject({ width: 24, height: 24, body: expect.stringContaining('<path') });
    expect(glyph('simple-icons:googlechrome')?.body).toContain('fill="currentColor"');
    expect(glyph('lucide:alert-circle')).toEqual(glyph('lucide:circle-alert'));
  });

  it('has nothing for an id no set has', () => {
    for (const id of ['lucide:no-such-icon', 'fontawesome:hammer', 'hammer', ':hammer', null]) {
      expect(glyph(id), String(id)).toBeNull();
    }
  });
});

describe('searchIcons', () => {
  it('lists the names that start with the query first, then the ones that hold it', () => {
    const starts = (id: string) => id.slice(id.indexOf(':') + 1).startsWith('git');
    const ids = searchIcons('git', 100);
    expect(ids).toEqual(expect.arrayContaining(['lucide:git-branch', 'simple-icons:github', 'lucide:folder-git']));
    expect(ids.findIndex((id) => !starts(id))).toBe(ids.filter(starts).length);
  });

  it('matches a space to a dash, stops at the limit, and never offers an icon its set removed', () => {
    expect(searchIcons('flask conical', 5)).toContain('lucide:flask-conical');
    expect(searchIcons('', 7)).toHaveLength(7);
    const chrome = searchIcons('chrome', 50);
    expect(chrome).toContain('simple-icons:googlechrome');
    expect(chrome).not.toContain('lucide:chrome');
  });
});

describe('ensureIcons', () => {
  it('asks only about the commands with no saved pick, once each, and saves what comes back', async () => {
    vi.mocked(git.aiCommandIcons).mockResolvedValue(['lucide:hammer', null]);
    const build = item('build', 'vite build');
    await ensureIcons([item('dev', 'vite'), build, item('odd', 'x'), build]);
    expect(asked()).toEqual([[build, item('odd', 'x')]]);
    const [, sets] = vi.mocked(git.aiCommandIcons).mock.calls[0]!;
    expect(sets.map((s: IconSet) => [s.prefix, s.names.includes('hammer')])).toEqual([
      ['lucide', true], ['simple-icons', false],
    ]);
    expect(sets[0]!.names).not.toContain('chrome');
    expect(git.saveCommandIcons).toHaveBeenCalledWith({ [iconKey('build', 'vite build')]: 'lucide:hammer' });
    expect(S.commandIcons).toMatchObject({
      [iconKey('dev', 'vite')]: 'lucide:play', [iconKey('build', 'vite build')]: 'lucide:hammer',
    });

    // no icon came back for this one, and it is not asked about again until the next launch
    await ensureIcons([item('odd', 'x')]);
    expect(asked()).toHaveLength(1);
  });

  it('asks nothing while the AI is off, and asks once it is turned on', async () => {
    S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
    await ensureIcons([item('lint', 'oxlint')]);
    expect(git.aiCommandIcons).not.toHaveBeenCalled();
    S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
    vi.mocked(git.aiCommandIcons).mockResolvedValue(['lucide:brush-cleaning']);
    await ensureIcons([item('lint', 'oxlint')]);
    expect(asked()).toEqual([[item('lint', 'oxlint')]]);
  });

  it('runs one ask at a time and puts what comes in meanwhile in the next', async () => {
    let answer: (ids: string[]) => void = () => {};
    vi.mocked(git.aiCommandIcons)
      .mockImplementationOnce(() => new Promise((r) => { answer = r; }))
      .mockResolvedValue(['lucide:flask-conical', 'lucide:camera']);
    const first = ensureIcons([item('e2e', 'playwright test')]);
    await vi.waitFor(() => expect(asked()).toHaveLength(1));
    await ensureIcons([item('test', 'vitest'), item('shot', 'node shot.mjs'), item('e2e', 'playwright test')]);
    expect(asked()).toHaveLength(1);
    answer(['lucide:mouse-pointer-click']);
    await first;
    expect(asked())
      .toEqual([[item('e2e', 'playwright test')], [item('test', 'vitest'), item('shot', 'node shot.mjs')]]);
    expect(S.commandIcons[iconKey('shot', 'node shot.mjs')]).toBe('lucide:camera');
  });

  it('says once per launch that the AI failed, and does not ask about those commands again', async () => {
    vi.mocked(git.aiCommandIcons).mockRejectedValue({ kind: 'Ai', detail: 'claude CLI not found' });
    await ensureIcons([item('fmt', 'prettier -w .')]);
    await ensureIcons([item('fmt', 'prettier -w .'), item('deploy', './deploy.sh')]);
    expect(asked()).toEqual([[item('fmt', 'prettier -w .')], [item('deploy', './deploy.sh')]]);
    expect(S.toasts.map((t) => [t.kind, t.message]))
      .toEqual([['warn', 'Command icons not picked: claude CLI not found']]);
    expect(git.saveCommandIcons).not.toHaveBeenCalled();
  });
});
