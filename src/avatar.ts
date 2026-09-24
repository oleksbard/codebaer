const KEY = 'codebaer.avatars';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
const graphemes = new Intl.Segmenter();
const chars = (s: string): string[] => Array.from(graphemes.segment(s), (g) => g.segment);

export const HUES = ['blue', 'green', 'orange', 'pink', 'purple', 'red', 'yellow'] as const;
export type Hue = (typeof HUES)[number];

type Repo = { path: string; name: string };
type Stored = Record<string, { code: string; name: string }>;

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

function load(): Stored {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Stored = {};
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as { code?: unknown; name?: unknown } | null;
    if (typeof e?.code !== 'string' || typeof e.name !== 'string' || chars(e.code).length !== 2) continue;
    out[path] = { code: e.code, name: e.name };
  }
  return out;
}

function save(s: Stored): void {
  const json = JSON.stringify(s);
  if (localStorage.getItem(KEY) !== json) localStorage.setItem(KEY, json);
}

/**
 * A code per repo, unique among the repos listed and every other repo remembered. A repo keeps its
 * code across calls, whatever the order, until its name changes or `forgetAvatars` drops it.
 */
export function avatars(repos: Repo[]): Map<string, string> {
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
      stored[r.path] = { code: c, name: r.name };
      break;
    }
  }
  save(stored);
  return new Map(list.map((r) => [r.path, got.get(r.path)!]));
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
