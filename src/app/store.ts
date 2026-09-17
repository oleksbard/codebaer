import { useSyncExternalStore } from 'react';
import type { Eol, FileText, Status } from '../git';
import type { ViewKind } from '../editor';
import type { Item } from '../palette';

export type Tab = 'changes' | 'files';

export type Open = {
  path: string;
  view: ViewKind;
  eol: Eol;
  baseline: string | null;
  originalOid: string | null;
  originalExists: boolean;
  docOid: string | null;
  dirty: boolean;
  badge: FileText | null;
  panel: string | null;
  conflicted: boolean;
};

export type ToastKind = 'info' | 'ok' | 'warn' | 'err';
export type Toast = { id: number; message: string; kind: ToastKind };
/** `id` keys the palette component so a request that replaces an open one starts with an empty filter. */
export type PaletteRequest = { id: number; items: Item<unknown>[]; placeholder: string; resolve(v: unknown): void };
export type ConfirmRequest = { message: string; error?: boolean; resolve(ok: boolean): void };
export type PromptRequest = { placeholder: string; resolve(value: string | null): void };

const storedWidth = localStorage.getItem('codebaer.sideWidth');

export const S = {
  root: null as string | null,
  status: null as Status | null,
  files: [] as string[],
  tab: 'changes' as Tab,
  open: null as Open | null,
  selected: null as string | null,
  refreshing: false,
  refreshAgain: false,
  saveTimer: 0 as ReturnType<typeof setTimeout> | 0,
  flushing: null as Promise<boolean> | null,
  openEpoch: 0,
  fatal: null as string | null,
  busy: false,
  cancellable: false,
  committing: false,
  sidebarHidden: localStorage.getItem('codebaer.sidebarHidden') === 'true',
  sideWidth: storedWidth ? Math.max(180, Number(storedWidth)) : null,
  chord: false,
  palette: null as PaletteRequest | null,
  confirm: null as ConfirmRequest | null,
  prompt: null as PromptRequest | null,
  toasts: [] as Toast[],
  aiBusy: false,
  commitMessage: '',
};

/** DOM nodes the controller focuses; components register them in ref callbacks. */
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

export function useApp(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
