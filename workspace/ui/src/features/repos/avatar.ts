import type { Glyph } from '#features/command-icons';

const KEY = 'codebaer.avatars';
/** Kept apart from the avatars, which forget a repo that leaves the recents: the user chose these. */
const PICKS = 'codebaer.repo-icons';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
const graphemes = new Intl.Segmenter();
const chars = (s: string): string[] => Array.from(graphemes.segment(s), (g) => g.segment);

export const HUES = ['blue', 'green', 'orange', 'pink', 'purple', 'red', 'yellow'] as const;
export type Hue = (typeof HUES)[number];

type Repo = { path: string; name: string };
/** The icon's own SVG rather than its id, so the header draws it without loading the 5 MB of icon sets. */
type Entry = { code: string; name: string; icon?: Glyph };
type Stored = Record<string, Entry>;
/** The user's icon, else the AI's; the code stands in while a repo has neither. */
export type Avatar = { code: string; icon: Glyph | null };
/** The user's own pick, with its id for the picker. */
export type Picked = Glyph & { id: string };

export function words(name: string): string[] {
  return name
    .replace(/^@[^/]*\//, '')
    // only Latin accents go: in Cyrillic, й and ї are letters of their own, not decorated ones
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

function* pairs(name: string): Generator<string> {
  const ws = words(name).map((w) => chars(w.toUpperCase()));
  const lead = ws[0]?.[0];
  if (lead) {
    const initials = ws.slice(1).map((w) => w[0]!);
    // names that share a first word ("bunch-platform", "bunch-portal") differ only in the later ones
    const later = ws.slice(1).flat();
    const rest = ws.flat().slice(1);
    const second = rest.slice(0, 1);
    const consonants = rest.filter((ch) => !VOWELS.has(ch));
    const vowels = rest.filter((ch) => VOWELS.has(ch));
    for (const t of [...initials, ...later, ...second, ...consonants, ...vowels, ...ALNUM]) yield lead + t;
  }
  for (const a of ALNUM) for (const b of ALNUM) yield a + b;
}

/**
 * Two-character codes for a name, best first. The name's first letter leads for as long as it can,
 * since that is what makes a monogram readable; the tail covers every pair, so it never runs out.
 */
export function* candidates(name: string): Generator<string> {
  const seen = new Set<string>();
  for (const c of pairs(name)) {
    if (seen.has(c)) continue;
    seen.add(c);
    yield c;
  }
}

function read(key: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function write(key: string, v: object): void {
  const json = JSON.stringify(v);
  if (localStorage.getItem(key) !== json) localStorage.setItem(key, json);
}

function glyphOf(v: unknown): Glyph | null {
  const g = v as Partial<Glyph> | null | undefined;
  if (typeof g?.body !== 'string' || typeof g.width !== 'number' || typeof g.height !== 'number') return null;
  return { body: g.body, width: g.width, height: g.height };
}

function load(): Stored {
  const out: Stored = {};
  for (const [path, v] of Object.entries(read(KEY))) {
    const e = v as { code?: unknown; name?: unknown; icon?: unknown } | null;
    if (typeof e?.code !== 'string' || typeof e.name !== 'string' || chars(e.code).length !== 2) continue;
    const entry: Entry = { code: e.code, name: e.name };
    const icon = glyphOf(e.icon);
    if (icon) entry.icon = icon;
    out[path] = entry;
  }
  return out;
}

function save(s: Stored): void {
  write(KEY, s);
}

function loadPicks(): Record<string, Picked> {
  const out: Record<string, Picked> = {};
  for (const [path, v] of Object.entries(read(PICKS))) {
    const g = glyphOf(v);
    const id = (v as { id?: unknown } | null)?.id;
    if (g && typeof id === 'string') out[path] = { id, ...g };
  }
  return out;
}

export function pickedIcon(path: string): Picked | null {
  return loadPicks()[path] ?? null;
}

/** Null hands the repo back to the AI's icon. */
export function keepPickedIcon(path: string, pick: Picked | null): void {
  const rest = Object.fromEntries(Object.entries(loadPicks()).filter(([p]) => p !== path));
  write(PICKS, pick ? { ...rest, [path]: pick } : rest);
}

/**
 * A code per repo, unique among the repos listed and every other repo remembered. A repo keeps its
 * code and its icon across calls, whatever the order, until its name changes or `forgetAvatars` drops it.
 */
export function avatars(repos: Repo[]): Map<string, Avatar> {
  const stored = load();
  const list = repos.filter((r, i) => repos.findIndex((x) => x.path === r.path) === i);
  const listed = new Set(list.map((r) => r.path));
  const taken = new Set(Object.entries(stored).filter(([p]) => !listed.has(p)).map(([, e]) => e.code));
  const got = new Map<string, string>();
  for (const r of list) {
    const e = stored[r.path];
    if (e?.name === r.name && !taken.has(e.code)) {
      got.set(r.path, e.code);
      taken.add(e.code);
    }
  }
  for (const r of list) {
    if (got.has(r.path)) continue;
    for (const c of candidates(r.name)) {
      if (taken.has(c)) continue;
      got.set(r.path, c);
      taken.add(c);
      // one that gave up its code to another repo keeps its icon; a new name waits for a new one
      const icon = stored[r.path]?.name === r.name ? stored[r.path]?.icon : undefined;
      stored[r.path] = icon ? { code: c, name: r.name, icon } : { code: c, name: r.name };
      break;
    }
  }
  save(stored);
  const picks = loadPicks();
  return new Map(list.map((r) => {
    const pick = picks[r.path];
    return [r.path, { code: got.get(r.path)!, icon: pick ? glyphOf(pick) : stored[r.path]?.icon ?? null }];
  }));
}

export function hasAvatarIcon(r: Repo): boolean {
  const e = load()[r.path];
  return e?.name === r.name && e.icon !== undefined;
}

/** Only onto the name it was picked for: a repo renamed while the AI thought waits for a pick of its own. */
export function setAvatarIcon(r: Repo, icon: Glyph): void {
  const stored = load();
  const e = stored[r.path];
  if (e?.name !== r.name) return;
  stored[r.path] = { ...e, icon };
  save(stored);
}

/** Drops every remembered repo not in `keep`, so a repo that left the recents stops holding its code. */
export function forgetAvatars(keep: string[]): void {
  const stored = load();
  const kept = new Set(keep);
  save(Object.fromEntries(Object.entries(stored).filter(([p]) => kept.has(p))));
}

export function hueOf(path: string): Hue {
  let h = 0;
  for (const ch of path) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
  return HUES[h % HUES.length]!;
}
