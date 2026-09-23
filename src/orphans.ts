import type { Host, Info, Orphans, Proc } from './terminal';

export type Status =
  | 'shown' | 'hidden' | 'unmatched' | 'relayed' | 'stale' | 'stuck' | 'escaped' | 'ghost' | 'exited';

export type OrphanAction =
  | { t: 'relist'; id: number | null }
  | { t: 'relay'; sock: string; id: number | null; pid: number }
  | { t: 'close'; id: number; pid: number | null }
  | { t: 'signal'; pid: number };

/** A scan, with the sidebar's list as it was just before the processes were listed. */
export type OrphanScan = { report: Orphans; listed: Info[] };

export type OrphanRow = {
  key: string;
  status: Status;
  session: number | null;
  pid: number | null;
  tty: string;
  command: string;
  host: string;
  restore: OrphanAction | null;
  kill: OrphanAction | null;
  /** Why an action is missing, shown in its place. */
  why: string | null;
};

export const STATUS: Record<Status, string> = {
  shown: 'In sidebar',
  hidden: 'Not in sidebar',
  unmatched: 'Unmatched',
  relayed: 'Relayed',
  stale: 'Stale host',
  stuck: 'Stuck exiting',
  escaped: 'Escaped',
  ghost: 'No process',
  exited: 'Exited',
};

/** Working as intended. */
export const HEALTHY: ReadonlySet<Status> = new Set(['shown', 'relayed', 'exited']);
/** Known to be lost. An unmatched row is only unknown, so it is not counted as one. */
export const ORPHANED: ReadonlySet<Status> = new Set(['hidden', 'stale', 'stuck', 'escaped', 'ghost']);

const UNMATCHED = 'cannot match it: its id is hidden, and its host reports no pids';
const HOLDS_APP = 'CodeBär itself runs inside it';
const NO_HOST = 'no host was found to close it through';
const RESTORE_FIRST = 'its id is hidden: restore it, then close it from the sidebar';
const UNCLEAR = 'another host claims its socket path';
const IN_USE = 'another CodeBär is attached to its host';
const STUCK = 'it is stuck exiting, so nothing is left to restore';

export const sockName = (sock: string): string => sock.slice(sock.lastIndexOf('/') + 1);

const commandOf = (p: Proc): string => {
  if (!p.relay) return p.command;
  return `relay to ${sockName(p.relay.sock)} ${p.relay.id === null ? `pid ${p.relay.pid}` : `#${p.relay.id}`}`;
};

const live = (t: Info): boolean => t.state.t !== 'Exited';

/** Which sidebar session each of the current host's processes is, keyed by pid. */
function matchSessions(children: Proc[], listed: Info[]): Map<number, number> {
  const match = new Map<number, number>();
  const taken = new Set<number>();
  const pair = (p: Proc, t: Info) => {
    match.set(p.pid, t.id);
    taken.add(t.id);
  };
  for (const p of children) {
    // an entry that reports a different pid is some other process, whatever the id says
    const t = listed.find((t) => !taken.has(t.id) && t.id === p.session && (t.pid == null || t.pid === p.pid));
    if (t) pair(p, t);
  }
  // after the ids, and never with an exited record, whose pid may since belong to someone else
  for (const p of children.filter((p) => !match.has(p.pid))) {
    const t = listed.find((t) => !taken.has(t.id) && live(t) && t.pid === p.pid);
    if (t) pair(p, t);
  }
  // a host from before sessions reported their pid, running a platform binary such as /bin/zsh
  // whose environment is hidden, gives nothing to match by. One of each left over is paired: with
  // the list taken before the processes, the entry's process, if it has one, can only be that one,
  // so even a wrong pairing kills nothing live. Its program is no help either, as a shell that ran
  // `exec bash` no longer looks like its title.
  const loose = children.filter((p) => !match.has(p.pid) && p.session === null);
  const open = listed.filter((t) => !taken.has(t.id) && t.pid == null && live(t));
  const [kid] = loose;
  const [entry] = open;
  if (loose.length === 1 && open.length === 1 && kid && entry) pair(kid, entry);
  return match;
}

function relays(h: Host, p: Proc): boolean {
  const r = h.relay;
  return r !== null && ((r.id !== null && r.id === p.session) || (r.pid !== null && r.pid === p.pid));
}

