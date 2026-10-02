import type { Channel } from '@tauri-apps/api/core';
import type { AppError, Scripts, Status } from '#ipc/git';
import type { CustomCommand } from '#ipc/settings';
import type { AgentState, Info, Menu, Orphans, ServerMsg, SpawnKind, Task, TermState } from '#ipc/terminal';

/** `id` is handed out in order; `transcript` is what the host's ring holds, replayed on subscribe. */
export type SessionSeed = Omit<Info, 'id' | 'cwd'> & { cwd?: string; transcript?: string };

export type PtyDeps = {
  root: string;
  menu: Menu;
  sessions: SessionSeed[];
  orphans: Orphans;
  status: () => Status;
  scripts: () => Scripts | null;
  commands: () => CustomCommand[];
  /** A timer the backend counts as pending work, so `__mock.idle()` waits for it. Returns its cancel. */
  later: (ms: number, fn: () => void) => () => void;
};

type Session = {
  info: Info; line: string; ring: Uint8Array[]; ringSize: number; cancel?: (() => void) | undefined;
  /** A bracketed paste was echoed and the Enter that submits it has not come yet. */
  pasted: boolean;
  /** The option claude's permission prompt has selected, as `Agent::pick` in agent.rs holds it. */
  pick: number;
};

/** `PROTO` in workspace/backend/src/pty/proto.rs. */
const PROTO = 4;
const RING_MAX = 256 * 1024;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const enc = new TextEncoder();

const color = (code: number, text: string): string => `\x1b[${code}m${text}\x1b[0m`;

/** `Agent::new` in workspace/backend/src/pty/agent.rs: what the host holds after claude's SessionStart hook. */
export const idleAgent = (now: number): AgentState => ({
  phase: 'idle', since_ms: now, turn_ms: null, took_ms: null, end: null, actions: 0, calls: [], last: null, ask: null,
  subagents: 0, rev: 0,
});

/** `NO` in workspace/backend/src/pty/agent.rs: the mock's permission prompt always offers all three options. */
const NO = 2;

/** `typed` in workspace/backend/src/pty/agent.rs; null when the keys change nothing. */
function typed(s: Session, a: AgentState, data: string, now: number): AgentState | null {
  const stop = (): AgentState | null => {
    if (a.phase === 'idle') return null;
    if (a.phase === 'compacting' && a.end !== null) return { ...a, phase: 'idle', since_ms: now, rev: a.rev + 1 };
    const took = a.turn_ms === null ? null : Math.max(0, now - a.turn_ms);
    return {
      ...a, phase: 'idle', since_ms: now, took_ms: took, end: 'interrupted', calls: [], ask: null, subagents: 0,
      rev: a.rev + 1,
    };
  };
  const yes = (): AgentState => {
    s.pick = 0;
    return { ...a, phase: 'working', since_ms: now, ask: null, rev: a.rev + 1 };
  };
  if (data === '\x1b' || data === '\x03') return stop();
  if (a.phase !== 'approval') return null;
  switch (data) {
    case '\x1b[A': case '\x1bOA': s.pick = Math.max(0, s.pick - 1); return null;
    case '\x1b[B': case '\x1bOB': s.pick = Math.min(NO, s.pick + 1); return null;
    case '1': case '2': case 'y': case 'Y': return yes();
    case '3': case 'n': case 'N': return stop();
    case '\r': return s.pick >= NO ? stop() : yes();
    default: return null;
  }
}
const running = (command: string | null): TermState => ({ t: 'Running', command, since_ms: Date.now() });

/** The frame `route()` in features/terminals/xterm.ts reads: a little-endian session id, then the bytes. */
function frame(id: number, bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + bytes.length);
  new DataView(buf).setUint32(0, id, true);
  new Uint8Array(buf, 4).set(bytes);
  return buf;
}

