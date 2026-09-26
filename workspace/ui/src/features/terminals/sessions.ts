import { errText } from '#ipc/git';
import { logError } from '#ipc/log';
import * as pty from '#ipc/terminal';
import type { Info, ServerMsg, SpawnKind } from '#ipc/terminal';
import { promptDialog, toast } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';
import { isTask, terminalsOf } from './status';
import * as term from './xterm';

/** Set once the spawn we are waiting for is known, so an unprompted session, one restored on
 *  reconnect say, does not steal the view. */
let awaitingSpawn = 0;
let connecting: Promise<void> | null = null;

type TaskEvents = {
  hello(sessions: readonly Info[]): void;
  spawned(req: number, info: Info): void;
  ended(t: Info): void;
  closed(id: number): void;
};

/** The tasks feature sets these where it is defined. They run inside onTermEvent's try, before its notify(). */
export const taskEvents: TaskEvents = { hello() {}, spawned() {}, ended() {}, closed() {} };

/** Nothing in here may throw. Tauri advances a channel's message index only once onmessage
 *  returns, so one escaping error parks every later event in its pending queue for the life
 *  of the connection: the sessions go on running with no way left to hear about them. */
export function onTermEvent(m: ServerMsg): void {
  try {
    switch (m.t) {
      case 'Hello': {
        S.terminals = m.sessions;
        const rail = terminalsOf(m.sessions);
        if (!rail.some((t) => t.id === S.activeTerm)) S.activeTerm = rail.at(-1)?.id ?? null;
        taskEvents.hello(m.sessions);
        break;
      }
      case 'Spawned':
        S.terminals = [...S.terminals.filter((t) => t.id !== m.info.id), m.info];
        if (m.req === awaitingSpawn) {
          S.activeTerm = m.info.id;
          awaitingSpawn = 0;
        } else if (isTask(m.info)) {
          taskEvents.spawned(m.req, m.info);
        }
        break;
      case 'Status':
        S.terminals = S.terminals.map((t) => (t.id === m.id ? { ...t, state: m.state, tier: m.tier } : t));
        break;
      case 'Command':
        if (m.code !== null && m.code !== 0) flag(m.id);
        break;
      case 'Exit': {
        S.terminals = S.terminals.map((t) => (t.id === m.id ? { ...t, state: { t: 'Exited', code: m.code } } : t));
        const t = S.terminals.find((x) => x.id === m.id);
        if (t && isTask(t)) taskEvents.ended(t);
        else flag(m.id);
        break;
      }
      case 'Bell':
        flag(m.id);
        break;
      case 'Cwd':
        S.terminals = S.terminals.map((t) => (t.id === m.id ? { ...t, cwd: m.cwd } : t));
        break;
      case 'Closed':
        S.terminals = S.terminals.filter((t) => t.id !== m.id);
        S.termAttention.delete(m.id);
        taskEvents.closed(m.id);
        if (S.activeTerm === m.id) S.activeTerm = terminalsOf(S.terminals).at(-1)?.id ?? null;
        // last, because it is the one step here that reaches into xterm: a teardown that
        // fails must not leave the view pointing at a session that is already gone
        term.dispose(m.id);
        break;
      case 'Error':
        S.termError = m.message;
        toast(m.message, 'err');
        break;
    }
  } catch (e) {
    logError(e, `terminal event ${m.t}`);
    toast(errText(e), 'err');
  }
  notify();
}

/** Only a session you are not looking at can want attention. A task has its own dialog and no rail button.
 *  A session closed while it ran is gone before its Exit arrives, and a new host can hand its id out again. */
function flag(id: number): void {
  const s = S.terminals.find((t) => t.id === id);
  if (!s || isTask(s)) return;
  if (id !== S.activeTerm || S.tab !== 'terminals') S.termAttention.add(id);
}

/** Kept as the in-flight attempt rather than a flag: the menu runs a login shell, and a failed
 *  connect that left the flag set would leave every ⌘T with no shell to spawn and nothing said. */
export async function connectTerminals(): Promise<void> {
  connecting ??= (async () => {
    await term.subscribe(onTermEvent);
    term.watchOutput(notify);
    S.termMenu = await pty.menu();
  })();
  try {
    await connecting;
    S.termError = null;
  } catch (e) {
    connecting = null;
    S.termError = errText(e);
  }
  notify();
}

export async function showTerminals(): Promise<void> {
  S.tab = 'terminals';
  notify();
  await connectTerminals();
}

export async function newTerminal(kind?: SpawnKind): Promise<void> {
  await showTerminals();
  const pick = kind ?? (S.termMenu ? ({ t: 'Shell', path: S.termMenu.default } as const) : null);
  if (!pick) return;
  try {
    awaitingSpawn = await pty.spawn(pick, ...term.size());
  } catch (e) {
    toast(errText(e), 'err');
  }
}

export function selectTerminal(id: number): void {
  S.activeTerm = id;
  S.termAttention.delete(id);
  S.tab = 'terminals';
  notify();
}

export async function killTerminal(id: number): Promise<void> {
  try { await pty.kill(id); } catch (e) { toast(errText(e), 'err'); }
}

export async function closeTerminal(id: number): Promise<void> {
  try { await pty.close(id); } catch (e) { toast(errText(e), 'err'); }
}

export const onTerminal = (fn: (id: number) => unknown): void => { if (S.activeTerm !== null) void fn(S.activeTerm); };

export async function findInTerminal(): Promise<void> {
  const q = await promptDialog('Find in terminal');
  if (q === null) return;
  S.termFind = q;
  onTerminal((id) => term.find(id, q));
}
