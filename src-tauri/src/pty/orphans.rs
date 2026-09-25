use std::collections::{HashMap, HashSet};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use super::client;
use super::daemon::{quote, HUP_GRACE, TERM_GRACE};
use super::proto::SpawnKind;
use super::relay::{self, Target};
use crate::AppError;

const HOST_ARG: &str = " --pty-host ";
const RELAY_ARG: &str = " --pty-relay ";
const BRIDGE_ARG: &str = " --pty-bridge ";
const TAG: &str = "CODEBAER_SESSION=";

/// What a relay is attached to. `pid` is set instead of `id` for a session whose id was unreadable.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Relay {
    pub sock: String,
    pub id: Option<u32>,
    pub pid: Option<i32>,
}

impl Relay {
    fn to(sock: &str, target: &Target) -> Relay {
        let (id, pid) = match *target {
            Target::Id(id) => (Some(id), None),
            Target::Pid(pid) => (None, Some(pid)),
        };
        Relay { sock: sock.to_string(), id, pid }
    }

    /// Whether `p`, a session of this relay's host, is the one it relays.
    fn reaches(&self, p: &Proc) -> bool {
        self.pid == Some(p.pid) || (self.id.is_some() && self.id == p.session)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    #[serde(skip)]
    pub uid: u32,
    pub tty: String,
    pub command: String,
    pub session: Option<u32>,
    /// Set when this process is a relay, with the stale host and session it is attached to.
    pub relay: Option<Relay>,
    /// CodeBär itself descends from this process or shares its group, so ending it ends the app:
    /// `pnpm tauri dev` run from one of its own terminals.
    pub holds_app: bool,
    /// Caught partway through exit, which `ps` marks `E`: nothing is left of it to restore.
    pub exiting: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Host {
    pub pid: i32,
    pub sock: String,
    pub current: bool,
    /// Also false when the file at its path now belongs to another host: `bind` replaces the
    /// socket of a host that stopped answering, which leaves the old one unreachable.
    pub sock_exists: bool,
    /// Some other client is attached, most likely a CodeBär built for that host's version, and
    /// its terminals are that app's to restore or kill.
    pub in_use: bool,
    /// Another host claims the same socket path, and a connection by path reaches whichever of
    /// them owns the file: nothing sent there can be aimed at this one.
    pub unclear: bool,
    /// From the socket's name. Hosts of version 1 predate `Info::pid`, so a session of theirs
    /// whose id is hidden can never be found in them.
    pub proto: Option<u32>,
    /// A host serves one client, so these share its connection through a bridge.
    pub relays: Vec<Relay>,
    /// Direct children leading their own group, which is what the host spawns. A tty is not
    /// required: one that is exiting has already lost it and is still the host's.
    pub sessions: Vec<Proc>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Report {
    pub sock: String,
    pub hosts: Vec<Host>,
    /// Tagged by a session but with no host above them, so no teardown or idle timer reaches them.
    pub escaped: Vec<Proc>,
}

struct Snapshot {
    procs: Vec<Proc>,
    parent: HashMap<i32, i32>,
}

/// What a scan is judged against.
struct Ctx<'a> {
    sock: &'a str,
    /// The host at the far end of the app's own connection, when it has one.
    peer: Option<i32>,
    /// The app binary's file name. Anything else passing `--pty-host` is not a host.
    exe: &'a str,
    me: i32,
    /// `ps -ax` lists every account's processes, and another's are neither ours to judge nor to kill.
    uid: u32,
}

fn word(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    s.split_at(s.find(char::is_whitespace).unwrap_or(s.len()))
}

struct Line<'a> {
    pid: i32,
    ppid: i32,
    pgid: i32,
    uid: u32,
    stat: &'a str,
    tty: &'a str,
    rest: &'a str,
}

/// `pid ppid pgid uid stat tty rest`, with `rest` kept verbatim because a command line has spaces in it.
fn parse_line(line: &str) -> Option<Line<'_>> {
    let (pid, rest) = word(line);
    let (ppid, rest) = word(rest);
    let (pgid, rest) = word(rest);
    let (uid, rest) = word(rest);
    let (stat, rest) = word(rest);
    let (tty, rest) = word(rest);
    Some(Line {
        pid: pid.parse().ok()?,
        ppid: ppid.parse().ok()?,
        pgid: pgid.parse().ok()?,
        uid: uid.parse().ok()?,
        stat,
        tty,
        rest: rest.trim_start(),
    })
}

fn session_of(env: &str) -> Option<u32> {
    env.split(' ').find_map(|tok| tok.strip_prefix(TAG)?.parse().ok())
}

/// Cargo builds `CodeBär` and the bundle renames it (`mainBinaryName`), and a dev build and an
/// installed one share the host socket, so either name is the app's own.
const NAMES: [&str; 2] = ["CodeBär", "codebaer"];

/// The arguments after `arg`, when the program before it is the app's own binary.
fn ours<'a>(command: &'a str, arg: &str, exe: &str) -> Option<&'a str> {
    let (argv0, rest) = command.split_once(arg)?;
    let name = argv0.rsplit('/').next()?;
    (name == exe || NAMES.contains(&name)).then_some(rest)
}

/// The socket path has spaces in it ("Application Support"), so the target is taken from the end.
fn relay_of(command: &str, exe: &str) -> Option<Relay> {
    let (sock, target) = ours(command, RELAY_ARG, exe)?.rsplit_once(' ')?;
    Some(Relay::to(sock, &Target::parse(target)?))
}

