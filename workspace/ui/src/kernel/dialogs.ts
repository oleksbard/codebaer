import { logError } from '#ipc/log';
import { notify, S, type ConfirmRequest, type DeepReadonly, type PromptRequest, type ToastKind } from './store';

let nextId = 1;
const TOAST_MS = 6000;

/** A running toast's countdown: `handle` is null while `holdToast` has it paused. */
type Timer = { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number };
const timers = new Map<number, Timer>();

function schedule(id: number, ms: number): void {
  const handle = setTimeout(() => removeToast(id), ms);
  timers.set(id, { handle, remaining: ms, startedAt: Date.now() });
}

export function toast(message: string, kind: ToastKind = 'info'): number {
  const id = nextId++;
  // every error the user is shown outlives the toast they cannot copy before it goes
  if (kind === 'err') logError(message);
  S.toasts = [...S.toasts, { id, message, kind }];
  notify();
  if (kind !== 'err') schedule(id, TOAST_MS);
  return id;
}

/** Changes a toast already on screen and restarts its countdown; shows a new toast, with a new id, when it is
 *  already gone. */
export function updateToast(id: number, message: string, kind: ToastKind = 'info'): number {
  if (!S.toasts.some((t) => t.id === id)) return toast(message, kind);
  if (kind === 'err') logError(message);
  S.toasts = S.toasts.map((t) => (t.id === id ? { ...t, message, kind } : t));
  notify();
  const timer = timers.get(id);
  // held (the pointer is over it): stays held, so the message change does not hand it back a running timer
  const held = timer?.handle === null;
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
  if (kind === 'err') return id;
  if (held) timers.set(id, { handle: null, remaining: TOAST_MS, startedAt: Date.now() });
  else schedule(id, TOAST_MS);
  return id;
}

/** Pauses a toast's countdown while the pointer is over it, and resumes it with the time that was left. */
export function holdToast(id: number, held: boolean): void {
  const timer = timers.get(id);
  if (!timer) return;
  if (held) {
    if (!timer.handle) return;
    clearTimeout(timer.handle);
    timer.remaining -= Date.now() - timer.startedAt;
    timer.handle = null;
  } else if (!timer.handle) {
    schedule(id, Math.max(0, timer.remaining));
  }
}

export function removeToast(id: number): void {
  if (!S.toasts.some((t) => t.id === id)) return;
  S.toasts = S.toasts.filter((t) => t.id !== id);
  notify();
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
}

export function confirmDialog(message: string): Promise<boolean> {
  S.confirm?.resolve(false);
  return new Promise((resolve) => {
    S.confirm = { id: nextId++, message, resolve: (a) => resolve(a === true) };
    notify();
  });
}

/** OK, `alt` or Cancel, as 'ok', 'alt' or null. */
export function choiceDialog(message: string, ok: string, alt: string): Promise<'ok' | 'alt' | null> {
  S.confirm?.resolve(false);
  return new Promise((resolve) => {
    S.confirm = {
      id: nextId++, message, ok, alt, resolve: (a) => resolve(a === true ? 'ok' : a === 'alt' ? 'alt' : null),
    };
    notify();
  });
}

/** Git failures are long and worth reading; a dialog blocks until it is dismissed, a toast does not. */
export function errorDialog(message: string): Promise<void> {
  S.confirm?.resolve(false);
  return new Promise((resolve) => {
    S.confirm = { id: nextId++, message, error: true, resolve: () => resolve() };
    notify();
  });
}

/** `wide` is for a value that runs long, such as a branch name made from an issue title. */
export function promptDialog(placeholder: string, wide = false): Promise<string | null> {
  S.prompt?.resolve(null);
  return new Promise((resolve) => {
    S.prompt = { id: nextId++, placeholder, wide, resolve };
    notify();
  });
}

export function closeConfirm(req: DeepReadonly<ConfirmRequest>, answer: boolean | 'alt'): void {
  // Radix reports the close after our OK handler already resolved, so the second call is a no-op
  if (S.confirm !== req) return;
  S.confirm = null;
  notify();
  req.resolve(answer);
}

export function closePrompt(req: DeepReadonly<PromptRequest>, value: string | null): void {
  if (S.prompt !== req) return;
  S.prompt = null;
  notify();
  req.resolve(value);
}
