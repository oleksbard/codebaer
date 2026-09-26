import { useSyncExternalStore } from 'react';
import type { Item } from './pick';

export type ToastKind = 'info' | 'ok' | 'warn' | 'err';
export type Toast = { id: number; message: string; kind: ToastKind };
/** `id` keys the palette component so a request that replaces an open one starts with an empty filter. */
export type PaletteRequest = { id: number; items: Item<unknown>[]; placeholder: string; resolve(v: unknown): void };
export type ConfirmRequest = { message: string; error?: boolean; resolve(ok: boolean): void };
export type PromptRequest = { placeholder: string; resolve(value: string | null): void };

/** core/state.ts, each feature's state.ts and app/state.ts add their fields by declaration merging;
 *  app/state.ts sets them all. */
export interface State {
  palette: PaletteRequest | null;
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  toasts: Toast[];
  chord: boolean;
}

const kernel: Pick<State, 'palette' | 'confirm' | 'prompt' | 'toasts' | 'chord'> =
  { palette: null, confirm: null, prompt: null, toasts: [], chord: false };
export const S = kernel as State;

/** What a component gets from useApp(): a write has to go through an action. */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<K, DeepReadonly<V>>
      : T extends ReadonlySet<infer V> ? ReadonlySet<DeepReadonly<V>>
        : T extends readonly (infer E)[] ? readonly DeepReadonly<E>[]
          : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
            : T;

/** DOM nodes actions focus; components register them in ref callbacks. */
export const refs = {
  commit: null as HTMLTextAreaElement | null,
  list: null as HTMLElement | null,
};

// ponytail: one version counter re-renders the whole shell; per-slice selectors if re-render cost is ever measured
let version = 0;
const listeners = new Set<() => void>();

export function notify(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const snapshot = () => version;

export function useApp(): DeepReadonly<State> {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return S;
}
