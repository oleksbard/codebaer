import { git } from '#ipc/git';
import { logError } from '#ipc/log';
import type { Info } from '#ipc/terminal';
import { notify, S } from '#kernel/store';
import { keyOf, readKept } from './icons';

const KEY = 'codebaer.term.names';
/** Enough of the recent work to tell a new task from a follow-up to the current one. */
export const KEEP = 4;

/** `pid` tells a session from one that a new host gave the same id. A webview reload starts these again, while the
 *  name itself is kept. */
type Asking = { pid: number | null; prompts: string[]; count: number; running: boolean };
const asks = new Map<number, Asking>();

/** Written from the session list, so a session that is gone drops out. */
function save(): void {
  const out: Record<string, string> = {};
  for (const t of S.terminals) {
    const k = keyOf(t);
    const n = S.termNames.get(t.id);
    if (k && n) out[k] = n;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch (e) {
    logError(e, 'save terminal names');
  }
}

/** A reload keeps the sessions but forgets their names. */
export function restoreNames(sessions: readonly Info[]): void {
  const kept = readKept(KEY);
  S.termNames = new Map();
  for (const t of sessions) {
    const k = keyOf(t);
    const n = k ? kept[k] : undefined;
    if (typeof n === 'string' && n) S.termNames.set(t.id, n);
  }
  save();
}

export function forgetName(id: number): void {
  asks.delete(id);
  if (S.termNames.delete(id)) save();
}

/** Asks the headless AI for a name after each prompt. A failed or unsure ask keeps the name the session has. One ask
 *  runs at a time, and prompts that come while it runs get one more ask after it: a quick "yes" must not drop the
 *  answer to the prompt before it. */
export async function nameFrom(id: number, text: string): Promise<void> {
  const session = S.terminals.find((t) => t.id === id);
  if (!session) return;
  const pid = session.pid ?? null;
  let a = asks.get(id);
  if (a?.pid !== pid) {
    a = { pid, prompts: [], count: 0, running: false };
    asks.set(id, a);
  }
  a.prompts = [...a.prompts, text].slice(-KEEP);
  a.count += 1;
  if (a.running) return;
  a.running = true;
  let asked: number;
  try {
    do {
      asked = a.count;
      if (S.settings['general.headless-ai-provider'] === 'off') return;
      const name = await git.aiSessionName(a.prompts, S.termNames.get(id) ?? null);
      const same = asks.get(id) === a && S.terminals.some((t) => t.id === id && (t.pid ?? null) === pid);
      if (!same) return;
      if (name !== null) {
        S.termNames.set(id, name);
        save();
        notify();
      }
    } while (a.count !== asked);
  } catch (e) {
    logError(e, 'name a terminal');
  } finally {
    a.running = false;
  }
}
