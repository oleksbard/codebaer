import type { Info } from '#ipc/terminal';
import { agentNamed, agentOf, isExited, outsideRepo, type Agent } from '#features/terminals';
import { baseName } from '#kernel/paths';
import type { DeepReadonly } from '#kernel/store';

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
  /** The box holds focus: set when it opens or gains focus, cleared when focus moves elsewhere. The
   *  editor rebuilds the box's DOM on some refreshes, and the new one takes focus back. */
  focus: boolean;
  /** Where the caret was, for a box the editor rebuilt. */
  caret: number | null;
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
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** One backtick longer than any run inside, so quoted markdown cannot close the block early. */
export function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

export const sortComments = <C extends DeepReadonly<Comment>>(cs: readonly C[]): C[] =>
  [...cs].sort((a, b) => (a.path === b.path ? a.from - b.from : a.path < b.path ? -1 : 1));

/** By code point: a UTF-16 cut can split a surrogate pair. */
function clip(l: string): string {
  if (l.length <= MAX_LINE) return l;
  const cps = Array.from(l);
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

/** Bare words that are the interactive interface itself. Every other bare word is taken for a
 *  subcommand, which runs once without reading the terminal, so the shell under it would read the
 *  paste and its Enter once it ends. A list of the one-shot subcommands would go stale unsafely. */
const INTERACTIVE: Record<Agent, ReadonlySet<string>> = {
  claude: new Set(), codex: new Set(['resume']), opencode: new Set(['attach']),
};

/** opencode's interface takes a project folder. A word with a slash in it cannot be a subcommand, and the words
 *  after it are still checked. */
const isFolder = (cli: Agent, w: string): boolean =>
  cli === 'opencode' && (w.includes('/') || w === '.' || w === '..' || w === '~');

/** Flags whose value comes next. A value-taking flag missing here makes its value read as a
 *  subcommand, which hides the session rather than offering a wrong one. */
const VALUE_FLAGS: Record<Agent, ReadonlySet<string>> = {
  claude: new Set(['--add-dir', '--plugin-dir', '--model', '--fallback-model', '--permission-mode', '--settings',
    '--setting-sources', '--mcp-config', '--append-system-prompt', '--system-prompt', '--session-id', '--resume', '-r',
    '--agent', '--agents', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools',
    '--betas', '-w', '--worktree', '--from-pr', '--debug']),
  codex: new Set(['-c', '--config', '-p', '--profile', '-m', '--model', '-i', '--image', '-s', '--sandbox', '-a',
    '--ask-for-approval', '-C', '--cd', '--add-dir', '--enable', '--disable', '--local-provider']),
  opencode: new Set(['-m', '--model', '-s', '--session', '--prompt', '--agent', '--port', '--hostname',
    '--log-level']),
};

/** The agent a shell command line runs interactively, or null. A quoted word is the prompt. */
function interactiveCli(command: string): Agent | null {
  const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]!)) i++;
  const word = words[i];
  const cli = word === undefined ? null : agentNamed(baseName(word).toLowerCase());
  if (cli === null) return null;
  const bare = (w: string | undefined) => w?.replace(/["']/g, '');
  let resumed = false;
  for (let k = i + 1; k < words.length; k++) {
    const word = words[k]!;
    // outside quotes, a redirect, pipe, list, background job, substitution or line continuation:
    // the terminal's input may not be the agent's, or something else runs after it
    if (/[<>|&;`$()\\]/.test(word.replace(/"[^"]*"|'[^']*'/g, ''))) return null;
    const a = bare(word)!;
    if (a.startsWith('-')) {
      if (cli === 'claude' && (a === '--print' || a.startsWith('--print=') || /^-[a-zA-Z]*p[a-zA-Z]*$/.test(a))) {
        return null;
      }
      // a value never starts with a dash, since claude's --resume takes one only optionally
      if (VALUE_FLAGS[cli].has(a) && !(bare(words[k + 1]) ?? '-').startsWith('-')) k++;
    } else if (!/^(?:"[^"]*"|'[^']*')$/.test(word) && !resumed) {
      if (isFolder(cli, a)) continue;
      if (!INTERACTIVE[cli].has(a)) return null;
      resumed = true;
    }
  }
  return cli;
}

/** Only an interactive agent. A shell, or anything else in one's foreground, runs a pasted line as
 *  a command as soon as an Enter arrives, and the quoted code with it. */
export function takesComments(s: Info): boolean {
  if (isExited(s)) return false;
  const running = s.state.t === 'Running' ? s.state.command : null;
  return running ? interactiveCli(running) !== null : agentOf(s) !== null;
}

export const eligible = (sessions: readonly Info[], root: string | null): Info[] =>
  root ? sessions.filter((s) => takesComments(s) && !outsideRepo(s, root)) : [];

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
