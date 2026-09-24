import type { Info } from './terminal';
import { agentOf, isExited, outsideRepo } from './terminal-status';

/** Unstaged, plain and conflict views all show the working file; the staged view shows the index. */
export type Side = 'work' | 'index';
export type Quote = { t: 'code'; lang: string; text: string } | { t: 'diff'; text: string };

export type Comment = {
  id: number;
  path: string;
  side: Side;
  /** 1-based, inclusive. */
  from: number;
  to: number;
  /** The text of lines from..to as last seen, which is what re-anchoring searches for. */
  anchor: string;
  /** Captured when the comment is added; editing changes `text` only. */
  quote: Quote;
  text: string;
  /** Re-anchoring failed: kept and still sent, but not shown in the editor. */
  moved: boolean;
};

export type Draft = {
  path: string;
  side: Side;
  from: number;
  to: number;
  anchor: string;
  quote: Quote;
  text: string;
  editing: number | null;
  /** Set when the box should take focus the next time it mounts, and cleared by the box. */
  focus: boolean;
  /** Its lines left the file while it was open, so saving it leaves the comment moved. */
  lost: boolean;
};

const MAX_QUOTE = 30;
/** A minified line would otherwise put megabytes into the agent's input. */
const MAX_LINE = 400;

export function location(c: { path: string; side: Side; from: number; to: number }): string {
  const lines = c.from === c.to ? `${c.from}` : `${c.from}-${c.to}`;
  return `${c.path}:${lines}${c.side === 'index' ? ' (staged)' : ''}`;
}

export function langOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** One backtick longer than any run inside, so quoted markdown cannot close the block early. */
export function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

export const sortComments = (cs: readonly Comment[]): Comment[] =>
  [...cs].sort((a, b) => (a.path === b.path ? a.from - b.from : a.path < b.path ? -1 : 1));

/** By code point: a UTF-16 cut can split a surrogate pair. */
function clip(l: string): string {
  if (l.length <= MAX_LINE) return l;
  const cps = [...l];
  return cps.length <= MAX_LINE ? l : `${cps.slice(0, MAX_LINE).join('')}…`;
}

function block(c: Comment): string {
  const lines = c.quote.text.split('\n');
  const shown = lines.slice(0, MAX_QUOTE).map(clip);
  const f = fence(shown.join('\n'));
  const more = lines.length - shown.length;
  return [
    location(c),
    `${f}${c.quote.t === 'diff' ? 'diff' : c.quote.lang}`,
    ...shown,
    f,
    ...(more > 0 ? [`(${more} more line${more === 1 ? '' : 's'} not shown)`] : []),
    c.text,
  ].join('\n');
}

export function format(comments: readonly Comment[]): string {
  const sorted = sortComments(comments);
  if (sorted.length === 1) return block(sorted[0]!);
  return ['Review comments:', ...sorted.map((c, i) => `${i + 1}. ${block(c)}`)].join('\n\n');
}

const keep = (c: number): boolean =>
  c === 0x09 || c === 0x0a || (c >= 0x20 && c < 0x7f) || (c > 0x9f && (c < 0xd800 || c > 0xdfff));

/** Drops every C0 control but tab and newline, DEL, and C1, so quoted file content can neither
 *  end the bracketed paste early nor reach the program as keystrokes. A lone surrogate goes too:
 *  the IPC's JSON parser rejects one, and every send would fail on it. */
export function sanitize(text: string): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) if (keep(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

/** Newlines go as CR, which is what xterm's own paste sends. */
export const pastePayload = (text: string): string =>
  `\x1b[200~${sanitize(text).replace(/\n/g, '\r')}\x1b[201~`;

export const kindOf = (s: Info): string => agentOf(s) ?? (s.title.split('/').pop() || 'terminal');

/** Numbered per kind in rail order over every session, so `claude:2` is the second claude
 *  button counted from the top whether or not the ones above it can take comments. */
export function termLabels(sessions: readonly Info[]): Map<number, string> {
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const s of sessions) {
    const k = kindOf(s);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    out.set(s.id, `${k}:${n}`);
  }
  return out;
}

/** Shells whose line editor brackets pastes by default. macOS's /bin/bash is 3.2, which does not,
 *  and a program without it runs a pasted CR as Enter, one quoted line at a time. */
const PASTE_SAFE = new Set(['zsh', 'fish']);

/** A one-shot run in a shell never reads its terminal, so the shell would get the paste once it ends. */
const ONE_SHOT = /(^|\s)(-p|--print)(\s|$)|^codex\s+(exec|e)(\s|$)/;

const agent = (s: Info): boolean =>
  agentOf(s) !== null && !(s.state.t === 'Running' && ONE_SHOT.test(s.state.command?.trim() ?? ''));

/** An agent takes comments at any time. A shell only at its own prompt, which Idle means because
 *  only the prompt marks report it: a REPL or ssh in its foreground would run each line. */
export const canTake = (s: Info): boolean => agent(s) || (s.state.t === 'Idle' && PASTE_SAFE.has(kindOf(s)));

export const eligible = (sessions: readonly Info[], root: string | null): Info[] =>
  root ? sessions.filter((s) => !isExited(s) && !outsideRepo(s, root) && canTake(s)) : [];

/** Enter would run the comment as commands in a shell, so only a known agent gets one. */
export const submits = agent;

/** The 1-based first line of the occurrence of `anchor` nearest `near`, or null. */
export function reanchor(lines: readonly string[], anchor: string, near: number): number | null {
  const want = anchor.split('\n');
  let best: number | null = null;
  for (let i = 0; i + want.length <= lines.length; i++) {
    let j = 0;
    while (j < want.length && lines[i + j] === want[j]) j++;
    if (j < want.length) continue;
    if (best === null || Math.abs(i + 1 - near) < Math.abs(best - near)) best = i + 1;
  }
  return best;
}

/** Where a stored range sits in `lines` now: unchanged when its anchor still matches, else the
 *  nearest occurrence of the anchor. */
export function locate(
  lines: readonly string[], c: { from: number; to: number; anchor: string },
): { from: number; to: number } | null {
  if (c.to <= lines.length && lines.slice(c.from - 1, c.to).join('\n') === c.anchor) return { from: c.from, to: c.to };
  const at = reanchor(lines, c.anchor, c.from);
  return at === null ? null : { from: at, to: at + c.to - c.from };
}
