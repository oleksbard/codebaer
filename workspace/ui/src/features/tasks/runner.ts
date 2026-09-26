import {
  closeTerminal, connectTerminals, isExited, isTask, selectTerminal, size,
} from '#features/terminals';
import { HIDDEN_TASK_MS, loadCommands } from '#features/settings';
import { errText, git, type Scripts } from '#ipc/git';
import { logError } from '#ipc/log';
import * as pty from '#ipc/terminal';
import type { Info, Task } from '#ipc/terminal';
import { toast } from '#kernel/dialogs';
import { idle } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { outcome } from './tasks';

/** How long a task that finished out of sight keeps its output for the menu to reopen. */
export const TASK_KEEP_MS = 5 * 60_000;
const expiry = new Map<number, ReturnType<typeof setTimeout>>();
/** Tasks whose command hides its terminal, each with the timer that stops it. */
const hidden = new Map<number, ReturnType<typeof setTimeout>>();
let awaitingTask = 0;
let awaitingHidden = false;
/** A Spawned can overtake the reply to the invoke that asked for it, so each side checks for the other. */
let earlyTask: { req: number; info: Info } | null = null;

function expireTask(id: number): void {
  if (expiry.has(id) || S.taskView === id) return;
  expiry.set(id, setTimeout(() => {
    expiry.delete(id);
    const t = S.terminals.find((s) => s.id === id);
    if (t && isTask(t) && isExited(t) && S.taskView !== id) void closeTerminal(id);
  }, TASK_KEEP_MS));
}

/** Also what makes a hidden task an ordinary one: opened from the menu, it is being watched. */
function keepTask(id: number): void {
  clearTimeout(expiry.get(id));
  expiry.delete(id);
  clearTimeout(hidden.get(id));
  hidden.delete(id);
}

function hideTask(id: number): void {
  hidden.set(id, setTimeout(() => {
    hidden.delete(id);
    const t = S.terminals.find((s) => s.id === id);
    if (!t || isExited(t)) return;
    toast(`${t.title} was stopped after ${HIDDEN_TASK_MS / 60_000} minutes`, 'warn');
    void closeTerminal(id);
  }, HIDDEN_TASK_MS));
}

export function taskSpawned(req: number, info: Info): void {
  if (req !== awaitingTask) { earlyTask = { req, info }; return; }
  awaitingTask = 0;
  if (awaitingHidden) hideTask(info.id);
  else if (idle()) S.taskView = info.id;
  else toast(`${info.title} is running. Its output is in the command menu.`);
}

export function taskEnded(t: Info): void {
  if (S.taskView === t.id) return;
  const o = outcome(t);
  if (o) toast(`${t.title} ${o.text}`, o.tone);
  if (hidden.has(t.id)) {
    keepTask(t.id);
    void closeTerminal(t.id);
  }
  // for a hidden task, the retry of a close that fails; the Closed of one that works cancels it
  expireTask(t.id);
}

export function tasksListed(sessions: readonly Info[]): void {
  if (!sessions.some((t) => t.id === S.taskView && isTask(t))) S.taskView = null;
  // a reload forgets the timers, and a task can also finish while no window is connected
  for (const t of sessions) {
    if (!isTask(t) || !isExited(t)) continue;
    if (hidden.has(t.id)) taskEnded(t);
    else expireTask(t.id);
  }
}

export function taskClosed(id: number): void {
  keepTask(id);
  if (S.taskView === id) S.taskView = null;
}

export async function runTask(task: Task): Promise<void> {
  const hide = task.t === 'Custom' && task.hide_terminal;
  // with no subscription the host would run it and every event about it would go nowhere
  await connectTerminals();
  if (S.termError) { toast(S.termError, 'err'); return; }
  try {
    const req = await pty.runTask(task, ...size());
    const early = earlyTask?.req === req ? earlyTask : null;
    awaitingTask = req;
    awaitingHidden = hide;
    if (early) {
      earlyTask = null;
      taskSpawned(req, early.info);
      notify();
    }
  } catch (e) {
    toast(errText(e), 'err');
  }
}

export function openTask(id: number): void {
  if (!idle()) return;
  keepTask(id);
  S.taskView = id;
  notify();
}

/** A task that already ended goes with its dialog: the output was on screen until now. */
export function closeTask(): void {
  const t = S.terminals.find((s) => s.id === S.taskView);
  S.taskView = null;
  notify();
  if (!t || !isTask(t) || !isExited(t)) return;
  void closeTerminal(t.id);
  // a close that fails is tried again later; the Closed of one that works cancels this
  expireTask(t.id);
}

export async function promoteTask(id: number): Promise<void> {
  try {
    await pty.promote(id);
  } catch (e) {
    toast(errText(e), 'err');
    return;
  }
  keepTask(id);
  S.terminals = S.terminals.map((t) => (t.id === id ? { ...t, task: false } : t));
  S.taskView = null;
  selectTerminal(id);
}

/** The menu reads the file and package.json again on every opening, so a hand edit to either shows up. */
export async function taskMenu(): Promise<Scripts | null> {
  loadCommands().catch((e: unknown) => logError(e, 'load commands'));
  return git.packageScripts();
}
