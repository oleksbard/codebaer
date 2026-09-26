import { Channel, invoke } from '@tauri-apps/api/core';
import type { CustomCommand } from './settings';

export type Tier = 'marks' | 'process';

export type TermState =
  | { t: 'Starting' }
  | { t: 'Idle' }
  | { t: 'Running'; command: string | null; since_ms: number }
  | { t: 'Exited'; code: number | null };

/** `task` marks a command run from the command menu, shown in its own dialog until it is moved to the rail. */
export type Info = {
  id: number; pid?: number | null; title: string; cwd: string; tier: Tier; state: TermState; task?: boolean;
};
export type Shell = { path: string; name: string };
export type Menu = { shells: Shell[]; default: string; commands: string[] };
export type SpawnKind = { t: 'Shell'; path: string } | { t: 'Command'; argv0: string };
export type Task = ({ t: 'Custom' } & CustomCommand) | { t: 'Script'; name: string };

export type ServerMsg =
  | { t: 'Hello'; proto: number; sessions: Info[] }
  | { t: 'Spawned'; req: number; info: Info }
  | { t: 'Status'; id: number; state: TermState; tier: Tier }
  | { t: 'Command'; id: number; code: number | null }
  | { t: 'Exit'; id: number; code: number | null }
  | { t: 'Bell'; id: number }
  | { t: 'Cwd'; id: number; cwd: string }
  | { t: 'Closed'; id: number }
  | { t: 'Error'; id: number | null; message: string };

export type Relay = { sock: string; id: number | null; pid: number | null };
export type Proc = {
  pid: number; ppid: number; pgid: number; tty: string; command: string; session: number | null; relay: Relay | null;
  holds_app: boolean;
  exiting: boolean;
};
export type Host = {
  pid: number; sock: string; current: boolean; sock_exists: boolean; in_use: boolean; unclear: boolean;
  proto: number | null; relays: Relay[]; sessions: Proc[];
};
export type Orphans = { sock: string; hosts: Host[]; escaped: Proc[] };

export function subscribe(onOut: (m: ArrayBuffer | number[]) => void, onEvent: (m: ServerMsg) => void): Promise<void> {
  const out = new Channel<ArrayBuffer | number[]>();
  out.onmessage = onOut;
  const ev = new Channel<ServerMsg>();
  ev.onmessage = onEvent;
  return invoke('term_subscribe', { out, ev });
}

export const input = (id: number, data: string): Promise<void> => invoke('term_input', { id, data });
export const inputBytes = (id: number, bytes: number[]): Promise<void> => invoke('term_input_bytes', { id, bytes });
export const resize = (id: number, cols: number, rows: number): Promise<void> =>
  invoke('term_resize', { id, cols, rows });
export const menu = (): Promise<Menu> => invoke<Menu>('term_menu');
export const kill = (id: number): Promise<void> => invoke('term_kill', { id });
export const close = (id: number): Promise<void> => invoke('term_close', { id });
export const promote = (id: number): Promise<void> => invoke('term_promote', { id });
export const checkCwd = (): Promise<void> => invoke('term_check_cwd');
export const orphans = (): Promise<Orphans> => invoke<Orphans>('term_orphans');
export const relist = (id: number | null): Promise<void> => invoke('term_relist', { id });
export const killOrphan = (pid: number): Promise<void> => invoke('term_kill_orphan', { pid });
export const restore = (sock: string, id: number | null, pid: number, cols: number, rows: number): Promise<void> =>
  invoke('term_restore', { sock, id, pid, cols, rows });

export function spawn(kind: SpawnKind, cols = 80, rows = 24): Promise<number> {
  return invoke<number>('term_spawn', { kind, cols, rows });
}

/** Resolves to the spawn's `req`, like `spawn`; the backend builds the command line from `task`. */
export function runTask(task: Task, cols = 80, rows = 24): Promise<number> {
  return invoke<number>('task_run', { task, cols, rows });
}
