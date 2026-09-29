import { ensureIcons } from '#features/command-icons';
import { logError } from '#ipc/log';
import type { Info } from '#ipc/terminal';
import { notify, S, type DeepReadonly } from '#kernel/store';
import type { TermIcon } from './state';
import { agentOf, isExited } from './status';

/** Long enough that ls, cd or git status never names a shell, and a dev server, a test run or ssh does. */
export const LONG_MS = 5000;
const KEY = 'codebaer.term.icons';

/** `CANDIDATES` in shells.rs, and sh: a shell is titled by its program's name. */
const SHELLS = new Set(['zsh', 'bash', 'fish', 'nu', 'pwsh', 'elvish', 'xonsh', 'dash', 'tcsh', 'ksh', 'sh']);

/** Only a shell reports marks, but one whose marks never came drops to the process tier. */
const isShell = (s: DeepReadonly<Info>): boolean => s.tier === 'marks' || SHELLS.has(s.title);

/** Null for a session that has ended and for an agent, which the code draws, and for a shell that has not run a long
 *  command yet. */
export function iconFor(s: DeepReadonly<Info>, kept: ReadonlyMap<number, DeepReadonly<TermIcon>>): TermIcon | null {
  if (isExited(s)) return null;
  const k = kept.get(s.id);
  if (k) return k;
  if (isShell(s) || agentOf(s)) return null;
  return { name: '', command: s.title, icon: null };
}

/** The session's own pid tells it from one a newer host gave the same id. */
const keyOf = (s: DeepReadonly<Info>): string | null => (s.pid == null ? null : `${s.id}:${s.pid}`);

function asIcon(v: unknown): TermIcon | null {
  const it = v as Partial<TermIcon> | null | undefined;
  if (typeof it?.name !== 'string' || typeof it.command !== 'string') return null;
  return { name: it.name, command: it.command, icon: typeof it.icon === 'string' ? it.icon : null };
}

function read(): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

/** Written from the session list, so a session that is gone drops out. */
function save(): void {
  const out: Record<string, TermIcon> = {};
  for (const t of S.terminals) {
    const k = keyOf(t);
    const it = S.termIcons.get(t.id);
    if (k && it) out[k] = it;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch (e) {
    logError(e, 'save terminal icons');
  }
}

export function keepIcon(id: number, it: TermIcon): void {
  S.termIcons.set(id, it);
  save();
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Called with each state a session reports. The first command that is still running once it is long names the
 *  shell for good; an agent is left out, since its mark shows while it runs. */
export function watchLong(s: DeepReadonly<Info>): void {
  clearTimeout(timers.get(s.id));
  timers.delete(s.id);
  if (s.state.t !== 'Running' || S.termIcons.has(s.id) || !isShell(s) || agentOf(s)) return;
  const line = s.state.command?.trim();
  const since = s.state.since_ms;
  if (!line) return;
  timers.set(s.id, setTimeout(() => {
    timers.delete(s.id);
    const now = S.terminals.find((t) => t.id === s.id);
    if (now?.state.t !== 'Running' || now.state.since_ms !== since || S.termIcons.has(s.id)) return;
    keepIcon(s.id, { name: '', command: line, icon: null });
    notify();
  }, Math.max(0, since + LONG_MS - Date.now())));
}

/** A reload keeps the sessions but forgets what they ran. */
export function restoreIcons(sessions: readonly Info[]): void {
  const raw = read();
  S.termIcons = new Map();
  for (const t of sessions) {
    const k = keyOf(t);
    const it = k ? asIcon(raw[k]) : null;
    if (it) S.termIcons.set(t.id, it);
  }
  save();
  for (const t of sessions) watchLong(t);
}

export function forgetIcon(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (S.termIcons.delete(id)) save();
}

/** For the rail's sessions only. With the AI off only a hand pick is drawn, so the sets load only for one. */
export function ensureTermIcons(items: readonly DeepReadonly<TermIcon>[]): void {
  const ask = S.settings['general.headless-ai-provider'] === 'off' ? [] : items.filter((it) => it.icon === null);
  if (ask.length || items.some((it) => it.icon !== null)) void ensureIcons(ask, { quiet: true });
}
