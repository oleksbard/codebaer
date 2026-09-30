import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logError } from '#ipc/log';
import { S } from './store';
import { closeConfirm, closePrompt, holdToast, removeToast, toast, updateToast } from './dialogs';

vi.mock('#ipc/log', async () => {
  const actual = await vi.importActual<typeof import('#ipc/log')>('#ipc/log');
  return { ...actual, logError: vi.fn() };
});

beforeEach(() => {
  vi.useFakeTimers();
  S.toasts = [];
  vi.mocked(logError).mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('toast', () => {
  it('returns its id, and clears itself after 6s', () => {
    const id = toast('hi');
    expect(S.toasts).toEqual([{ id, message: 'hi', kind: 'info' }]);
    vi.advanceTimersByTime(6000);
    expect(S.toasts).toEqual([]);
  });

  it('leaves an error toast until it is clicked', () => {
    const id = toast('bad', 'err');
    vi.advanceTimersByTime(60_000);
    expect(S.toasts.map((t) => t.id)).toEqual([id]);
    removeToast(id);
    expect(S.toasts).toEqual([]);
  });
});

describe('updateToast', () => {
  it('changes the toast in place and restarts its countdown', () => {
    const id = toast('working');
    vi.advanceTimersByTime(5000);
    expect(updateToast(id, 'done', 'ok')).toBe(id);
    expect(S.toasts).toEqual([{ id, message: 'done', kind: 'ok' }]);
    // the old timer would have gone off by 6000ms from the first toast; the restart buys it another 6s
    vi.advanceTimersByTime(5999);
    expect(S.toasts).toEqual([{ id, message: 'done', kind: 'ok' }]);
    vi.advanceTimersByTime(1);
    expect(S.toasts).toEqual([]);
  });

  it('shows a new toast, with a new id, when the one it names is already gone', () => {
    const id = toast('working');
    removeToast(id);
    const id2 = updateToast(id, 'done');
    expect(id2).not.toBe(id);
    expect(S.toasts).toEqual([{ id: id2, message: 'done', kind: 'info' }]);
  });

  it('stops the countdown for an error', () => {
    const id = toast('working');
    updateToast(id, 'failed', 'err');
    vi.advanceTimersByTime(60_000);
    expect(S.toasts).toEqual([{ id, message: 'failed', kind: 'err' }]);
  });

  it('logs an error the same way toast() does, when it turns a toast into one', () => {
    const id = toast('working');
    updateToast(id, 'failed', 'err');
    expect(logError).toHaveBeenCalledWith('failed');
  });

  it('keeps a held toast held: the message changes but the countdown does not resume', () => {
    const id = toast('working');
    holdToast(id, true);
    expect(updateToast(id, 'still working')).toBe(id);
    vi.advanceTimersByTime(60_000);
    expect(S.toasts).toEqual([{ id, message: 'still working', kind: 'info' }]);
    holdToast(id, false);
    vi.advanceTimersByTime(5999);
    expect(S.toasts).toEqual([{ id, message: 'still working', kind: 'info' }]);
    vi.advanceTimersByTime(1);
    expect(S.toasts).toEqual([]);
  });
});

describe('holdToast', () => {
  it('pauses the countdown while held, and resumes it with the time that was left', () => {
    const id = toast('hi');
    vi.advanceTimersByTime(4000);
    holdToast(id, true);
    vi.advanceTimersByTime(10_000);
    expect(S.toasts.map((t) => t.id)).toEqual([id]);
    holdToast(id, false);
    vi.advanceTimersByTime(1999);
    expect(S.toasts.map((t) => t.id)).toEqual([id]);
    vi.advanceTimersByTime(1);
    expect(S.toasts).toEqual([]);
  });

  it('is a no-op for a toast that is not there, or held twice in a row', () => {
    const id = toast('hi');
    holdToast(999, true);
    holdToast(id, true);
    holdToast(id, true);
    vi.advanceTimersByTime(60_000);
    expect(S.toasts.map((t) => t.id)).toEqual([id]);
  });
});

describe('closeConfirm', () => {
  it('resolves once and clears the field; a second call for the same request (a key or click that lands '
    + 'while the dialog is still fading out) is a no-op', () => {
    const resolve = vi.fn();
    S.confirm = { id: 0, message: 'Discard?', resolve };
    const req = S.confirm;
    closeConfirm(req, true);
    expect(S.confirm).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(true);
    closeConfirm(req, false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a request a newer one already replaced', () => {
    const first = vi.fn();
    S.confirm = { id: 0, message: 'a', resolve: first };
    const stale = S.confirm;
    const fresh = { id: 1, message: 'b', resolve: vi.fn() };
    S.confirm = fresh;
    closeConfirm(stale, true);
    expect(first).not.toHaveBeenCalled();
    expect(S.confirm).toBe(fresh);
  });
});

describe('closePrompt', () => {
  it('resolves once and clears the field; a second call for the same request is a no-op', () => {
    const resolve = vi.fn();
    S.prompt = { id: 0, placeholder: 'x', wide: false, resolve };
    const req = S.prompt;
    closePrompt(req, 'name');
    expect(S.prompt).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('name');
    closePrompt(req, null);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