export function orphanRows(r: Orphans, listed: Info[]): OrphanRow[] {
  const rows: OrphanRow[] = [];
  const current = r.hosts.find((h) => h.current);
  const children = current?.sessions ?? [];
  const match = matchSessions(children, listed);
  const matched = new Set(match.values());
  // any of these could be any of those
  const leftKids = children.filter((p) => !match.has(p.pid) && p.session === null);
  const leftListed = listed.filter((t) => !matched.has(t.id) && t.pid == null && live(t));
  const base = (p: Proc, host: string) =>
    ({ key: `p${p.pid}`, pid: p.pid, tty: p.tty, command: commandOf(p), host });
  // no signal ends one, and the backend, given its pid, flushes the terminals its host left behind
  const stuck = (p: Proc, host: string, blocked: string | null): OrphanRow => ({
    ...base(p, host), session: p.session, status: 'stuck', restore: null,
    kill: blocked ? null : { t: 'signal', pid: p.pid }, why: blocked ?? STUCK,
  });

  for (const p of children) {
    if (p.exiting && !match.has(p.pid)) {
      rows.push(stuck(p, sockName(current?.sock ?? ''), p.holds_app ? HOLDS_APP : null));
      continue;
    }
    const id = match.get(p.pid) ?? p.session;
    const shown = match.has(p.pid);
    const unmatched = !shown && id === null && leftListed.length > 0;
    let status: Status = 'hidden';
    if (shown) status = 'shown';
    else if (unmatched) status = 'unmatched';
    rows.push({
      ...base(p, sockName(current?.sock ?? '')),
      session: id,
      status,
      restore: shown || unmatched ? null : { t: 'relist', id },
      kill: id === null || unmatched || p.holds_app ? null : { t: 'close', id, pid: p.pid },
      why: unmatched ? UNMATCHED : p.holds_app ? HOLDS_APP : id === null ? RESTORE_FIRST : null,
    });
  }
  // an exited session keeps its record and scrollback with no process behind it
  for (const t of listed.filter((t) => !matched.has(t.id))) {
    // with no pid to go by, it is only known to have no process when no hidden process could be it
    const unknown = t.pid == null && live(t) && leftKids.length > 0;
    let status: Status = 'ghost';
    if (!live(t)) status = 'exited';
    else if (unknown) status = 'unmatched';
    let why: string | null = null;
    if (unknown) why = UNMATCHED;
    else if (status === 'ghost' && !current) why = NO_HOST;
    rows.push({
      key: `s${t.id}`, status, session: t.id, pid: null, tty: '', command: t.title,
      host: current ? sockName(current.sock) : '', restore: null,
      kill: status === 'ghost' && current ? { t: 'close', id: t.id, pid: null } : null,
      why,
    });
  }
  for (const h of r.hosts.filter((h) => !h.current)) {
    for (const p of h.sessions) {
      if (p.exiting) {
        rows.push(stuck(p, `${sockName(h.sock)} · pid ${h.pid}`,
          h.in_use ? IN_USE : h.unclear ? UNCLEAR : p.holds_app ? HOLDS_APP : null));
        continue;
      }
      const relayed = relays(h, p);
      let why: string | null = null;
      const tooOld = p.session === null && (h.proto ?? 0) < 2;
      if (h.in_use) why = IN_USE;
      else if (h.unclear) why = UNCLEAR;
      else if (p.holds_app) why = HOLDS_APP;
      else if (!h.sock_exists) why = 'its host has lost its socket';
      else if (h.relay !== null && !relayed) why = 'its host already has a relay';
      else if (tooOld && !relayed) why = 'its id is hidden, and its host is too old to find it by pid';
      const open = !relayed && !h.in_use && !h.unclear && h.sock_exists && h.relay === null && !tooOld
        && !p.holds_app;
      rows.push({
        ...base(p, `${sockName(h.sock)} · pid ${h.pid}`),
        session: p.session,
        status: relayed ? 'relayed' : 'stale',
        restore: open ? { t: 'relay', sock: h.sock, id: p.session, pid: p.pid } : null,
        kill: h.in_use || h.unclear || p.holds_app ? null : { t: 'signal', pid: p.pid },
        why,
      });
    }
  }
  for (const p of r.escaped) {
    rows.push({
      ...base(p, ''), session: p.session, status: 'escaped', restore: null,
      kill: p.holds_app ? null : { t: 'signal', pid: p.pid },
      why: p.holds_app ? HOLDS_APP : 'no terminal is left to attach it to',
    });
  }
  return rows;
}
