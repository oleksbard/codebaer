import type { ComponentType } from 'react';
import type { Extension } from '@codemirror/state';
import { listen } from '#ipc/events';
import { hintFor, keyLabel } from './keymap';
import { pick } from './pick';
import { S } from './store';

export type PaletteEntry = { label: string; hint?: string | undefined; run(): unknown };

export type Command = {
  id: string;
  /** Listed in the palette under this name. */
  label?: string;
  /** Show another command's binding as the palette hint, e.g. "Git: Commit" focuses the commit box and shows
   *  the commit box's own key. */
  hintOf?: string;
  /** Palette only: listed while this holds. A key or a menu item runs the command regardless. */
  when?(): boolean;
  /** Palette-only entries computed on open, listed right after this one, e.g. one per detected shell. */
  more?(): PaletteEntry[];
  run(): unknown;
};

export type Overlay = { id: string; isOpen(): boolean; component: ComponentType };

/** Something a feature asks the headless AI provider for, through the backend command `command`. `icon` is an
 *  icon id such as `lucide:shapes`. */
export type AiUse = { command: `ai_${string}`; label: string; icon: string };

export type Feature = {
  id: string;
  commands?: readonly Command[];
  events?: Readonly<Record<string, { run(payload: unknown): void; idleOnly?: boolean }>>;
  overlays?: readonly Overlay[];
  /** Added to every editor state core builds, in feature order. */
  editorExtensions?: readonly Extension[];
  /** After core opens a file into the shared view, in feature order. */
  onOpen?(): void;
  /** After every successful status read and before the open file is refreshed, in feature order. */
  onRefresh?(): void | Promise<void>;
  onRepoChange?: { confirm?(): Promise<boolean>; reset(): void };
  /** Listed by the headless AI provider option in Settings. */
  aiUses?: readonly AiUse[];
};

export const defineFeature = <const F extends Feature>(f: F): F => f;

type IdsOf<F> = F extends { readonly commands: readonly (infer C)[] }
  ? C extends { readonly id: infer I extends string } ? I : never
  : never;
/** Every command id the listed features register, for a table that must name real commands. */
export type CommandIds<L extends readonly Feature[]> = IdsOf<L[number]>;

let list: readonly Feature[] = [];
const commands = new Map<string, Command>();

/** The order is meaningful: the palette, the hooks and the repo-change confirms follow it. */
export function register(features: readonly Feature[]): void {
  list = features;
  commands.clear();
  for (const f of features) {
    for (const c of f.commands ?? []) {
      if (commands.has(c.id)) throw new Error(`command ${c.id} is registered twice`);
      commands.set(c.id, c);
    }
  }
}

export const features = (): readonly Feature[] => list;

/** An open overlay owns the keyboard; Radix handles its own Escape. `except` leaves one overlay out, for
 *  an opening that must not count its own dialog. */
export function idle(except?: string): boolean {
  return !S.palette && !S.confirm && !S.prompt
    && !list.some((f) => f.overlays?.some((o) => o.id !== except && o.isOpen()));
}

export function run(id: string): void {
  if (!idle()) return;
  void commands.get(id)?.run();
}

export const editorExtensions = (): Extension[] => list.flatMap((f) => f.editorExtensions ?? []);

export const aiUses = (): AiUse[] => list.flatMap((f) => f.aiUses ?? []);

export async function openPalette(): Promise<void> {
  const entries: PaletteEntry[] = [];
  for (const f of list) {
    for (const c of f.commands ?? []) {
      if (c.label === undefined || !(c.when?.() ?? true)) continue;
      const hint = c.hintOf === undefined ? hintFor(c.id) : keyLabel(c.hintOf);
      entries.push({ label: c.label, hint: hint || undefined, run: () => c.run() });
      entries.push(...(c.more?.() ?? []));
    }
  }
  const e = await pick(entries.map((x) => ({ label: x.label, hint: x.hint, value: x })), 'Type a command');
  if (e) void e.run();
}

/** A menu item reaches the webview even while an overlay owns the keyboard, where run() would have
 *  refused; `idleOnly` keeps that rule for the menu events. */
export async function listenAll(): Promise<void> {
  for (const f of list) {
    for (const [name, h] of Object.entries(f.events ?? {})) {
      await listen(name, (payload: unknown) => { if (!h.idleOnly || idle()) h.run(payload); });
    }
  }
}
