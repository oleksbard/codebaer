import { invoke } from '@tauri-apps/api/core';

const detail = (e: unknown): string => (e instanceof Error ? e.stack ?? `${e.name}: ${e.message}` : String(e));

/** The webview's only durable trace of a failure: a toast is gone before it can be copied, and
 *  devtools has to have been open at the time to have caught anything. */
export function logError(e: unknown, context?: string): void {
  const message = context ? `${context}: ${detail(e)}` : detail(e);
  try {
    invoke('log_error', { message }).catch(() => {});
  } catch {
    // no host to log to, and throwing from here would take out the handler that called it
  }
}

/** Whatever never reached a try/catch: a render that threw, a dropped promise, a listener. */
export function installErrorLog(): void {
  globalThis.addEventListener('error', (e) => logError(e.error ?? e.message));
  globalThis.addEventListener('unhandledrejection', (e) => logError(e.reason, 'unhandled rejection'));
}
