use std::collections::HashSet;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{Listed, TAG};
use crate::AppError;

/// zsh is not installed everywhere.
pub const FALLBACK_SHELL: &str = "/bin/sh";
/// en_US.UTF-8 is often not generated, and every shell would warn about it.
pub const UTF8_LOCALE: &str = "C.UTF-8";
pub const BIN_DIRS: &[&str] = &["/usr/local/bin", "/snap/bin"];

/// Per machine and per login, where the app's config folder may be a home shared over NFS: the host's `bind`
/// replaces a socket file that does not answer, which would be another machine's live one.
pub fn runtime_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir())
}

/// The folder the kernel has for `pid`, with symlinks already resolved, so it compares equal to a canonicalized repo
/// root.
pub fn cwd_of(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let link = std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?;
    let s = link.into_os_string().into_string().ok()?;
    // the kernel's mark for a folder deleted out from under the process
    if s.ends_with(" (deleted)") && !Path::new(&s).is_dir() {
        return None;
    }
    Some(s)
}

pub fn peer_pid(fd: RawFd) -> Option<i32> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let got = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&raw mut cred).cast(), &mut len) };
    (got == 0 && cred.pid > 0).then_some(cred.pid)
}

struct Stat {
    comm: String,
    ppid: i32,
    pgid: i32,
    tty: i64,
    /// In clock ticks since boot: the same pid with a different start is another process.
    start: u64,
}

/// `pid (comm) state ppid pgrp session tty_nr ...`, where comm may itself hold spaces and parentheses.
fn parse_stat(s: &str) -> Option<Stat> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    let comm = s.get(open + 1..close)?.to_string();
    let mut f = s.get(close + 1..)?.split_whitespace();
    let _state = f.next()?;
    let ppid = f.next()?.parse().ok()?;
    let pgid = f.next()?.parse().ok()?;
    let _session = f.next()?;
    let tty = f.next()?.parse().ok()?;
    // tpgid through itrealvalue come before it
    let start = f.nth(14)?.parse().ok()?;
    Some(Stat { comm, ppid, pgid, tty, start })
}

/// Named as `ps` names it, but with `??` for none, as on macOS.
fn tty_name(nr: i64) -> String {
    let nr = nr as u64;
    let major = (nr >> 8) & 0xfff;
    let minor = (nr & 0xff) | ((nr >> 12) & 0xfff00);
    match major {
        0 => "??".into(),
        136..=143 => format!("pts/{}", (major - 136) * 256 + minor),
        4 if minor < 64 => format!("tty{minor}"),
        _ => format!("{major}:{minor}"),
    }
}

/// The effective one, which is what `ps` reports as the uid.
fn effective_uid(status: &str) -> Option<u32> {
    status.lines().find_map(|l| l.strip_prefix("Uid:"))?.split_whitespace().nth(1)?.parse().ok()
}

fn nul_separated(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|a| !a.is_empty())
}

fn command_line(bytes: &[u8]) -> String {
    nul_separated(bytes).map(String::from_utf8_lossy).collect::<Vec<_>>().join(" ")
}

fn session_of(environ: &[u8]) -> Option<u32> {
    nul_separated(environ).find_map(|v| std::str::from_utf8(v).ok()?.strip_prefix(TAG)?.parse().ok())
}

/// Each file is opened by pid, so the stat read last proves they all came from one process: a pid is only reused
/// once its process is gone.
fn read_proc(pid: i32) -> Option<Listed> {
    let dir = PathBuf::from(format!("/proc/{pid}"));
    let stat = || parse_stat(&std::fs::read_to_string(dir.join("stat")).ok()?);
    let first = stat()?;
    let uid = effective_uid(&std::fs::read_to_string(dir.join("status")).ok()?)?;
    let cmdline = std::fs::read(dir.join("cmdline")).unwrap_or_default();
    let command = match command_line(&cmdline) {
        // a zombie's or a kernel thread's
        c if c.is_empty() => format!("({})", first.comm),
        c => c,
    };
    // another account's is unreadable, and so is its session
    let session = std::fs::read(dir.join("environ")).ok().and_then(|e| session_of(&e));
    if stat()?.start != first.start {
        return None;
    }
    let tty = tty_name(first.tty);
    Some(Listed { pid, ppid: first.ppid, pgid: first.pgid, uid, tty, command, session, exiting: false })
}

fn pids() -> Result<Vec<i32>, AppError> {
    Ok(std::fs::read_dir("/proc")?
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .collect())
}

/// A process that exits between the directory listing and its reads is left out.
pub fn processes() -> Result<Vec<Listed>, AppError> {
    Ok(pids()?.into_iter().filter_map(read_proc).collect())
}

pub fn command_lines() -> Result<Vec<String>, AppError> {
    Ok(pids()?
        .into_iter()
        .filter_map(|pid| std::fs::read(format!("/proc/{pid}/cmdline")).ok())
        .map(|b| command_line(&b))
        .filter(|c| !c.is_empty())
        .collect())
}