/// `plain` and `with_env` are the same `ps` listing without and with `-E`. `ps` appends the
/// environment to the command column with nothing to mark where it starts, so the plain listing
/// is what tells the two apart.
fn snapshot(plain: &str, with_env: &str, exe: &str) -> Snapshot {
    let envs: HashMap<i32, &str> = with_env.lines().filter_map(parse_line).map(|l| (l.pid, l.rest)).collect();
    let procs: Vec<Proc> = plain
        .lines()
        .filter_map(parse_line)
        .map(|l| {
            // a mismatch is a pid reused between the two listings, whose environment is unknown
            let env = envs.get(&l.pid).and_then(|e| e.strip_prefix(l.rest));
            Proc {
                pid: l.pid,
                ppid: l.ppid,
                pgid: l.pgid,
                uid: l.uid,
                tty: l.tty.to_string(),
                command: l.rest.to_string(),
                session: env.and_then(session_of),
                relay: relay_of(l.rest, exe),
                holds_app: false,
                exiting: l.stat.contains('E'),
            }
        })
        .collect();
    let parent = procs.iter().map(|p| (p.pid, p.ppid)).collect();
    Snapshot { procs, parent }
}

/// The app's own ancestry, and the groups it runs in.
fn lineage(snap: &Snapshot, me: i32) -> (HashSet<i32>, HashSet<i32>) {
    let mut pids = HashSet::from([me]);
    let mut at = me;
    while let Some(&up) = snap.parent.get(&at) {
        if up <= 1 || !pids.insert(up) {
            break;
        }
        at = up;
    }
    let groups = snap.procs.iter().filter(|p| pids.contains(&p.pid)).map(|p| p.pgid).collect();
    (pids, groups)
}

/// Refuses to judge a listing that does not contain the host the app is connected to: whatever
/// hid it would make that host's live sessions look like orphans.
fn classify(
    snap: &Snapshot,
    ctx: &Ctx,
    exists: impl Fn(&str) -> bool,
    has_client: impl Fn(i32) -> bool,
) -> Result<Report, String> {
    let (app_pids, app_groups) = lineage(snap, ctx.me);
    let mark = |p: &Proc| Proc { holds_app: app_pids.contains(&p.pid) || app_groups.contains(&p.pgid), ..p.clone() };
    let procs: Vec<&Proc> = snap.procs.iter().filter(|p| p.uid == ctx.uid).collect();
    let mut on_path: HashMap<&str, usize> = HashMap::new();
    for sock in procs.iter().filter_map(|p| ours(&p.command, HOST_ARG, ctx.exe)) {
        *on_path.entry(sock).or_default() += 1;
    }
    let mut hosts: Vec<Host> = procs
        .iter()
        .filter_map(|p| {
            let sock = ours(&p.command, HOST_ARG, ctx.exe)?;
            let shared = on_path.get(sock).copied().unwrap_or(0) > 1;
            // with no connection to ask, two hosts on one path leave no way to tell which answers it
            let current = ctx.peer.map_or(sock == ctx.sock && !shared, |peer| peer == p.pid);
            let unclear = !current && shared;
            // matched by path alone, so a path two hosts share cannot say whose relay it is
            let relays: Vec<Relay> =
                procs.iter().filter_map(|r| r.relay.clone().filter(|r| r.sock == sock && !unclear)).collect();
            // the bridge's connection is this app's own, even while no relay is on it yet
            let bridged = !unclear && procs.iter().any(|b| ours(&b.command, BRIDGE_ARG, ctx.exe) == Some(sock));
            Some(Host {
                pid: p.pid,
                sock: sock.to_string(),
                current,
                sock_exists: exists(sock) && !unclear,
                in_use: !current && relays.is_empty() && !bridged && has_client(p.pid),
                unclear,
                proto: relay::proto_of(Path::new(sock)),
                relays,
                // not held to the account filter: a session that ran `exec sudo -s` is still one
                sessions: snap.procs.iter().filter(|c| c.ppid == p.pid && c.pgid == c.pid).map(mark).collect(),
            })
        })
        .collect();
    // a relay to a session the app runs inside carries the app too: closing it closes that session.
    // Judged against every host on the relay's path, unclear ones included, since marking one too
    // many is harmless and missing one is not.
    let held: Vec<Relay> = procs
        .iter()
        .filter_map(|r| r.relay.clone())
        .filter(|relay| {
            hosts.iter().filter(|h| !h.current && h.sock == relay.sock).flat_map(|h| &h.sessions).any(|p| p.holds_app && relay.reaches(p))
        })
        .collect();
    for p in hosts.iter_mut().flat_map(|h| h.sessions.iter_mut()) {
        if p.relay.as_ref().is_some_and(|r| held.contains(r)) {
            p.holds_app = true;
        }
    }
    if let Some(peer) = ctx.peer.filter(|peer| !hosts.iter().any(|h| h.pid == *peer)) {
        return Err(format!("the scan cannot see the host this app is connected to (pid {peer}), so it cannot be trusted"));
    }
    hosts.sort_by_key(|h| (!h.current, h.pid));
    let host_pids: HashSet<i32> = hosts.iter().map(|h| h.pid).collect();

    let under_host = |mut pid: i32| {
        // bounded, in case the snapshot caught a pid being reused mid-walk and made a cycle, and
        // then taken as under a host: escaped is the verdict that gets a kill
        for _ in 0..64 {
            match snap.parent.get(&pid) {
                Some(&up) if host_pids.contains(&up) => return true,
                Some(&up) if up > 1 => pid = up,
                _ => return false,
            }
        }
        true
    };
    let escaped = procs
        .iter()
        .filter(|p| p.session.is_some() && !host_pids.contains(&p.pid) && !under_host(p.pid))
        .map(|p| mark(p))
        .collect();
    Ok(Report { sock: ctx.sock.to_string(), hosts, escaped })
}

fn refuse(host: &Host, p: &Proc) -> Result<(), String> {
    if host.in_use {
        return Err("another CodeBär is attached to that host, and its terminals are its to end".into());
    }
    if host.unclear {
        return Err("another host claims that host's socket path, so which one this is cannot be told".into());
    }
    if p.holds_app {
        return Err("that would take CodeBär itself down with it".into());
    }
    Ok(())
}

