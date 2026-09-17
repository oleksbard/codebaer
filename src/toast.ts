import { notify, S, type ToastKind } from './app/store';

let nextId = 1;

export function toast(message: string, kind: ToastKind = 'info'): void {
  const id = nextId++;
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
    S.confirm = { message, resolve };
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

export function promptDialog(placeholder: string): Promise<string | null> {
  S.prompt?.resolve(null);
  return new Promise((resolve) => {
    S.prompt = { placeholder, resolve };
    notify();
  });
}
