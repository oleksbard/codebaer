use std::collections::{HashMap, HashSet};
use std::os::fd::RawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use super::{Listed, TAG};
use crate::AppError;

/// The record says nothing, or names a shell that is gone.
pub const FALLBACK_SHELL: &str = "/bin/zsh";
/// A session's locale when the app has none, as after a Finder launch.
pub const UTF8_LOCALE: &str = "en_US.UTF-8";
/// A Finder launch gets /usr/bin:/bin:/usr/sbin:/sbin and neither homebrew prefix.
pub const BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// None: the host's socket lives in the app's config folder.
pub fn runtime_dir() -> Option<PathBuf> {
    None
}

/// The folder the kernel has for `pid`, with symlinks already resolved, so it compares equal to
/// a canonicalized repo root. macOS has no notification for a chdir; this can only be asked.
pub fn cwd_of(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
    let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, info.as_mut_ptr().cast(), size) };
    if got != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let raw = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    // empty for a process whose folder was deleted out from under it
    raw.to_str().ok().filter(|s| !s.is_empty()).map(String::from)
}

pub fn peer_pid(fd: RawFd) -> Option<i32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let got = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&raw mut pid).cast(), &mut len) };
    (got == 0 && pid > 0).then_some(pid)
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

/// `plain` and `with_env` are the same `ps` listing without and with `-E`. `ps` appends the
/// environment to the command column with nothing to mark where it starts, so the plain listing
/// is what tells the two apart.
fn listing(plain: &str, with_env: &str) -> Vec<Listed> {
    let envs: HashMap<i32, &str> = with_env.lines().filter_map(parse_line).map(|l| (l.pid, l.rest)).collect();
    plain
        .lines()
        .filter_map(parse_line)
        .map(|l| {
            // a mismatch is a pid reused between the two listings, whose environment is unknown
            let env = envs.get(&l.pid).and_then(|e| e.strip_prefix(l.rest));
            Listed {
                pid: l.pid,
                ppid: l.ppid,
                pgid: l.pgid,
                uid: l.uid,
                tty: l.tty.to_string(),
                command: l.rest.to_string(),
                session: env.and_then(|e| e.split(' ').find_map(|tok| tok.strip_prefix(TAG)?.parse().ok())),
                exiting: l.stat.contains('E'),
            }
        })
        .collect()
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

pub fn processes() -> Result<Vec<Listed>, AppError> {
    Ok(listing(&ps(false)?, &ps(true)?))
}

/// One plain listing, for a caller that only needs the command lines.
pub fn command_lines() -> Result<Vec<String>, AppError> {
    let out = Command::new("/bin/ps").env("LC_ALL", "en_US.UTF-8").args(["-axww", "-o", "command="]).output()?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).collect())
}

/// Every unix socket but the hook socket's listener and the connections it accepted, which lsof names by the
/// hook socket's path. A host also inherits whatever other sockets the app that started it held, which are not
/// unix ones.
pub fn unix_sockets(pid: i32, sock: &str) -> Option<usize> {
    let out = Command::new("/usr/sbin/lsof").args(["-a", "-U", "-p", &pid.to_string(), "-F", "fn"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let hook = format!("n{}", std::path::Path::new(sock).with_extension("hook").display());
    let text = String::from_utf8_lossy(&out.stdout);
    let all = text.lines().filter(|l| l.starts_with('f')).count();
    Some(all.saturating_sub(text.lines().filter(|l| *l == hook).count()))
}

pub fn open_url(url: &str) -> Result<(), AppError> {
    // -u: a relative path spelled like a URL would otherwise open as a file in the working directory
    let out = Command::new("/usr/bin/open").args(["-u", url]).output()?;
    if !out.status.success() {
        return Err(AppError::Io(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pid_reused_between_the_listings_has_no_session() {
        let got = listing(
            "  500     1   500   501 Ss   ??       python3 job.py",
            "  500     1   500   501 Ss   ??       grep CODEBAER_SESSION=9 log",
        );
        assert_eq!(got[0].session, None);
    }

    #[test]
    fn keeps_the_spaces_in_a_command_line() {
        let l = parse_line("  7284 59734  7284   501 Ss+  ttys005  claude --resume a b").unwrap();
        let got = (l.pid, l.ppid, l.pgid, l.uid, l.stat, l.tty, l.rest);
        assert_eq!(got, (7284, 59734, 7284, 501, "Ss+", "ttys005", "claude --resume a b"));
        assert!(parse_line("garbage").is_none());
    }

    #[test]
    fn reads_the_session_from_the_environment_and_the_exit_state_from_stat() {
        let got = listing(
            "  101   100   101   501 ?Es  ttys001  -zsh",
            "  101   100   101   501 ?Es  ttys001  -zsh HOME=/u CODEBAER_SESSION=3 TERM=xterm",
        );
        assert_eq!((got[0].session, got[0].exiting, got[0].command.as_str()), (Some(3), true, "-zsh"));
    }
}
