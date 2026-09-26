import { describe, expect, it } from 'vitest';
import { orphanRows, type OrphanRow } from './orphans';
import type { Host, Info, Orphans, Proc } from '#ipc/terminal';

const SOCK = '/cfg/ptyd-2.sock';
const OLD = '/cfg/ptyd-1.sock';
const NEWER = '/cfg/ptyd-3.sock';
const proc = (pid: number, session: number | null, command = 'zsh'): Proc =>
  ({ pid, ppid: 1, pgid: pid, tty: 'ttys001', command, session, relay: null, holds_app: false, exiting: false });
const host = (pid: number, sock: string, sessions: Proc[], more: Partial<Host> = {}): Host =>
  ({ pid, sock, current: sock === SOCK, sock_exists: true, in_use: false, unclear: false,
    proto: Number(/ptyd-(\d+)/.exec(sock)?.[1]), relays: [], sessions, ...more });
const info = (id: number, state: Info['state'] = { t: 'Idle' }, more: Partial<Info> = {}): Info =>
  ({ id, title: 'zsh', cwd: '/r', tier: 'marks', state, ...more });
const brief = (rows: OrphanRow[]) => rows.map((r) => [r.status, r.session, r.restore?.t ?? null, r.kill?.t ?? null]);

describe('orphanRows', () => {
  it('marks what the sidebar shows and restores what it lost', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, 1), proc(12, 4)])], escaped: [] };
    expect(brief(orphanRows(r, [info(1), info(2), info(3, { t: 'Exited', code: 0 })]))).toEqual([
      ['shown', 1, null, 'close'],
      ['hidden', 4, 'relist', 'close'],
      ['ghost', 2, null, 'close'],
      ['exited', 3, null, null],
    ]);
  });

  it('relays each of a stale host\'s sessions, and only kills what escaped', () => {
    const r: Orphans = {
      sock: SOCK,
      hosts: [host(10, SOCK, []), host(20, OLD, [proc(21, 1, 'claude'), proc(22, 2, 'claude')])],
      escaped: [proc(30, 7, 'node server.js')],
    };
    const rows = orphanRows(r, []);
    expect(brief(rows)).toEqual([
      ['stale', 1, 'relay', 'signal'],
      ['stale', 2, 'relay', 'signal'],
      ['escaped', 7, null, 'signal'],
    ]);
    expect(rows[0]?.restore).toEqual({ t: 'relay', sock: OLD, id: 1, pid: 21 });
    expect(rows[2]?.why).toMatch(/no terminal/);

    const relays = [{ sock: OLD, id: 1, pid: null }];
    const relayed = { ...r, hosts: [host(10, SOCK, []), host(20, OLD, r.hosts[1]?.sessions ?? [], { relays })] };
    const after = orphanRows(relayed, []);
    expect(brief(after).slice(0, 2)).toEqual([['relayed', 1, null, 'signal'], ['stale', 2, 'relay', 'signal']]);
    expect(after[1]?.why).toBeNull();
  });

  it('cannot restore from a host whose socket is gone', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(20, OLD, [proc(21, 1)], { sock_exists: false })], escaped: [] };
    const [row] = orphanRows(r, []);
    expect(row?.restore).toBeNull();
    expect(row?.why).toMatch(/socket/);
  });

  it('matches a shell whose environment is hidden by the pid its host reported', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, null, '/bin/zsh -l')])], escaped: [] };
    expect(brief(orphanRows(r, [info(5, { t: 'Idle' }, { pid: 11 })]))).toEqual([['shown', 5, null, 'close']]);
  });

  it('pairs such a shell on a host too old to report pids, but only when it is the one left', () => {
    const one: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, null, '/bin/zsh -l')])], escaped: [] };
    expect(brief(orphanRows(one, [info(5)]))).toEqual([['shown', 5, null, 'close']]);

    // two of each cannot be told apart, and none of them may be offered a kill on a guess
    const two: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, null, '-zsh'), proc(12, null, '-zsh')])],
      escaped: [] };
    expect(brief(orphanRows(two, [info(5), info(6)]))).toEqual([
      ['unmatched', null, null, null],
      ['unmatched', null, null, null],
      ['unmatched', 5, null, null],
      ['unmatched', 6, null, null],
    ]);
  });

  it('pairs a lone hidden process with a lone entry, whatever it now runs', () => {
    // the shell ran `exec bash`, and is still the only thing entry 5 can be
    const r: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, null, 'bash')])], escaped: [] };
    expect(brief(orphanRows(r, [info(5)]))).toEqual([['shown', 5, null, 'close']]);
  });

  it('guesses nothing, and so kills nothing, once there is more than one of either', () => {
    // a sidebar out of step, and one session that ran `exec bash`
    const outOfStep: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, null, '-zsh'), proc(12, null, 'bash')])],
      escaped: [] };
    expect(orphanRows(outOfStep, [info(6)]).every((r) => r.status === 'unmatched' && !r.kill)).toBe(true);
    // two sessions that each exec'd into what the other was titled
    const swapped: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(21, null, 'zsh'), proc(22, null, 'sh')])],
      escaped: [] };
    const rows = orphanRows(swapped, [{ ...info(7), title: 'bash' }, info(8)]);
    expect(rows.every((r) => r.status === 'unmatched' && !r.kill)).toBe(true);
  });

  it('offers no kill for a ghost when there is no host to close it through', () => {
    const rows = orphanRows({ sock: SOCK, hosts: [], escaped: [] }, [info(5, { t: 'Idle' }, { pid: 40 })]);
    expect(brief(rows)).toEqual([['ghost', 5, null, null]]);
    expect(rows[0]?.why).toMatch(/no host/);
  });

  it('calls a sidebar entry a ghost only when no process could be it', () => {
    const one: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, null, '/bin/zsh -l')])], escaped: [] };
    const rows = orphanRows(one, [info(5), { ...info(6), title: 'claude' }]);
    expect(brief(rows)).toEqual([
      ['unmatched', null, null, null], ['unmatched', 5, null, null], ['unmatched', 6, null, null],
    ]);
    // a reported pid that is not running is conclusive
    const gone: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [])], escaped: [] };
    expect(brief(orphanRows(gone, [info(5, { t: 'Idle' }, { pid: 40 })]))).toEqual([['ghost', 5, null, 'close']]);
  });

  it('does not trust an id over a pid that says otherwise', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, 5), proc(12, null)])], escaped: [] };
    const rows = orphanRows(r, [info(5, { t: 'Idle' }, { pid: 12 })]);
    expect(rows.find((row) => row.pid === 11)?.status).toBe('hidden');
    expect(rows.find((row) => row.pid === 12)?.kill).toEqual({ t: 'close', id: 5, pid: 12 });
  });

  it('never pairs a process with an exited record whose pid it inherited', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [proc(11, 4)])], escaped: [] };
    const rows = orphanRows(r, [info(3, { t: 'Exited', code: 0 }, { pid: 11 }), info(4)]);
    expect(brief(rows)).toEqual([['shown', 4, null, 'close'], ['exited', 3, null, null]]);
  });

  it('offers no restore of a stale terminal CodeBär runs inside', () => {
    const inside: Proc = { ...proc(21, 1), holds_app: true };
    const [row] = orphanRows({ sock: SOCK, hosts: [host(20, OLD, [inside])], escaped: [] }, []);
    expect(row?.restore).toBeNull();
    expect(row?.kill).toBeNull();
  });

  it('offers no kill for a terminal CodeBär runs inside, or one on a host another app uses', () => {
    const inside: Proc = { ...proc(11, 5), holds_app: true };
    const own = orphanRows({ sock: SOCK, hosts: [host(10, SOCK, [inside])], escaped: [] }, [info(5)]);
    expect(own[0]?.kill).toBeNull();
    expect(own[0]?.why).toMatch(/itself/);
    const busy = orphanRows({ sock: SOCK, hosts: [host(20, OLD, [proc(21, 1)], { in_use: true })], escaped: [] }, []);
    expect(brief(busy)).toEqual([['stale', 1, null, null]]);
    expect(busy[0]?.why).toMatch(/another CodeBär/);
  });

  it('relays a stale shell by pid when its id is unreadable, if its host reports pids', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(20, NEWER, [proc(21, null, '/bin/zsh -l')])], escaped: [] };
    expect(orphanRows(r, [])[0]?.restore).toEqual({ t: 'relay', sock: NEWER, id: null, pid: 21 });
    const old: Orphans = { sock: SOCK, hosts: [host(20, OLD, [proc(21, null, '/bin/zsh -l')])], escaped: [] };
    const [row] = orphanRows(old, []);
    expect(row?.restore).toBeNull();
    expect(row?.why).toMatch(/too old/);
  });

  it('offers nothing on a host that shares its socket path with another', () => {
    const r: Orphans = { sock: SOCK, hosts: [host(20, OLD, [proc(21, 1)], { unclear: true })], escaped: [] };
    expect(brief(orphanRows(r, []))).toEqual([['stale', 1, null, null]]);
  });

  it('offers a kill instead of a restore for a session stuck exiting, on any host', () => {
    // as `ps` shows one: its arguments, environment and terminal are already gone
    const stuck = (pid: number, command: string): Proc =>
      ({ ...proc(pid, null, command), tty: '??', exiting: true });
    const r: Orphans = {
      sock: SOCK,
      hosts: [host(10, SOCK, [proc(11, 1), stuck(12, '(zsh)')]), host(20, OLD, [stuck(21, '(claude)')])],
      escaped: [],
    };
    const rows = orphanRows(r, [info(1, { t: 'Idle' }, { pid: 11 })]);
    expect(brief(rows)).toEqual([
      ['shown', 1, null, 'close'],
      ['stuck', null, null, 'signal'],
      ['stuck', null, null, 'signal'],
    ]);
    expect(rows[1]?.kill).toEqual({ t: 'signal', pid: 12 });
    expect(rows[1]?.why).toMatch(/nothing .*restore/);

    const busy = orphanRows({ sock: SOCK, hosts: [host(20, OLD, [stuck(21, '(zsh)')], { in_use: true })],
      escaped: [] }, []);
    expect(brief(busy)).toEqual([['stuck', null, null, null]]);
    expect(busy[0]?.why).toMatch(/another CodeBär/);
  });

  it('names a relay by what it relays', () => {
    const relay: Proc = { ...proc(13, 5, '/app/CodeBär --pty-relay /cfg/ptyd-1.sock 1'),
      relay: { sock: OLD, id: 1, pid: null } };
    const r: Orphans = { sock: SOCK, hosts: [host(10, SOCK, [relay])], escaped: [] };
    expect(orphanRows(r, [info(5)])[0]?.command).toBe('relay to ptyd-1.sock #1');
  });
});
