import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guarded, openRepo, openRow, refresh, view } from '#core/session';
import { git } from '#ipc/git';
import { confirmDialog } from '#kernel/dialogs';
import { checkCwd } from '#ipc/terminal';
import { S } from '#kernel/store';
import { blob, file, g, mountApp, openUnstaged, status, type } from '#test-app';
import { tick } from '#test-setup';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
});

describe('autosave flush before a flush-set command', () => {
  it('abandons the command when the pre-flush comes back Stale', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    expect(S.open!.dirty).toBe(true);
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });

    await guarded('stagePath', () => git.stagePath('a.txt'));

    expect(g.writeFile!).toHaveBeenCalledTimes(1);
    expect(g.stagePath!).not.toHaveBeenCalled();
    expect(S.open!.dirty).toBe(true);
    expect(S.open!.badge).toEqual(file('agent\n'));
  });

  it('writes the doc text first and runs the command only after the write resolves', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    const order: string[] = [];
    g.writeFile!.mockImplementation(async () => { order.push('write'); });
    g.stagePath!.mockImplementation(async () => { order.push('stage'); });

    await guarded('stagePath', () => git.stagePath('a.txt'));

    expect(order).toEqual(['write', 'stage']);
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.open!.dirty).toBe(false);
  });
});

describe('a paneled record', () => {
  it('is reopened by the next refresh into an editor that still arms autosave', async () => {
    S.status = status('n.txt', '.', '.', true);
    g.status!.mockResolvedValue(S.status);
    g.readBlob!.mockRejectedValueOnce({ kind: 'Io', detail: 'boom' });
    await openRow({ section: 'unstaged', path: 'n.txt', letter: 'U', untracked: true, conflicted: false });
    expect(S.open!.panel).toBe('Io');

    g.readBlob!.mockResolvedValue(blob('', null));
    g.readFile!.mockResolvedValue(file('new\n'));
    await refresh();

    expect(S.open!.panel).toBe(null);
    type('typed\n');
    expect(S.open!.dirty).toBe(true);
  });

  it('whose path became unmerged is reopened into the conflict view', async () => {
    g.status!.mockResolvedValue(S.status);
    g.readBlob!.mockRejectedValueOnce({ kind: 'Io', detail: 'boom' });
    await openRow({ section: 'unstaged', path: 'a.txt', letter: 'M', untracked: false, conflicted: false });
    expect(S.open!.panel).toBe('Io');

    g.status!.mockResolvedValue(status('a.txt', 'U', 'U', false, true));
    g.readBlob!.mockClear().mockRejectedValue({ kind: 'Conflicted' });
    g.readFile!.mockResolvedValue(file('<<<<<<< ours\n'));
    await refresh();

    expect(S.open!.conflicted).toBe(true);
    expect(g.readBlob!).not.toHaveBeenCalled();
  });
});

describe('closing the open file', () => {
  it('writes a pending edit, clears the record, and blanks the editor', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');

    document.querySelector<HTMLButtonElement>('.tbar [aria-label="Close file"]')!.click();
    await vi.waitFor(() => expect(S.open).toBeNull());
    await tick();

    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.selected).toBeNull();
    expect(view.state.doc.toString()).toBe('');
    expect(document.querySelector('.blank')).not.toBeNull();
  });
});

describe('switching repos', () => {
  it('asks the terminal host to re-read every folder against the new root', async () => {
    const check = checkCwd as unknown as ReturnType<typeof vi.fn>;
    check.mockReset().mockResolvedValue(undefined);
    g.openRepo!.mockResolvedValue({ root: '/Users/me/repos/other', label: '~/repos/other', title: 'other' });
    await openRepo('/Users/me/repos/other');
    expect(S.root).toBe('/Users/me/repos/other');
    expect(S.rootLabel).toBe('~/repos/other');
    expect(check).toHaveBeenCalledOnce();
  });
});
