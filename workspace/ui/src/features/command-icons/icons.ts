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

export type IconAsk<T> = {
  key(item: T): string;
  /** An item that has an icon already is not asked about. */
  has(item: T): boolean;
  ask(items: T[], sets: IconSet[]): Promise<(string | null)[]>;
  keep(picks: [T, string][]): Promise<void> | void;
  /** Names the ask in the log. */
  what: string;
  /** Leads the toast for the first failure in a launch; null where the item draws well enough without an icon. */
  warn: string | null;
};

/**
 * The function that asks about the items with no icon yet. One ask at a time, and items that come in meanwhile go in
 * the next. A key is asked about once per launch: an ask that failed, or got no icon back, waits for the next launch.
 * No epoch: a pick is keyed by the item's own text, so one that lands late is still right. A quiet call's items never
 * lead to the toast.
 */
export function iconAsker<T>(k: IconAsk<T>): (items: readonly T[], opts?: { quiet?: boolean }) => Promise<void> {
  const asked = new Set<string>();
  const loud = new Set<string>();
  let queue: T[] = [];
  let asking = false;
  let warned = false;
  const fresh = (it: T) => !asked.has(k.key(it)) && !k.has(it);

  async function ask(items: T[]): Promise<void> {
    let got: (string | null)[];
    try {
      got = await k.ask(items, offered);
    } catch (e) {
      logError(e, k.what);
      if (k.warn !== null && !warned && items.some((it) => loud.has(k.key(it)))) {
        warned = true;
        toast(`${k.warn}: ${errText(e)}`, 'warn');
      }
      return;
    }
    const picks = items.flatMap((it, i): [T, string][] => {
      const id = got[i];
      return id ? [[it, id]] : [];
    });
    if (picks.length) await k.keep(picks);
  }

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

  return async (items, { quiet = false } = {}) => {
    // checked before the sets load, since loading them is the only real cost
    if (S.settings['general.headless-ai-provider'] === 'off' || !items.some(fresh)) return;
    try {
      await loadIconSets();
    } catch (e) {
      logError(e, 'load icon sets');
      return;
    }
    for (const it of items) {
      if (!fresh(it)) continue;
      asked.add(k.key(it));
      if (!quiet) loud.add(k.key(it));
      queue.push(it);
    }
    if (!asking) await drain();
  };
}

/** One for the command menu and the terminal rail, so a line both show is asked about once. */
const askCommands = iconAsker<IconItem>({
  key: (it) => iconKey(it.name, it.command),
  has: (it) => Object.hasOwn(S.commandIcons, iconKey(it.name, it.command)),
  ask: (items, sets) => git.aiCommandIcons(items.map(({ name, command }) => ({ name, command })), sets),
  keep: async (picks) => {
    const got = Object.fromEntries(picks.map(([it, id]) => [iconKey(it.name, it.command), id]));
    S.commandIcons = { ...S.commandIcons, ...got };
    notify();
    try {
      await git.saveCommandIcons(got);
    } catch (e) {
      logError(e, 'save command icons');
    }
  },
  what: 'pick command icons',
  warn: 'Command icons not picked',
});

/** `quiet` is for the terminal rail: a terminal keeps its number without an icon, and the rail is on screen at every
 *  launch, so its failures would be said every time. */
export async function ensureIcons(items: readonly IconItem[], { quiet = false } = {}): Promise<void> {
  try {
    await Promise.all([loadIconSets(), readPicks()]);
  } catch (e) {
    logError(e, 'load icon sets');
    return;
  }
  await askCommands(items, { quiet });
}

/** The user's pick, else the AI's; null while the sets load. */
export function pickedGlyph(
  picks: Readonly<Record<string, string>>, it: { name: string; command: string; icon: string | null },
): Glyph | null {
  return glyph(it.icon) ?? glyph(picks[iconKey(it.name, it.command)] ?? null);
}
