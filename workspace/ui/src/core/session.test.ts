import { undo } from '@codemirror/commands';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeFile, flush, openPlain, openRepo, openRow, quit, refresh, view, viewChanges } from '#core/session';
import type { FileText } from '#ipc/git';
import { choiceDialog, confirmDialog } from '#kernel/dialogs';
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
  return { ...actual, confirmDialog: vi.fn(), choiceDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;
const choiceMock = vi.mocked(choiceDialog);
const B = { section: 'unstaged', path: 'b.txt', letter: 'M', untracked: false, conflicted: false } as const;

beforeAll(mountApp);

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  choiceMock.mockReset().mockResolvedValue(null);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
});

describe('unsaved changes', () => {
  it('stay unsaved, with nothing written, until Save writes them over the text they started from', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    await new Promise((r) => setTimeout(r, 400));
    expect(S.open!.dirty).toBe(true);
    expect(g.writeFile!).not.toHaveBeenCalled();

    expect(await flush()).toBe(true);

    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.open!.dirty).toBe(false);
    expect(S.open!.baseline).toBe('mine\n');
  });

  it('are gone again once undo brings back the saved text', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    expect(S.open!.dirty).toBe(true);
    undo(view);
    expect(view.state.doc.toString()).toBe('disk\n');
    expect(S.open!.dirty).toBe(false);
  });

  it('stay unsaved, with the pill up, when the save comes back Stale', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });

    expect(await flush()).toBe(false);

    expect(S.open!.dirty).toBe(true);
    expect(S.open!.badge).toEqual(file('agent\n'));
  });
});

describe('leaving a file with unsaved changes', () => {
  beforeEach(async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    g.readBlob!.mockResolvedValue(blob('b index\n'));
    g.readFile!.mockResolvedValue(file('b disk\n'));
  });

  it('asks first, and Cancel keeps the file open with its changes', async () => {
    await openRow(B);
    expect(choiceMock).toHaveBeenCalledWith(
      "Do you want to save the changes you made to a.txt?\nYour changes will be lost if you don't save them.",
      'Save', "Don't Save");
    expect(S.open!.path).toBe('a.txt');
    expect(view.state.doc.toString()).toBe('mine\n');
    expect(g.readBlob!).not.toHaveBeenCalled();
  });

  it("opens the next file without writing on Don't Save", async () => {
    choiceMock.mockResolvedValue('alt');
    await openRow(B);
    expect(S.open!.path).toBe('b.txt');
    expect(g.writeFile!).not.toHaveBeenCalled();
  });

  it('writes the changes, then opens the next file, on Save', async () => {
    choiceMock.mockResolvedValue('ok');
    await openRow(B);
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.open!.path).toBe('b.txt');
  });

  it('stays on the file, with the pill up, when the Save comes back Stale', async () => {
    choiceMock.mockResolvedValue('ok');
    g.writeFile!.mockRejectedValue({ kind: 'Stale', detail: file('agent\n') });
    await openRow(B);
    expect(S.open!.path).toBe('a.txt');
    expect(S.open!.badge).toEqual(file('agent\n'));
    expect(S.toasts.at(-1)).toMatchObject({ kind: 'warn' });
  });

  it('carries them into another view of the same file without asking, undo history included', async () => {
    g.readFile!.mockResolvedValue(file('disk\n'));
    await openPlain('a.txt');
    expect(choiceMock).not.toHaveBeenCalled();
    expect(S.open).toMatchObject({ view: 'plain', dirty: true, baseline: 'disk\n', badge: null });
    expect(view.state.doc.toString()).toBe('mine\n');
    undo(view);
    expect(view.state.doc.toString()).toBe('disk\n');
    expect(S.open!.dirty).toBe(false);
  });

  it('puts up the pill on the carried buffer when the disk moved meanwhile', async () => {
    g.readFile!.mockResolvedValue(file('agent\n'));
    await openPlain('a.txt');
    expect(view.state.doc.toString()).toBe('mine\n');
    expect(S.open!.badge).toEqual(file('agent\n'));
  });

  it('keeps them where they were when the other view of the same file fails to open', async () => {
    g.readFile!.mockRejectedValue({ kind: 'TooLarge' });
    await openPlain('a.txt');
    expect(S.open).toMatchObject({ view: 'unstaged', dirty: true, panel: null });
    expect(view.state.doc.toString()).toBe('mine\n');
    expect(S.selected).toBe('unstaged:a.txt');
    expect(S.toasts.at(-1)).toMatchObject({ kind: 'err' });
  });

  it('moves the baseline of the view that took them over when a save started meanwhile lands', async () => {
    let read!: (f: FileText) => void;
    let wrote!: () => void;
    g.readFile!.mockReturnValueOnce(new Promise((r) => { read = r; }));
    g.writeFile!.mockReturnValueOnce(new Promise((r) => { wrote = () => r(undefined); }));
    const opening = openPlain('a.txt');
    await tick();
    const saving = flush();
    read(file('disk\n'));
    await opening;
    expect(S.open).toMatchObject({ view: 'plain', baseline: 'disk\n', dirty: true });

    wrote();
    expect(await saving).toBe(true);
    expect(S.open).toMatchObject({ view: 'plain', baseline: 'mine\n', dirty: false });
  });

  it('clears the pill the other view read off that same save, and passes a Stale answer on to it', async () => {
    let read!: (f: FileText) => void;
    let wrote!: () => void;
    g.readFile!.mockReturnValueOnce(new Promise((r) => { read = r; }));
    g.writeFile!.mockReturnValueOnce(new Promise((r) => { wrote = () => r(undefined); }));
    let opening = openPlain('a.txt');
    await tick();
    let saving = flush();
    read(file('mine\n'));
    await opening;
    expect(S.open!.badge).toEqual(file('mine\n'));
    wrote();
    await saving;
    expect(S.open).toMatchObject({ view: 'plain', baseline: 'mine\n', dirty: false, badge: null });

    type('more\n');
    let refused!: () => void;
    g.readFile!.mockReturnValueOnce(new Promise((r) => { read = r; }));
    g.writeFile!.mockReturnValueOnce(new Promise((_, no) => {
      refused = () => no({ kind: 'Stale', detail: file('agent\n') });
    }));
    opening = openRow({ ...B, path: 'a.txt' });
    await tick();
    saving = flush();
    read(file('mine\n'));
    await opening;
    refused();
    expect(await saving).toBe(false);
    expect(S.open).toMatchObject({ view: 'unstaged', dirty: true, badge: file('agent\n') });
  });

  it('holds the answer for the view a refresh moved them to while the dialog was open', async () => {
    choiceMock.mockImplementation(async () => {
      g.readFile!.mockResolvedValueOnce(file('disk\n'));
      await openPlain('a.txt');
      return 'ok';
    });
    await openRow(B);
    expect(g.writeFile!).toHaveBeenCalledWith('a.txt', 'mine\n', 'lf', 'disk\n');
    expect(S.open!.path).toBe('b.txt');
  });

  it('asks before the staged view of the same file, which shows the index instead', async () => {
    await openRow({ ...B, section: 'staged', path: 'a.txt' });
    expect(choiceMock).toHaveBeenCalledOnce();
    expect(S.open!.view).toBe('unstaged');
  });

  it('asks before the file closes', async () => {
    expect(await closeFile()).toBe(false);
    expect(choiceMock).toHaveBeenCalledOnce();
    expect(S.open!.path).toBe('a.txt');
  });

  it('asks before switching repos, and Cancel stays on this one', async () => {
    await openRepo('/Users/me/repos/other');
    expect(choiceMock).toHaveBeenCalledOnce();
    expect(g.openRepo!).not.toHaveBeenCalled();
  });
});

