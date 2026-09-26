import { listen as onEvent } from '@tauri-apps/api/event';

export const listen = <T>(name: string, fn: (payload: T) => void): Promise<() => void> =>
  onEvent<T>(name, (e) => fn(e.payload));