/// What to signal for `pid`, negative for a whole process group. Only stale-host sessions and
/// escaped processes qualify: a session of the current host is closed through the host instead.
fn kill_targets(snap: &Snapshot, report: &Report, pid: i32, me: i32) -> Result<Vec<i32>, String> {
    let stale = report.hosts.iter().filter(|h| !h.current).find_map(|h| Some((h, h.sessions.iter().find(|p| p.pid == pid)?)));
    let targets = if let Some((host, p)) = stale {
        refuse(host, p)?;
        // what the host itself signals: a job-control shell's jobs sit in groups of their own and
        // are reached only by the shell hanging them up in turn
        vec![-p.pgid]
    } else if report.escaped.iter().any(|p| p.pid == pid) {
        // every descendant, not just the tagged ones: a platform binary's environment is hidden
        let mut tree = vec![pid];
        loop {
            let more: Vec<i32> =
                snap.procs.iter().filter(|p| tree.contains(&p.ppid) && !tree.contains(&p.pid)).map(|p| p.pid).collect();
            if more.is_empty() {
                break tree;
            }
            tree.extend(more);
        }
    } else {
        return Err(format!("pid {pid} is no longer an orphan"));
    };

    let (app_pids, app_groups) = lineage(snap, me);
    let group_of = |pid: i32| snap.procs.iter().find(|p| p.pid == pid).map(|p| p.pgid);
    let hits_app = |t: i32| {
        if t < 0 { app_groups.contains(&-t) } else { app_pids.contains(&t) || group_of(t).is_some_and(|g| app_groups.contains(&g)) }
    };
    if targets.iter().any(|&t| hits_app(t)) {
        return Err("that would take CodeBär itself down with it".into());
    }
    Ok(targets)
}

/// The host of `pid` when that is a session stuck exiting, which no signal ends: see `unstick`.
fn stuck_host(report: &Report, pid: i32) -> Result<Option<i32>, String> {
    let found = report.hosts.iter().find_map(|h| Some((h, h.sessions.iter().find(|p| p.pid == pid && p.exiting)?)));
    let Some((host, p)) = found else { return Ok(None) };
    refuse(host, p)?;
    Ok(Some(host.pid))
}

/// From sys/proc_info.h, which libc covers only partly. The call reports how much it wrote, and
/// anything but this struct's size is taken as a mismatch.
const PROC_PIDFDVNODEPATHINFO: i32 = 2;

#[repr(C)]
struct ProcFileInfo {
    fi_openflags: u32,
    fi_status: u32,
    fi_offset: i64,
    fi_type: i32,
    fi_guardflags: u32,
}

#[repr(C)]
struct VnodeFdInfoWithPath {
    pfi: ProcFileInfo,
    pvip: libc::vnode_info_path,
}

/// The ptys whose master `pid` holds, named as `ps` names a tty.
fn host_ptys(pid: i32) -> Result<Vec<String>, String> {
    let unreadable = || format!("cannot list the files its host, pid {pid}, holds open");
    let each = std::mem::size_of::<libc::proc_fdinfo>();
    let need = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return Err(unreadable());
    }
    // with room for files opened between the two calls
    let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(need as usize / each + 16);
    let room = (fds.capacity() * each) as i32;
    let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), room) };
    if got <= 0 {
        return Err(unreadable());
    }
    unsafe { fds.set_len(got as usize / each) };
    let size = std::mem::size_of::<VnodeFdInfoWithPath>() as i32;
    let mut names = Vec::new();
    for fd in fds.iter().filter(|f| f.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32) {
        let mut info = std::mem::MaybeUninit::<VnodeFdInfoWithPath>::zeroed();
        if unsafe { libc::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDVNODEPATHINFO, info.as_mut_ptr().cast(), size) } != size {
            continue;
        }
        let info = unsafe { info.assume_init() };
        let path = unsafe { std::ffi::CStr::from_ptr(info.pvip.vip_path.as_ptr().cast()) };
        if path.to_bytes() != b"/dev/ptmx" {
            continue;
        }
        // xnu names a clone's slave after the master's minor. Should that template ever change,
        // the check keeps the flush from reaching some other terminal.
        let minor = info.pvip.vip_vi.vi_stat.vst_rdev & 0x00ff_ffff;
        let name = format!("ttys{minor:03}");
        let slave = std::fs::metadata(format!("/dev/{name}"));
        if slave.is_ok_and(|m| m.file_type().is_char_device() && m.rdev() & 0x00ff_ffff == u64::from(minor)) {
            names.push(name);
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

/// Every tty some process has as its terminal, whoever's process it is.
fn ttys_in_use() -> Result<HashSet<String>, String> {
    let out = Command::new("/bin/ps").args(["-ax", "-o", "tty="]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("cannot list the terminals in use".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).collect())
}

/// Throws away what is queued for the master to read. Opened non-blocking so the open cannot
/// wait, and never as anyone's controlling terminal.
fn flush(tty: &str) -> bool {
    let Ok(path) = std::ffi::CString::new(format!("/dev/{tty}")) else { return false };
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK) };
    if fd < 0 {
        return false;
    }
    let flushed = unsafe { libc::tcflush(fd, libc::TCOFLUSH) } == 0;
    unsafe { libc::close(fd) };
    flushed
}

/// A child that exits with output still queued on its tty waits in exit for the tty to drain,
/// which no signal cuts short, and which nothing does while its host holds the master without
/// reading it. The tty no longer shows on the process, so every pty of its host that no process
/// has as its terminal any more is flushed. Done once the host has reaped it.
pub fn unstick(host: i32, pid: i32) -> Result<(), String> {
    // listed before the terminals in use, so one opened in between cannot pass for a leftover
    let held = host_ptys(host)?;
    let used = ttys_in_use()?;
    let leftover: Vec<&String> = held.iter().filter(|t| !used.contains(t.as_str())).collect();
    if leftover.is_empty() {
        return Err("its host holds no leftover terminal to flush".into());
    }
    let flushed = leftover.iter().filter(|t| flush(t)).count();
    if flushed == 0 {
        return Err("none of its host's leftover terminals could be opened to flush".into());
    }
    // EPERM is a session that went to another account, and still there
    let alive = || unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    let until = Instant::now() + Duration::from_secs(2);
    while alive() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(25));
    }
    if alive() {
        return Err(format!("its host's leftover terminals were flushed ({flushed}), and it has still not ended"));
    }
    Ok(())
}

