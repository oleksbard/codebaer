import { logError } from '#ipc/log';
import { notify, S, type ConfirmRequest, type DeepReadonly, type PromptRequest, type ToastKind } from './store';

let nextId = 1;

export function toast(message: string, kind: ToastKind = 'info'): void {
  const id = nextId++;
  // every error the user is shown outlives the toast they cannot copy before it goes
  if (kind === 'err') logError(message);
  S.toasts = [...S.toasts, { id, message, kind }];
  notify();
  if (kind !== 'err') setTimeout(() => removeToast(id), 6000);
}

export function removeToast(id: number): void {
  if (!S.toasts.some((t) => t.id === id)) return;
  S.toasts = S.toasts.filter((t) => t.id !== id);
  notify();
}

export function confirmDialog(message: string): Promise<boolean> {
  S.confirm?.resolve(false);
  return new Promise((resolve) => {
    S.confirm = { message, resolve: (a) => resolve(a === true) };
    notify();
  });
}

/** OK, `alt` or Cancel, as 'ok', 'alt' or null. */
export function choiceDialog(message: string, ok: string, alt: string): Promise<'ok' | 'alt' | null> {
  S.confirm?.resolve(false);
  return new Promise((resolve) => {
    S.confirm = { message, ok, alt, resolve: (a) => resolve(a === true ? 'ok' : a === 'alt' ? 'alt' : null) };
    notify();
  });
}

/** Git failures are long and worth reading; a dialog blocks until it is dismissed, a toast does not. */
export function errorDialog(message: string): Promise<void> {
  S.confirm?.resolve(false);
  return new Promise((resolve) => {
    S.confirm = { message, error: true, resolve: () => resolve() };
    notify();
  });
}

/** `wide` is for a value that runs long, such as a branch name made from an issue title. */
export function promptDialog(placeholder: string, wide = false): Promise<string | null> {
  S.prompt?.resolve(null);
  return new Promise((resolve) => {
    S.prompt = { placeholder, wide, resolve };
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
