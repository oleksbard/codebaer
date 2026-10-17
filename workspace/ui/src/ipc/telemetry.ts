import { invoke } from '@tauri-apps/api/core';

/** The Rust `telemetry::Counter` names that only the webview sees happen; the backend counts the rest itself. */
export type Counter = 'hunk_accepted' | 'hunk_rejected' | 'file_accepted' | 'file_rejected';

export const telemetry = {
  /** False when this build or the environment never sends, whatever the setting says. */
  available: () => invoke<boolean>('telemetry_available'),
  /** True once, from the third launch on, while sharing is off and the user has not answered yet. */
  promptDue: () => invoke<boolean>('telemetry_prompt'),
  answered: (share: boolean) => invoke<void>('telemetry_answered', { share }),
};

/** The backend drops it while sharing is off. Never throws: a count must not break the action it counts. */
export function count(counter: Counter): void {
  try {
    invoke('telemetry_count', { counter }).catch(() => {});
  } catch {
    // no host, as in unit tests
  }
}