describe('a clean file', () => {
  it('hands keystrokes typed while another view of it loads over to that view', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    let read!: (f: FileText) => void;
    g.readFile!.mockReturnValueOnce(new Promise((r) => { read = r; }));
    const opening = openPlain('a.txt');
    await tick();
    type('typed\n');
    read(file('disk\n'));
    await opening;
    expect(choiceMock).not.toHaveBeenCalled();
    expect(S.open).toMatchObject({ view: 'plain', dirty: true, baseline: 'disk\n' });
    expect(view.state.doc.toString()).toBe('typed\n');
  });
});

describe('an unsaved conflict resolution', () => {
  const CONFLICT = { ...B, path: 'a.txt', letter: '!', conflicted: true };

  beforeEach(async () => {
    S.status = status('a.txt', 'U', 'U', false, true);
    g.status!.mockResolvedValue(S.status);
    g.readFile!.mockResolvedValue(file('<<<<<<< ours\n'));
    await openRow(CONFLICT);
    type('resolved\n');
  });

  it('moves into the Unstaged view, cursor and all, with the refresh that sees it staged elsewhere', async () => {
    view.dispatch({ selection: { anchor: 4 } });
    g.status!.mockResolvedValue(status('a.txt'));
    g.readBlob!.mockResolvedValue(blob('index\n'));
    await refresh();
    expect(S.open).toMatchObject({ view: 'unstaged', conflicted: false, dirty: true, badge: null });
    expect(view.state.doc.toString()).toBe('resolved\n');
    expect(view.state.selection.main.head).toBe(4);
  });

  it('gets no changed-on-disk pill in the Plain view while the disk has not moved, and goes back', async () => {
    await openPlain('a.txt');
    await refresh();
    expect(S.open).toMatchObject({ view: 'plain', dirty: true, badge: null });

    await viewChanges('a.txt');
    expect(S.open).toMatchObject({ conflicted: true, dirty: true, panel: null });
    expect(view.state.doc.toString()).toBe('resolved\n');
  });
});

describe('quitting', () => {
  it('quits at once with nothing unsaved', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    await quit();
    expect(choiceMock).not.toHaveBeenCalled();
    expect(g.quit!).toHaveBeenCalledOnce();
  });

  it("asks first: Cancel keeps the app open, Don't Save quits without writing", async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    await quit();
    expect(g.quit!).not.toHaveBeenCalled();

    choiceMock.mockResolvedValue('alt');
    await quit();
    expect(g.quit!).toHaveBeenCalledOnce();
    expect(g.writeFile!).not.toHaveBeenCalled();
  });
});

describe('a paneled record', () => {
  it('is reopened by the next refresh into an editor that still tracks unsaved changes', async () => {
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
  it('saves on Save, clears the record, and blanks the editor', async () => {
    await openUnstaged('a.txt', blob('index\n'), file('disk\n'));
    type('mine\n');
    choiceMock.mockResolvedValue('ok');
    await tick();

    document.querySelector<HTMLButtonElement>('.tbar [aria-label="Close file (unsaved changes)"]')!.click();
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
