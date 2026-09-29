import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQueue } from '#core/model';
import { openPlain } from '#core/session';
import type { Status } from '#ipc/git';
import { choiceDialog } from '#kernel/dialogs';
import { S } from '#kernel/store';
import { blob, file, g, mountApp, openUnstaged, status, type } from '#test-app';
import { tick } from '#test-setup';
import { showChanges } from './changes-tab';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, choiceDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const choiceMock = vi.mocked(choiceDialog);

const twoToReview = (): Status => ({ ...status('a.txt'), files: [...status('b.txt').files, ...status('a.txt').files] });

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  choiceMock.mockReset().mockResolvedValue(null);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.tab = 'changes';
});

describe('coming to the Changes tab', () => {
  it('opens the first file left to review in place of a file opened from the Files tab', async () => {
    S.status = twoToReview();
    g.readFile!.mockResolvedValue(file('text\n'));
    await openPlain('README.md');
    S.tab = 'files';
    g.readBlob!.mockResolvedValue(blob('index\n'));

    await showChanges();

    const first = buildQueue(S.status).unstaged[0]!;
    expect(S.tab).toBe('changes');
    expect(S.open).toMatchObject({ path: first.path, view: 'unstaged' });
    expect(S.selected).toBe(`unstaged:${first.path}`);
  });

  it('opens the first file left to review when none is open', async () => {
    S.status = twoToReview();
    S.tab = 'terminals';
    g.readBlob!.mockResolvedValue(blob('index\n'));
    g.readFile!.mockResolvedValue(file('work\n'));

    await showChanges();

    expect(S.open?.path).toBe(buildQueue(S.status).unstaged[0]!.path);
  });

  it('keeps a file from the queue open, even when it is not the first', async () => {
    S.status = twoToReview();
    const second = buildQueue(S.status).unstaged[1]!;
    await openUnstaged(second.path, blob('index\n'), file('work\n'));
    S.tab = 'terminals';

    await showChanges();

    expect(S.open?.path).toBe(second.path);
    expect(g.readFile).not.toHaveBeenCalled();
  });

  it('closes a file opened elsewhere and says nothing is left when the queue has nothing to review', async () => {
    S.status = status('a.txt', 'M', '.');
    g.readFile!.mockResolvedValue(file('text\n'));
    await openPlain('README.md');
    S.tab = 'files';

    await showChanges();
    await tick();

    expect(S.open).toBeNull();
    expect(document.querySelector('.blank h2')?.textContent).toBe('Nothing left to review');
  });

  it('leaves the open file alone while the Changes tab is already showing', async () => {
    S.status = twoToReview();
    g.readFile!.mockResolvedValue(file('text\n'));
    await openPlain('README.md');
    g.readFile!.mockClear();

    await showChanges();

    expect(S.open).toMatchObject({ path: 'README.md', view: 'plain' });
    expect(g.readFile).not.toHaveBeenCalled();
  });

  it('asks about unsaved changes first, and Cancel keeps the file in the tab it was open in', async () => {
    S.status = twoToReview();
    g.readFile!.mockResolvedValue(file('text\n'));
    await openPlain('README.md');
    type('edited\n');
    S.tab = 'files';
    const open = S.open;

    await showChanges();

    expect(choiceMock).toHaveBeenCalledOnce();
    expect(S.open).toBe(open);
    expect(S.open?.dirty).toBe(true);
    expect(S.tab).toBe('files');
  });

  it("opens the first file left to review after Don't Save, asking only once", async () => {
    S.status = twoToReview();
    g.readFile!.mockResolvedValue(file('text\n'));
    await openPlain('README.md');
    type('edited\n');
    S.tab = 'files';
    choiceMock.mockResolvedValue('alt');
    g.readBlob!.mockResolvedValue(blob('index\n'));

    await showChanges();

    expect(choiceMock).toHaveBeenCalledOnce();
    expect(S.tab).toBe('changes');
    expect(S.open?.path).toBe(buildQueue(S.status).unstaged[0]!.path);
    expect(g.writeFile).not.toHaveBeenCalled();
  });

  it('with nothing left to review, Cancel on the save prompt keeps the file in the tab it was open in', async () => {
    S.status = status('a.txt', 'M', '.');
    g.readFile!.mockResolvedValue(file('text\n'));
    await openPlain('README.md');
    type('edited\n');
    S.tab = 'files';
    const open = S.open;

    await showChanges();

    expect(choiceMock).toHaveBeenCalledOnce();
    expect(S.open).toBe(open);
    expect(S.tab).toBe('files');
  });
});