/// A copy of the host's escalation timing, stopping early once nothing answers `kill(0)`. A zombie
/// still answers it, so a group whose leader is dead but not yet reaped sits out the full grace.
fn escalate(targets: &[i32]) -> Result<(), String> {
    // EPERM would otherwise read as already gone, and the kill would report success
    let refused = |t: &i32| unsafe { libc::kill(*t, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    if targets.iter().any(refused) {
        return Err("that belongs to another account, which this app is not allowed to signal".into());
    }
    let alive = |t: &i32| unsafe { libc::kill(*t, 0) } == 0;
    for (sig, grace) in [(libc::SIGHUP, HUP_GRACE), (libc::SIGTERM, TERM_GRACE), (libc::SIGKILL, Duration::ZERO)] {
        let live: Vec<i32> = targets.iter().copied().filter(alive).collect();
        if live.is_empty() {
            return Ok(());
        }
        for t in live {
            unsafe { libc::kill(t, sig) };
        }
        let until = Instant::now() + grace;
        while Instant::now() < until && targets.iter().any(alive) {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(())
}

/// A host's listener is one unix socket and an attached client's connection makes more. Unix ones
/// only: a host also inherits whatever other sockets the app that started it held, and keeps them.
/// Answers yes when it cannot tell, since a wrong no hands another app's terminals to this one.
pub fn has_client(pid: i32) -> bool {
    let out = Command::new("/usr/sbin/lsof").args(["-a", "-U", "-p", &pid.to_string(), "-F", "f"]).output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.starts_with('f')).count() > 1,
        _ => true,
    }
}

fn ps(env: bool) -> Result<String, AppError> {
    let mut cmd = Command::new("/bin/ps");
    // an app started from Finder has no locale, and ps then escapes the "ä" in the app's own name
    cmd.env("LC_ALL", "en_US.UTF-8").arg("-axww");
    if env {
        cmd.arg("-E");
    }
    let out = cmd.args(["-o", "pid=,ppid=,pgid=,uid=,stat=,tty=,command="]).output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

fn scan<R: Runtime>(app: &AppHandle<R>) -> Result<(Snapshot, Report), AppError> {
    let sock = client::sock_path(app)?.to_string_lossy().into_owned();
    let exe = std::env::current_exe()?;
    let exe = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // read on both sides of the listing and trusted only when the two agree, since a reconnect
    // mid-scan would otherwise make the listing look like it is missing the app's host
    let before = client::host_pid(app);
    let snap = snapshot(&ps(false)?, &ps(true)?, &exe);
    let peer = client::host_pid(app);
    // guessing the host by path instead would judge the app's list against the wrong host's
    // sessions, whose ids collide with it, since every host counts from 1
    if peer != before {
        return Err(AppError::Io("the connection to the terminal host changed during the scan; scan again".into()));
    }
    if peer.is_some_and(|p| unsafe { libc::kill(p, 0) } != 0) {
        return Err(AppError::Io("the terminal host this app is connected to has gone; scan again".into()));
    }
    let uid = unsafe { libc::getuid() };
    let ctx = Ctx { sock: &sock, peer, exe: &exe, me: std::process::id() as i32, uid };
    let report = classify(&snap, &ctx, exists, has_client).map_err(AppError::Io)?;
    Ok((snap, report))
}

/// The host titles a session after its program's file name, so the script is named after the
/// old session's program and the rail shows it as that.
fn program_name(command: &str) -> String {
    let first = command.split(' ').next().unwrap_or_default();
    let base = first.rsplit('/').next().unwrap_or_default().trim_start_matches('-');
    let clean: String = base.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect();
    if clean.chars().all(|c| c == '.') { "relay".into() } else { clean }
}

/// Checks a restore against a fresh report and says what the relay should attach to.
fn plan_restore(report: &Report, dir: Option<&Path>, sock: &str, id: Option<u32>, pid: i32) -> Result<(Target, String), String> {
    // only this app's own hosts: the relay is about to be handed the socket as its target
    let host = report
        .hosts
        .iter()
        .find(|h| !h.current && h.sock == sock && Path::new(&h.sock).parent() == dir)
        .ok_or("that is not a stale host of this app")?;
    if host.unclear {
        return Err("another host claims that socket path, and the relay would reach whichever owns it".into());
    }
    if !host.sock_exists {
        return Err("its socket is gone, so nothing can reach it any more".into());
    }
    if host.in_use {
        return Err("another CodeBär is attached to that host, and a relay would take its connection".into());
    }
    let p = host
        .sessions
        .iter()
        .find(|p| p.pid == pid && (id.is_none() || p.session == id))
        .ok_or_else(|| format!("pid {pid} is no longer a session there"))?;
    if host.relays.iter().any(|r| r.reaches(p)) {
        return Err("that session is already relayed".into());
    }
    // the relay would carry the app, and closing the relay closes the session around the app
    if p.holds_app {
        return Err("CodeBär itself runs inside that session".into());
    }
    if p.session.is_none() && host.proto.is_none_or(|v| v < 2) {
        return Err("that host is older than session pids, and this session's id is hidden".into());
    }
    let target = p.session.map_or(Target::Pid(pid), Target::Id);
    Ok((target, program_name(&p.command)))
}

/// Held from validation until the relay shows up, since until then a second restore of the same
/// session would pass the same checks and open a terminal its host's bridge then turns away.
const RELAY_WAIT: Duration = Duration::from_secs(30);
static RESTORING: Mutex<Vec<(String, i32)>> = Mutex::new(Vec::new());

struct Claim(String, i32);

impl Claim {
    fn take(sock: &str, pid: i32) -> Option<Claim> {
        let mut held = RESTORING.lock().unwrap();
        if held.iter().any(|(s, p)| s == sock && *p == pid) {
            return None;
        }
        held.push((sock.to_string(), pid));
        Some(Claim(sock.to_string(), pid))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        RESTORING.lock().unwrap().retain(|(s, p)| *s != self.0 || *p != self.1);
    }
}

/// Only whether this relay is running: one plain listing, where a full scan would be four
/// processes every quarter second.
fn relay_running(want: &Relay) -> bool {
    let exe = std::env::current_exe().ok().and_then(|e| e.file_name().map(|n| n.to_string_lossy().into_owned()));
    let out = Command::new("/bin/ps").env("LC_ALL", "en_US.UTF-8").args(["-axww", "-o", "command="]).output();
    let (Some(exe), Ok(out)) = (exe, out) else { return false };
    String::from_utf8_lossy(&out.stdout).lines().any(|l| relay_of(l.trim(), &exe).as_ref() == Some(want))
}

/// A spawn names one program and no arguments, so the relay's command line goes in a script
/// that deletes itself before it execs. Returns the script and the folder that holds it.
fn write_script(exe: &Path, sock: &str, target: &Target, name: &str) -> Result<(String, PathBuf), AppError> {
    let dir = tempfile::Builder::new().prefix("codebaer-relay-").tempdir()?;
    let path = dir.path().join(name);
    let exec = format!("exec {} --pty-relay {} {target}", quote(&exe.to_string_lossy()), quote(sock));
    std::fs::write(&path, format!("#!/bin/sh\nrm -f \"$0\"; rmdir \"${{0%/*}}\"\n{exec}\n"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    Ok((path.to_string_lossy().into_owned(), dir.keep()))
}

/// Read-only: it reports, and leaves every process it finds running.
#[tauri::command(async)]
pub fn term_orphans<R: Runtime>(app: AppHandle<R>) -> Result<Report, AppError> {
    Ok(scan(&app)?.1)
}

/// Opens a terminal in the current host that relays one session of a stale host. `id` is None
/// for a session whose environment `ps` could not read, and the relay then finds it by `pid`.
#[tauri::command(async)]
pub fn term_restore<R: Runtime>(
    app: AppHandle<R>,
    git: State<'_, crate::git::AppState>,
    sock: String,
    id: Option<u32>,
    pid: i32,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let Some(claim) = Claim::take(&sock, pid) else {
        return Err(AppError::Io("a restore of that session is already starting".into()));
    };
    let current = client::sock_path(&app)?;
    let (target, name) = plan_restore(&scan(&app)?.1, current.parent(), &sock, id, pid).map_err(AppError::Io)?;
    let (script, dir) = write_script(&std::env::current_exe()?, &sock, &target, &name)?;
    let want = Relay::to(&sock, &target);
    let cwd = git.root().map(|r| r.to_string_lossy().into_owned()).or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| "/".into());
    if let Err(e) = client::request_spawn(&app, SpawnKind::Command { argv0: script }, cwd, cols, rows) {
        let _ = std::fs::remove_dir_all(dir);
        return Err(e);
    }
    // a login shell's profile can take its time, so the claim outlives this call
    let (up, arrived) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _claim = claim;
        let until = Instant::now() + RELAY_WAIT;
        let mut ran: Option<Instant> = None;
        while Instant::now() < until {
            std::thread::sleep(Duration::from_millis(250));
            if relay_running(&want) {
                let _ = up.send(());
                return;
            }
            // the script deletes itself just before it execs the relay, so once it is gone a relay
            // that has still not shown up has already given up
            if !dir.exists() && ran.get_or_insert_with(Instant::now).elapsed() > Duration::from_secs(1) {
                return;
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    });
    // long enough for a rescan straight after to show the relay in the usual case
    let _ = arrived.recv_timeout(Duration::from_secs(3));
    Ok(())
}

/// Takes a fresh snapshot, so a pid from an older one is refused unless it is an orphan now.
#[tauri::command(async)]
pub fn term_kill_orphan<R: Runtime>(app: AppHandle<R>, pid: i32) -> Result<(), AppError> {
    let (snap, report) = scan(&app)?;
    if let Some(host) = stuck_host(&report, pid).map_err(AppError::Io)? {
        return unstick(host, pid).map_err(AppError::Io);
    }
    let targets = kill_targets(&snap, &report, pid, std::process::id() as i32).map_err(AppError::Io)?;
    escalate(&targets).map_err(AppError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOCK: &str = "/Users/u/Library/Application Support/app/ptyd-2.sock";
    const OLD: &str = "/Users/u/Library/Application Support/app/ptyd-1.sock";
    const NEWER: &str = "/Users/u/Library/Application Support/app/ptyd-3.sock";
    const EXE: &str = "CodeBär";
    const ME: i32 = 9999;
    const UID: u32 = 501;

    type Row<'a> = (i32, i32, i32, &'a str, &'a str, &'a str);

    fn listing(extra: &[Row]) -> Snapshot {
        listing_with(extra, &[])
    }

    fn listing_with(extra: &[Row], exiting: &[i32]) -> Snapshot {
        let host = format!("/app/CodeBär --pty-host {SOCK}");
        let old = format!("/app/CodeBär --pty-host {OLD}");
        let mut rows: Vec<Row> = vec![
            (1, 0, 1, "??", "/sbin/launchd", ""),
            (100, 1, 100, "??", &host, " HOME=/u"),
            (101, 100, 101, "ttys001", "-zsh", " HOME=/u CODEBAER_SESSION=3 TERM=xterm"),
            (102, 101, 102, "ttys001", "vim notes.md", " CODEBAER_SESSION=3"),
            (200, 1, 200, "??", &old, " HOME=/u"),
            (201, 200, 201, "ttys005", "claude", " CODEBAER_SESSION=1"),
            (300, 1, 300, "??", "node server.js", " PORT=3000 CODEBAER_SESSION=7"),
            (301, 300, 300, "??", "node worker.js", " CODEBAER_SESSION=7"),
            // a platform binary: its environment, and so its tag, is hidden
            (302, 300, 300, "??", "/bin/sleep 900", ""),
            (400, 1, 400, "??", "grep CODEBAER_SESSION=9", " HOME=/u"),
        ];
        rows.extend_from_slice(extra);
        // launchd is root's, like the other account's host below
        let uid = |r: &Row| if r.0 == 1 || r.0 == 600 { 0 } else { UID };
        let stat = |r: &Row| if exiting.contains(&r.0) { "?Es" } else { "Ss" };
        let line = |r: &Row, env: bool| {
            let env = if env { r.5 } else { "" };
            format!("{:>5} {:>5} {:>5} {:>5} {:<4} {:<8} {}{env}", r.0, r.1, r.2, uid(r), stat(r), r.3, r.4)
        };
        let plain = rows.iter().map(|r| line(r, false)).collect::<Vec<_>>().join("\n");
        let with_env = rows.iter().map(|r| line(r, true)).collect::<Vec<_>>().join("\n");
        snapshot(&plain, &with_env, EXE)
    }

    fn ctx(peer: Option<i32>) -> Ctx<'static> {
        Ctx { sock: SOCK, peer, exe: EXE, me: ME, uid: UID }
    }

    fn report(snap: &Snapshot) -> Report {
        classify(snap, &ctx(None), |_| true, |_| false).unwrap()
    }

    fn sessions(h: &Host) -> Vec<(i32, Option<u32>)> {
        h.sessions.iter().map(|p| (p.pid, p.session)).collect()
    }

    #[test]
    fn puts_the_current_host_first_with_its_sessions() {
        let r = classify(&listing(&[]), &ctx(None), |s| s == SOCK, |_| false).unwrap();
        let hosts: Vec<(i32, bool, bool)> = r.hosts.iter().map(|h| (h.pid, h.current, h.sock_exists)).collect();
        assert_eq!(hosts, [(100, true, true), (200, false, false)]);
        assert_eq!(sessions(&r.hosts[0]), [(101, Some(3))]);
        assert_eq!(sessions(&r.hosts[1]), [(201, Some(1))]);
    }

    #[test]
    fn escaped_is_only_tagged_processes_with_no_host_above_them() {
        let r = report(&listing(&[]));
        // 102 is a grandchild of a live host, and 400 names the tag in its arguments, not its environment
        assert_eq!(r.escaped.iter().map(|p| p.pid).collect::<Vec<_>>(), [300, 301]);
        assert_eq!(r.escaped[0].command, "node server.js");
    }

    #[test]
    fn only_the_apps_own_binary_is_a_host_and_only_a_group_leader_is_a_session() {
        let snap = listing(&[
            (500, 1, 500, "??", "zsh -c grep ' --pty-host ' notes", ""),
            (501, 500, 501, "ttys009", "sleep 9", " CODEBAER_SESSION=2"),
            (103, 100, 101, "ttys001", "a job of the shell's", ""),
            // exiting, so its terminal is already revoked
            (104, 100, 104, "??", "(zsh)", ""),
        ]);
        let r = report(&snap);
        assert!(r.hosts.iter().all(|h| h.pid != 500));
        assert_eq!(sessions(&r.hosts[0]), [(101, Some(3)), (104, None)]);
    }

    #[test]
    fn a_relay_to_a_session_the_app_runs_inside_carries_the_app() {
        let relay = format!("/app/CodeBär --pty-relay {OLD} 1");
        let snap = listing(&[
            (110, 100, 110, "ttys002", &relay, " CODEBAER_SESSION=4"),
            (202, 201, 202, "ttys005", "node pnpm tauri dev", " CODEBAER_SESSION=1"),
            (203, 202, 202, "ttys005", "target/debug/CodeBär", " CODEBAER_SESSION=1"),
        ]);
        let r = classify(&snap, &Ctx { me: 203, ..ctx(None) }, |_| true, |_| false).unwrap();
        assert!(r.hosts[0].sessions.iter().find(|p| p.pid == 110).unwrap().holds_app);
        let dir = Path::new(OLD).parent();
        let none = classify(&listing(&[(202, 201, 202, "ttys005", "node pnpm tauri dev", ""),
            (203, 202, 202, "ttys005", "target/debug/CodeBär", "")]), &Ctx { me: 203, ..ctx(None) }, |_| true, |_| false).unwrap();
        assert!(plan_restore(&none, dir, OLD, Some(1), 201).is_err_and(|e| e.contains("itself")));
    }

    #[test]
    fn a_relay_carries_the_app_even_when_its_host_has_become_unclear() {
        let relay = format!("/app/CodeBär --pty-relay {OLD} 1");
        let old = format!("/app/CodeBär --pty-host {OLD}");
        let snap = listing(&[
            (110, 100, 110, "ttys002", &relay, " CODEBAER_SESSION=4"),
            (202, 201, 202, "ttys005", "node pnpm tauri dev", ""),
            (203, 202, 202, "ttys005", "target/debug/CodeBär", ""),
            // a second host that took over the old one's socket path
            (250, 1, 250, "??", &old, ""),
        ]);
        let r = classify(&snap, &Ctx { me: 203, ..ctx(None) }, |_| true, |_| false).unwrap();
        assert!(r.hosts.iter().any(|h| h.pid == 200 && h.unclear));
        assert!(r.hosts[0].sessions.iter().find(|p| p.pid == 110).unwrap().holds_app);
    }

    #[test]
    fn a_relay_by_pid_carries_the_app_too() {
        let relay = format!("/app/CodeBär --pty-relay {OLD} pid:201");
        let snap = listing(&[
            (110, 100, 110, "ttys002", &relay, " CODEBAER_SESSION=4"),
            (202, 201, 202, "ttys005", "node pnpm tauri dev", ""),
            (203, 202, 202, "ttys005", "target/debug/CodeBär", ""),
        ]);
        let r = classify(&snap, &Ctx { me: 203, ..ctx(None) }, |_| true, |_| false).unwrap();
        assert!(r.hosts[0].sessions.iter().find(|p| p.pid == 110).unwrap().holds_app);
    }

    #[test]
    fn refuses_a_process_in_the_apps_own_group() {
        // `vite`, escaped, but still in the job group of the `pnpm tauri dev` the app runs under
        let snap = listing(&[
            (800, 1, 800, "ttys003", "node pnpm tauri dev", ""),
            (801, 800, 800, "ttys003", "target/debug/CodeBär", ""),
            (802, 1, 800, "??", "node vite", " CODEBAER_SESSION=9"),
        ]);
        let r = classify(&snap, &Ctx { me: 801, ..ctx(None) }, |_| true, |_| false).unwrap();
        assert!(r.escaped.iter().any(|p| p.pid == 802));
        assert!(kill_targets(&snap, &r, 802, 801).is_err_and(|e| e.contains("itself")));
    }

    #[test]
    fn the_current_host_is_the_one_the_app_is_connected_to() {
        // a host that stopped answering keeps running after a new one took over its socket path
        let host = format!("/app/CodeBär --pty-host {SOCK}");
        let snap = listing(&[(150, 1, 150, "??", &host, "")]);
        let r = classify(&snap, &ctx(Some(150)), |_| true, |_| false).unwrap();
        let hosts: Vec<(i32, bool, bool)> = r.hosts.iter().map(|h| (h.pid, h.current, h.sock_exists)).collect();
        assert_eq!(hosts, [(150, true, true), (100, false, false), (200, false, true)]);
        assert!(r.hosts[1].unclear && !r.hosts[2].unclear);
        // and with no connection to ask, neither of them is trusted to be it, or to be killed
        let r = report(&snap);
        assert!(r.hosts.iter().filter(|h| h.sock == SOCK).all(|h| !h.current && !h.sock_exists && h.unclear));
        assert!(kill_targets(&snap, &r, 101, ME).is_err());
    }

    #[test]
    fn keeps_a_session_that_changed_account() {
        let snap = listing(&[(105, 100, 105, "ttys004", "-sh", "")]);
        let theirs = Snapshot {
            procs: snap.procs.iter().map(|p| if p.pid == 105 { Proc { uid: 0, ..p.clone() } } else { p.clone() }).collect(),
            parent: snap.parent.clone(),
        };
        assert!(report(&theirs).hosts[0].sessions.iter().any(|p| p.pid == 105));
    }

    #[test]
    fn will_not_judge_a_listing_that_misses_the_apps_own_host() {
        // what an app with no locale saw: ps escaping the "ä" hid every host
        let hidden = snapshot(
            &format!("  100     1   100   501 Ss   ??       /app/CodeBM-CM-$r --pty-host {SOCK}"),
            "",
            EXE,
        );
        assert!(classify(&hidden, &ctx(Some(100)), |_| true, |_| false).is_err());
    }

    #[test]
    fn leaves_another_accounts_processes_alone() {
        let theirs = format!("/app/CodeBär --pty-host /Users/other/{}", "ptyd-2.sock");
        let r = report(&listing(&[(600, 1, 600, "??", &theirs, "")]));
        assert!(r.hosts.iter().all(|h| h.pid != 600));
    }

    #[test]
    fn finds_the_relay_attached_to_a_stale_host() {
        let relay = format!("/app/CodeBär --pty-relay {OLD} 1");
        let r = report(&listing(&[(110, 100, 110, "ttys002", &relay, " CODEBAER_SESSION=4")]));
        let want = Relay { sock: OLD.into(), id: Some(1), pid: None };
        assert_eq!(r.hosts[1].relays, std::slice::from_ref(&want));
        assert!(r.hosts[0].relays.is_empty());
        assert_eq!(r.hosts[0].sessions.iter().find(|p| p.pid == 110).unwrap().relay.as_ref(), Some(&want));
        let by_pid = relay_of(&format!("/app/CodeBär --pty-relay {OLD} pid:201"), EXE);
        assert_eq!(by_pid, Some(Relay { sock: OLD.into(), id: None, pid: Some(201) }));
        assert_eq!(relay_of(&format!("/usr/bin/grep --pty-relay {OLD} 1"), EXE), None);
    }

    #[test]
    fn a_stale_host_takes_a_relay_for_each_of_its_sessions() {
        let relay = format!("/app/CodeBär --pty-relay {OLD} 1");
        let snap = listing(&[
            (110, 100, 110, "ttys002", &relay, " CODEBAER_SESSION=4"),
            (211, 200, 211, "ttys006", "claude", " CODEBAER_SESSION=2"),
        ]);
        let r = report(&snap);
        let dir = Path::new(OLD).parent();
        assert_eq!(plan_restore(&r, dir, OLD, Some(2), 211), Ok((Target::Id(2), "claude".into())));
        assert!(plan_restore(&r, dir, OLD, Some(1), 201).is_err_and(|e| e.contains("already relayed")));
    }

    #[test]
    fn a_host_this_apps_bridge_is_attached_to_is_not_in_use() {
        let bridge = format!("/app/CodeBär --pty-bridge {OLD}");
        let snap = listing(&[(250, 1, 250, "??", &bridge, "")]);
        let r = classify(&snap, &ctx(None), |_| true, |pid| pid == 200).unwrap();
        assert!(!r.hosts[1].in_use);
        assert!(r.hosts.iter().all(|h| h.pid != 250) && r.escaped.iter().all(|p| p.pid != 250));
        assert!(plan_restore(&r, Path::new(OLD).parent(), OLD, Some(1), 201).is_ok());
    }

    #[test]
    fn a_dev_build_and_the_bundle_count_each_others_processes_as_the_apps_own() {
        let bundled = format!("/Applications/CodeBär.app/Contents/MacOS/codebaer --pty-relay {OLD} 1");
        assert!(relay_of(&bundled, "CodeBär").is_some());
        assert!(relay_of(&format!("/repo/src-tauri/target/debug/CodeBär --pty-relay {OLD} 1"), "codebaer").is_some());
    }

    #[test]
    fn a_pid_reused_between_the_listings_has_no_session() {
        let snap = snapshot(
            "  500     1   500   501 Ss   ??       python3 job.py",
            "  500     1   500   501 Ss   ??       grep CODEBAER_SESSION=9 log",
            EXE,
        );
        assert_eq!(snap.procs[0].session, None);
    }

    #[test]
    fn keeps_the_spaces_in_a_command_line() {
        let l = parse_line("  7284 59734  7284   501 Ss+  ttys005  claude --resume a b").unwrap();
        let got = (l.pid, l.ppid, l.pgid, l.uid, l.stat, l.tty, l.rest);
        assert_eq!(got, (7284, 59734, 7284, 501, "Ss+", "ttys005", "claude --resume a b"));
        assert!(parse_line("garbage").is_none());
    }

    #[test]
    fn kills_a_stale_session_by_group_and_an_escaped_tree_by_pid() {
        let snap = listing(&[]);
        let r = report(&snap);
        assert_eq!(kill_targets(&snap, &r, 201, ME), Ok(vec![-201]));
        // the hidden-environment child goes too
        assert_eq!(kill_targets(&snap, &r, 300, ME), Ok(vec![300, 301, 302]));
        // the current host's sessions and anything untagged are not this command's to kill
        assert!(kill_targets(&snap, &r, 101, ME).is_err());
        assert!(kill_targets(&snap, &r, 400, ME).is_err());
    }

    #[test]
    fn a_session_stuck_exiting_is_ended_through_its_host_on_any_host() {
        // as `ps` shows one: its arguments, environment and terminal are already gone
        let snap = listing_with(&[(103, 100, 103, "??", "(zsh)", ""), (202, 200, 202, "??", "(claude)", "")], &[103, 202]);
        let r = report(&snap);
        let stuck = r.hosts[0].sessions.iter().find(|p| p.pid == 103).unwrap();
        assert!(stuck.exiting && stuck.session.is_none());
        assert!(!r.hosts[0].sessions.iter().find(|p| p.pid == 101).unwrap().exiting);
        assert_eq!(stuck_host(&r, 103), Ok(Some(100)));
        assert_eq!(stuck_host(&r, 202), Ok(Some(200)));
        // a live session of the current host is still closed through the host
        assert_eq!(stuck_host(&r, 101), Ok(None));
        assert!(kill_targets(&snap, &r, 101, ME).is_err());
        let busy = classify(&snap, &ctx(None), |_| true, |pid| pid == 200).unwrap();
        assert!(stuck_host(&busy, 202).is_err_and(|e| e.contains("another CodeBär")));
    }

    #[test]
    fn leaves_the_terminals_of_a_host_another_app_is_attached_to() {
        let snap = listing(&[]);
        let r = classify(&snap, &ctx(None), |_| true, |pid| pid == 200).unwrap();
        assert!(r.hosts[1].in_use);
        assert!(kill_targets(&snap, &r, 201, ME).is_err_and(|e| e.contains("another CodeBär")));
        assert!(plan_restore(&r, Path::new(OLD).parent(), OLD, Some(1), 201).is_err());
    }

    #[test]
    fn refuses_a_group_the_app_itself_runs_in() {
        // `pnpm tauri dev` run from the stale session's shell, in a job group of its own
        let snap = listing(&[
            (202, 201, 202, "ttys005", "node pnpm tauri dev", " CODEBAER_SESSION=1"),
            (203, 202, 202, "ttys005", "target/debug/CodeBär", " CODEBAER_SESSION=1"),
        ]);
        let r = classify(&snap, &Ctx { me: 203, ..ctx(None) }, |_| true, |_| false).unwrap();
        assert!(r.hosts[1].sessions[0].holds_app);
        assert!(!r.hosts[0].sessions[0].holds_app);
        assert!(kill_targets(&snap, &r, 201, 203).is_err_and(|e| e.contains("itself")));
    }

    #[test]
    fn plans_a_restore_by_id_or_by_pid_and_program() {
        let newer = format!("/app/CodeBär --pty-host {NEWER}");
        let snap = listing(&[
            (210, 200, 210, "ttys006", "/bin/zsh -l", ""),
            (700, 1, 700, "??", &newer, ""),
            (701, 700, 701, "ttys007", "/bin/zsh -l", ""),
        ]);
        let r = report(&snap);
        let dir = Path::new(OLD).parent();
        assert_eq!(plan_restore(&r, dir, OLD, Some(1), 201), Ok((Target::Id(1), "claude".into())));
        assert_eq!(plan_restore(&r, dir, NEWER, None, 701), Ok((Target::Pid(701), "zsh".into())));
        // a version 1 host has no pids to find it by
        assert!(plan_restore(&r, dir, OLD, None, 210).is_err_and(|e| e.contains("older")));
        assert!(plan_restore(&r, dir, OLD, Some(2), 201).is_err());
        assert!(plan_restore(&r, dir, SOCK, Some(3), 101).is_err());
        assert!(plan_restore(&r, Some(Path::new("/elsewhere")), OLD, Some(1), 201).is_err());
    }

    #[test]
    fn names_the_script_after_the_old_program() {
        assert_eq!(program_name("/opt/homebrew/bin/claude --resume"), "claude");
        assert_eq!(program_name("-zsh"), "zsh");
        assert_eq!(program_name("/bin/$(x)"), "x");
        assert_eq!(program_name("/a/.."), "relay");
        assert_eq!(program_name(""), "relay");
    }

    #[test]
    fn the_script_quotes_its_paths_and_removes_itself() {
        // an exe path like the app's: spaces and a non-ASCII letter, here standing in for echo
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("Code Bär.app");
        std::fs::create_dir(&bin).unwrap();
        let exe = bin.join("CodeBär");
        std::os::unix::fs::symlink("/bin/echo", &exe).unwrap();
        let sock = "/a/Application Support/it's/ptyd-1.sock";
        let (script, dir) = write_script(&exe, sock, &Target::Pid(7), "zsh").unwrap();
        let out = Command::new(&script).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), format!("--pty-relay {sock} pid:7\n"));
        assert!(!dir.exists(), "the script left its folder behind");
    }
}
