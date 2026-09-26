import type { IconifyJSON } from '@iconify-json/lucide';
import { errText, git, type IconItem, type IconSet } from '#ipc/git';
import { logError } from '#ipc/log';
import { toast } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';

/** The same for a saved command and a package.json script, so one that runs the same line shares the pick. */
export const iconKey = (name: string, command: string): string => `${name}\n${command}`;

/** Sent with each list, so the AI knows what kind of icon it holds. */
const TITLES: Record<string, string> = {
  lucide: 'Lucide icons for actions and objects',
  'simple-icons': 'Simple Icons brand logos',
};

let sets: readonly IconifyJSON[] | null = null;
/** Every icon a set still offers; a hidden one was removed from it and is kept only so an old id still draws. */
let offered: IconSet[] = [];
let loading: Promise<void> | null = null;

/** About 5 MB between them, so they load on first use rather than with the app. */
export function loadIconSets(): Promise<void> {
  loading ??= Promise.all([import('@iconify-json/lucide'), import('@iconify-json/simple-icons')]).then((mods) => {
    sets = mods.map((m) => m.icons);
    offered = sets.map((s) => ({
      prefix: s.prefix,
      title: TITLES[s.prefix] ?? s.prefix,
      names: Object.keys(s.icons).filter((n) => !s.icons[n]?.hidden),
    }));
    notify();
  }, (e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

export type Glyph = { body: string; width: number; height: number };

/** Null while the sets load, and for an id neither set has. */
export function glyph(id: string | null): Glyph | null {
  const at = id?.indexOf(':') ?? -1;
  const set = id && at > 0 ? sets?.find((s) => s.prefix === id.slice(0, at)) : undefined;
  if (!id || !set) return null;
  let name = id.slice(at + 1);
  // a renamed icon stays as an alias, and an alias may point at another
  for (let hop = 0; hop < 4 && !set.icons[name]; hop++) name = set.aliases?.[name]?.parent ?? name;
  const icon = set.icons[name];
  if (!icon) return null;
  return { body: icon.body, width: icon.width ?? set.width ?? 16, height: icon.height ?? set.height ?? 16 };
}

export function searchIcons(query: string, limit: number): string[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '-');
  const first: string[] = [];
  const rest: string[] = [];
  for (const s of offered) {
    for (const n of s.names) {
      if (first.length >= limit) return first;
      const at = n.indexOf(q);
      if (at === 0) first.push(`${s.prefix}:${n}`);
      else if (at > 0 && rest.length < limit) rest.push(`${s.prefix}:${n}`);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

let picksRead: Promise<void> | null = null;

function readPicks(): Promise<void> {
  picksRead ??= git.commandIcons().then((picks) => {
    // a pick that arrived while the file was being read is newer than the file
    S.commandIcons = { ...picks, ...S.commandIcons };
    notify();
  }, (e: unknown) => {
    picksRead = null;
    logError(e, 'read command icons');
  });
  return picksRead;
}

/** Keys asked about in this launch: an ask that failed, or got no icon back, waits for the next launch. */
const asked = new Set<string>();
let queue: IconItem[] = [];
let asking = false;
let warned = false;

export async function ensureIcons(items: readonly IconItem[]): Promise<void> {
  try {
    await Promise.all([loadIconSets(), readPicks()]);
  } catch (e) {
    logError(e, 'load icon sets');
    return;
  }
  if (S.settings['general.headless-ai-provider'] === 'off') return;
  for (const { name, command } of items) {
    const key = iconKey(name, command);
    if (Object.hasOwn(S.commandIcons, key) || asked.has(key)) continue;
    asked.add(key);
    queue.push({ name, command });
  }
  if (!asking) await drain();
}

/** One ask at a time; items queued meanwhile go in the next. No epoch: a pick is keyed by the command's own text,
 *  so one that lands late is still right. */
async function drain(): Promise<void> {
  asking = true;
  try {
    while (queue.length) {
      const items = queue;
      queue = [];
      await ask(items);
    }
  } finally {
    asking = false;
  }
}

async function ask(items: IconItem[]): Promise<void> {
  let got: (string | null)[];
  try {
    got = await git.aiCommandIcons(items, offered);
  } catch (e) {
    logError(e, 'pick command icons');
    if (!warned) toast(`Command icons not picked: ${errText(e)}`, 'warn');
    warned = true;
    return;
  }
  const picks: Record<string, string> = {};
  items.forEach((it, i) => {
    const id = got[i];
    if (id) picks[iconKey(it.name, it.command)] = id;
  });
  if (!Object.keys(picks).length) return;
  S.commandIcons = { ...S.commandIcons, ...picks };
  notify();
  try {
    await git.saveCommandIcons(picks);
  } catch (e) {
    logError(e, 'save command icons');
  }
}