/// `Num RefCount Protocol Flags Type St Inode Path`, where the path may hold spaces.
fn unix_entry(line: &str) -> Option<(u64, &str)> {
    let mut rest = line;
    let mut inode = None;
    for i in 0..7 {
        let t = rest.trim_start();
        let end = t.find(' ').unwrap_or(t.len());
        if i == 6 {
            inode = t[..end].parse().ok();
        }
        rest = &t[end..];
    }
    Some((inode?, rest.strip_prefix(' ').unwrap_or(rest)))
}

/// The ones bound to `sock`: the listener, and one per accepted connection, which shares its path. A host also
/// holds whatever sockets it inherited from the app that started it. The descriptors are read before the socket
/// table, so none that is open throughout can be missing from it.
pub fn unix_sockets(pid: i32, sock: &str) -> Option<usize> {
    let inodes: Vec<u64> = std::fs::read_dir(format!("/proc/{pid}/fd"))
        .ok()?
        .filter_map(|e| std::fs::read_link(e.ok()?.path()).ok())
        .filter_map(|l| l.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok())
        .collect();
    let table = std::fs::read_to_string("/proc/net/unix").ok()?;
    let bound: HashSet<u64> =
        table.lines().skip(1).filter_map(unix_entry).filter(|(_, path)| *path == sock).map(|(i, _)| i).collect();
    Some(inodes.iter().filter(|i| bound.contains(i)).count())
}

pub fn open_url(url: &str) -> Result<(), AppError> {
    let mut child = Command::new("xdg-open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::Io(format!("xdg-open: {e}")))?;
    // with no desktop handler for the address, xdg-open runs the browser itself and waits for it
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        if let Some(st) = child.try_wait()? {
            if st.success() {
                return Ok(());
            }
            return Err(AppError::Io(format!("xdg-open could not open {url} ({st})")));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Linux does not hold an exiting child for its pty's output to drain, so no session is ever `exiting`.
pub fn unstick(_host: i32, _pid: i32) -> Result<(), String> {
    Err("only macOS holds a session in exit".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_stat_line_whose_name_has_spaces_and_parentheses() {
        let line = "4242 (tmux: server (1)) S 1 4242 4242 34817 4242 4194304 0 0 0 0 3 1 0 0 20 0 1 0 987654 1 2";
        let s = parse_stat(line).unwrap();
        let got = (s.comm.as_str(), s.ppid, s.pgid, tty_name(s.tty), s.start);
        assert_eq!(got, ("tmux: server (1)", 1, 4242, "pts/1".into(), 987654));
        assert!(parse_stat("garbage").is_none());
    }

    #[test]
    fn names_ttys_as_ps_does() {
        assert_eq!(tty_name(0), "??");
        assert_eq!(tty_name(34816), "pts/0");
        assert_eq!(tty_name(1025), "tty1");
    }

    #[test]
    fn reads_a_socket_table_line_with_spaces_in_its_path() {
        let line = "0000000000000000: 00000002 00000000 00010000 0001 01 123456 /run/user/1000/a b/ptyd-3.sock";
        assert_eq!(unix_entry(line), Some((123456, "/run/user/1000/a b/ptyd-3.sock")));
        assert_eq!(unix_entry("0000000000000000: 00000003 00000000 00000000 0001 03 42"), Some((42, "")));
    }

    #[test]
    fn takes_the_effective_uid() {
        assert_eq!(effective_uid("Name:\tsudo\nUid:\t1000\t0\t0\t0\nGid:\t1000\t1000\t1000\t1000\n"), Some(0));
    }

    #[test]
    fn finds_the_session_only_as_a_whole_variable() {
        assert_eq!(session_of(b"HOME=/h\0CODEBAER_SESSION=3\0TERM=xterm\0"), Some(3));
        assert_eq!(session_of(b"NOTE=a CODEBAER_SESSION=9\0"), None);
        assert_eq!(command_line(b"/usr/bin/codebaer\0--pty-host\0/run/user/1000/a b/ptyd-3.sock\0"),
            "/usr/bin/codebaer --pty-host /run/user/1000/a b/ptyd-3.sock");
    }

    #[test]
    fn has_no_folder_for_a_process_whose_folder_was_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = Command::new("/bin/sleep").arg("10").current_dir(dir.path()).spawn().unwrap();
        let pid = child.id() as i32;
        let deadline = Instant::now() + Duration::from_secs(5);
        while cwd_of(pid).is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        let before = cwd_of(pid);
        drop(dir);
        let after = cwd_of(pid);
        let _ = child.kill();
        let _ = child.wait();
        assert!(before.is_some());
        assert_eq!(after, None);
    }

    #[test]
    fn a_session_is_not_held_in_exit_by_output_nobody_reads() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        // what gets a macOS child stuck: tests/pty_unstick.rs
        cmd.args(["-c", "printf %0200d 0; exit"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let (done, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || done.send(child.wait()));
        // the master stays open and is never read
        let exited = rx.recv_timeout(Duration::from_secs(5));
        drop(pair.master);
        assert!(exited.is_ok(), "the shell is stuck exiting with its output unread");
    }
}