function shortStatus(s: Status): string {
  const track = s.upstream ? `...${s.upstream}${s.ahead ? ` [ahead ${s.ahead}]` : ''}` : '';
  const lines = [`## ${s.branch ?? 'HEAD (no branch)'}${track}`];
  for (const f of s.files) {
    if (f.untracked && f.indexStatus === '.') { lines.push(`${color(31, '??')} ${f.path}`); continue; }
    const x = f.indexStatus === '.' ? ' ' : color(32, f.indexStatus);
    const y = f.worktreeStatus === '.' ? ' ' : color(31, f.worktreeStatus);
    lines.push(`${x}${y} ${f.path}`);
  }
  return `${lines.join('\n')}\n`;
}

export function createPty(d: PtyDeps) {
  let out: Channel<ArrayBuffer | number[]> | null = null;
  let ev: Channel<ServerMsg> | null = null;
  const sessions = new Map<number, Session>();
  let nextId = 1;
  let nextReq = 1;
  let orphans = d.orphans;

  const send = (m: ServerMsg): void => ev?.onmessage(m);
  const infos = (): Info[] => [...sessions.values()].map((s) => s.info);
  const sessionOf = (id?: number): Session | undefined => sessions.get(id ?? Math.max(0, ...sessions.keys()));
  const name = d.root.split('/').at(-1) ?? d.root;

  const write = (s: Session, text: string): void => {
    const bytes = enc.encode(text.replace(/\r?\n/g, '\r\n'));
    s.ring.push(bytes);
    s.ringSize += bytes.length;
    while (s.ringSize > RING_MAX && s.ring.length > 1) s.ringSize -= s.ring.shift()!.length;
    out?.onmessage(frame(s.info.id, bytes));
  };
  const replay = (s: Session): void => { for (const b of s.ring) out?.onmessage(frame(s.info.id, b)); };
  const setState = (s: Session, state: TermState): void => {
    s.info.state = state;
    send({ t: 'Status', id: s.info.id, state, tier: s.info.tier });
  };
  const prompt = (s: Session): void => {
    if (s.info.tier === 'process') { write(s, `${color(35, '>')} `); return; }
    write(s, `${color(32, name)} ${color(90, d.status().branch ?? '')} $ `);
  };
  const add = (info: Omit<Info, 'id'>, transcript = ''): Session => {
    const s: Session = { info: { ...info, id: nextId++ }, line: '', ring: [], ringSize: 0, pasted: false, pick: 0 };
    sessions.set(s.info.id, s);
    if (transcript) write(s, transcript);
    return s;
  };
  const stop = (s: Session): void => {
    s.cancel?.();
    s.cancel = undefined;
  };
  const exit = (s: Session, code: number | null): void => {
    stop(s);
    s.info.state = { t: 'Exited', code };
    send({ t: 'Exit', id: s.info.id, code });
  };
  const finish = (s: Session, code: number): void => {
    send({ t: 'Command', id: s.info.id, code });
    setState(s, { t: 'Idle' });
    prompt(s);
  };

  const run = (s: Session, line: string): void => {
    const [cmd = '', ...rest] = line.trim().split(/\s+/);
    if (!cmd) { prompt(s); return; }
    if (s.info.tier === 'process') {
      write(s, `${color(36, '⏺')} Browser mode has no agent. It heard: ${line}\n`);
      prompt(s);
      return;
    }
    setState(s, running(line));
    let code = 0;
    switch (cmd) {
      case 'echo': write(s, `${rest.join(' ')}\n`); break;
      case 'pwd': write(s, `${s.info.cwd}\n`); break;
      case 'ls': {
        const top = new Set(d.status().files.map((f) => f.path.split('/')[0] ?? f.path));
        write(s, `${[...top].sort((a, b) => a.localeCompare(b)).join('  ')}\n`);
        break;
      }
      case 'git':
        if (rest[0] === 'status') write(s, shortStatus(d.status()));
        else { write(s, 'mock: only `git status` works in browser mode\n'); code = 1; }
        break;
      case 'clear': write(s, '\x1b[2J\x1b[3J\x1b[H'); break;
      case 'sleep':
        s.cancel = d.later((Number(rest[0]) || 1) * 1000, () => { s.cancel = undefined; finish(s, 0); });
        return;
      case 'exit': exit(s, Number(rest[0]) || 0); return;
      case 'true': break;
      case 'false': code = 1; break;
      default: write(s, `mock: ${cmd}: not available in browser mode\n`); code = 127;
    }
    finish(s, code);
  };

  const start = (s: Session, req: number, banner: string): void => {
    d.later(0, () => {
      send({ t: 'Spawned', req, info: s.info });
      write(s, banner);
      if (s.info.tier === 'marks') setState(s, { t: 'Idle' });
      prompt(s);
    });
  };

  const killOrphan = (pid: number): void => {
    orphans = {
      ...orphans,
      hosts: orphans.hosts.map((h) => ({ ...h, sessions: h.sessions.filter((p) => p.pid !== pid) })),
      escaped: orphans.escaped.filter((p) => p.pid !== pid),
    };
  };

  for (const { transcript, cwd, ...info } of d.sessions) add({ ...info, cwd: cwd ?? d.root }, transcript);

  return {
    subscribe(o: Channel<ArrayBuffer | number[]>, e: Channel<ServerMsg>): void {
      out = o;
      ev = e;
      send({ t: 'Hello', proto: PROTO, sessions: infos() });
      for (const s of sessions.values()) replay(s);
    },

    spawn(kind: SpawnKind): number {
      const shell = kind.t === 'Shell' ? d.menu.shells.find((x) => x.path === kind.path) : undefined;
      const ok = kind.t === 'Shell' ? !!shell : d.menu.commands.includes(kind.argv0);
      if (!ok) throw { kind: 'InvalidPath', detail: JSON.stringify(kind) } satisfies AppError;
      const req = nextReq++;
      const s = add({
        pid: 50_000 + nextId, title: shell?.name ?? (kind.t === 'Command' ? kind.argv0 : 'sh'), cwd: d.root,
        tier: kind.t === 'Shell' ? 'marks' : 'process',
        state: kind.t === 'Shell' ? { t: 'Starting' } : running(null),
        ...(kind.t === 'Command' && kind.argv0 === 'claude' ? { agent: idleAgent(Date.now()) } : {}),
      });
      start(s, req, kind.t === 'Shell'
        ? color(2, 'Browser mode: a pretend shell. Try echo, ls, git status, sleep 5, exit.\n')
        : color(2, `Browser mode: ${s.info.title} is not really running here.\n`));
      return req;
    },

    /** `plan()` in tasks.rs builds the same line and title. */
    runTask(task: Task): number {
      let line = '';
      let title = '';
      if (task.t === 'Custom') {
        const { t: _, ...c } = task;
        const saved = d.commands().some((x) => x.name === c.name && x.command === c.command && x.repo === c.repo
          && x.hide_terminal === c.hide_terminal && x.icon === c.icon);
        if (!saved || (c.repo !== null && c.repo !== d.root)) {
          throw { kind: 'Io', detail: `${c.command} is no longer saved for this repository` } satisfies AppError;
        }
        line = task.command;
        title = task.name.trim() || task.command;
      } else {
        const scripts = d.scripts();
        if (!scripts?.scripts.some((x) => x.name === task.name)) {
          throw { kind: 'Io', detail: `package.json has no script named ${task.name}` } satisfies AppError;
        }
        line = `${scripts.runner} run ${task.name}`;
        title = `${scripts.runner} ${task.name}`;
      }
      const req = nextReq++;
      const s = add({ pid: 50_000 + nextId, title, cwd: d.root, tier: 'process', state: running(null), task: true });
      d.later(0, () => {
        send({ t: 'Spawned', req, info: s.info });
        write(s, `${color(2, '$')} ${line}\n`);
      });
      const steps = ['> browser mode: pretend output', '', '  ✓ 12 checks passed', '', 'Done in 1.2s'];
      const step = (i: number): void => {
        s.cancel = d.later(300, () => {
          s.cancel = undefined;
          write(s, `${steps[i]}\n`);
          if (i === steps.length - 1) exit(s, 0);
          else step(i + 1);
        });
      };
      step(0);
      return req;
    },

    input(id: number, data: string): void {
      const s = sessions.get(id);
      if (!s || s.info.state.t === 'Exited') return;
      const agent = s.info.agent && typed(s, s.info.agent, data, Date.now());
      if (agent) {
        s.info.agent = agent;
        send({ t: 'Agent', id, agent });
      }
      if (s.info.tier === 'process' && !s.info.task && data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
        const [first = '', ...rest] = data.slice(PASTE_START.length, -PASTE_END.length).split('\r');
        write(s, `${[first, ...rest.map((l) => (l ? `  ${l}` : l))].join('\n')}\n\n`);
        s.pasted = true;
        return;
      }
      if (s.pasted) {
        s.pasted = false;
        if (data === '\r') return;
      }
      const text = data.split(PASTE_START).join('').split(PASTE_END).join('');
      if (s.info.task && text.includes('\x03')) { write(s, '^C\n'); exit(s, 130); return; }
      if (s.info.state.t === 'Running' && s.info.tier === 'marks') {
        if (text.includes('\x03')) { stop(s); write(s, '^C\n'); finish(s, 130); }
        return;
      }
      // arrows and other escape sequences: this shell has no history or cursor to move
      if (text.startsWith('\x1b')) return;
      for (const ch of text) {
        if (ch === '\r') { write(s, '\n'); const l = s.line; s.line = ''; run(s, l); }
        else if (ch === '\x7f') { if (s.line) { s.line = s.line.slice(0, -1); write(s, '\b \b'); } }
        else if (ch === '\x03') { s.line = ''; write(s, '^C\n'); prompt(s); }
        else if (ch === '\x0c') { write(s, '\x1b[2J\x1b[H'); prompt(s); write(s, s.line); }
        else if (ch >= ' ') { s.line += ch; write(s, ch); }
      }
    },

    kill(id: number): void {
      const s = sessions.get(id);
      if (s && s.info.state.t !== 'Exited') exit(s, 129);
    },

    close(id: number): void {
      const s = sessions.get(id);
      if (!s) return;
      stop(s);
      sessions.delete(id);
      send({ t: 'Closed', id });
    },

    promote(id: number): void {
      const s = sessions.get(id);
      if (s) s.info.task = false;
    },

    relist(id: number | null): void {
      send({ t: 'Hello', proto: PROTO, sessions: infos() });
      const s = id === null ? undefined : sessions.get(id);
      if (s) replay(s);
    },

    orphans: (): Orphans => orphans,

    /** Prints into a session as its program would; the newest session for no id. */
    print(text: string, id?: number): void {
      const s = sessionOf(id);
      if (s && s.info.state.t !== 'Exited') write(s, text);
    },

    /** Sets what claude's hooks reported, over the session's current state; the newest session for no id. */
    agent(patch: Partial<AgentState>, id?: number): void {
      const s = sessionOf(id);
      if (!s || s.info.state.t === 'Exited') return;
      const before = s.info.agent ?? idleAgent(Date.now());
      const agent = { ...before, ...patch, rev: patch.rev ?? before.rev + 1 };
      if (agent.phase === 'approval' && before.phase !== 'approval') s.pick = 0;
      s.info.agent = agent;
      send({ t: 'Agent', id: s.info.id, agent });
    },

    /** What the session printed, as the host's ring holds it; the newest session for no id. */
    text(id?: number): string {
      const s = sessionOf(id);
      if (!s) return '';
      const dec = new TextDecoder();
      return s.ring.map((b) => dec.decode(b, { stream: true })).join('') + dec.decode();
    },

    killOrphan,

    /** The session comes back into this host's rail, with nothing in its ring to replay. */
    restore(pid: number): void {
      const proc = [...orphans.hosts.flatMap((h) => h.sessions), ...orphans.escaped].find((p) => p.pid === pid);
      killOrphan(pid);
      const title = proc?.command.split(/\s+/)[0]?.split('/').at(-1) ?? 'sh';
      const s = add({ pid, title, cwd: d.root, tier: 'process', state: running(null) });
      start(s, 0, color(2, 'Browser mode: restored.\n'));
    },
  };
}
