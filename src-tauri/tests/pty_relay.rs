//! The relay run for real: the binary, in a pty of its own, against a host serving in-process.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use codebaer_lib::pty::{bridge, daemon, orphans};
use codebaer_lib::pty::proto::{self, ClientMsg, Frame, ServerMsg, SpawnKind};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

const BIN: &str = env!("CARGO_BIN_EXE_CodeBär");

/// Named the way a real host's socket is, since the relay reads the version to speak from it.
fn host() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join(format!("ptyd-{}.sock", proto::PROTO));
    let listener = UnixListener::bind(&sock).unwrap();
    let hub = daemon::new_hub(sock.clone());
    std::thread::spawn(move || daemon::serve(listener, hub, Duration::from_secs(3600), Duration::from_secs(3600)));
    (dir, sock)
}

struct Client {
    s: UnixStream,
    buf: Vec<u8>,
    out: Vec<u8>,
    msgs: Vec<ServerMsg>,
}

impl Client {
    fn connect(sock: &Path) -> Client {
        Client::over(UnixStream::connect(sock).unwrap())
    }

    fn over(s: UnixStream) -> Client {
        s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        let mut c = Client { s, buf: Vec::new(), out: Vec::new(), msgs: Vec::new() };
        c.send(&ClientMsg::Hello { proto: proto::PROTO, client: "test".into() });
        c
    }

    fn send(&mut self, msg: &ClientMsg) {
        let mut wire = Vec::new();
        proto::encode(&Frame::Control(serde_json::to_vec(msg).unwrap()), &mut wire);
        self.s.write_all(&wire).unwrap();
    }

    fn pump(&mut self) {
        let mut chunk = [0u8; 65536];
        if let Ok(n) = self.s.read(&mut chunk) {
            self.buf.extend_from_slice(&chunk[..n]);
        }
        let mut off = 0;
        while let Ok(Some((frame, used))) = proto::decode(&self.buf[off..]) {
            off += used;
            match frame {
                Frame::Output(_, bytes) => self.out.extend_from_slice(&bytes),
                Frame::Control(json) => self.msgs.extend(serde_json::from_slice::<ServerMsg>(&json)),
                Frame::Input(..) => {}
            }
        }
        self.buf.drain(..off);
    }

    fn spawn_sh(&mut self) -> (u32, i32) {
        let kind = SpawnKind::Shell { path: "/bin/sh".into() };
        self.send(&ClientMsg::Spawn { req: 1, kind, cwd: "/tmp".into(), cols: 80, rows: 24 });
        let id = until(Duration::from_secs(5), || {
            self.pump();
            self.msgs.iter().find_map(|m| match m {
                ServerMsg::Spawned { info, .. } => Some((info.id, info.pid.expect("the host reports the pid"))),
                _ => None,
            })
        });
        id.expect("no session was spawned")
    }

    /// Asks again until the host's list no longer has `id`.
    fn wait_gone(&mut self, id: u32) -> bool {
        until(Duration::from_secs(5), || {
            self.msgs.clear();
            self.send(&ClientMsg::Hello { proto: proto::PROTO, client: "test".into() });
            self.pump();
            self.msgs.iter().find_map(|m| match m {
                ServerMsg::Hello { sessions, .. } => sessions.iter().all(|s| s.id != id).then_some(()),
                _ => None,
            })
        })
        .is_some()
    }
}

/// Asks through the bridge while it is up: a client connecting to the host itself would take the
/// connection from it, and with it a Close the bridge had not yet passed on.
fn observe(sock: &Path) -> Client {
    match UnixStream::connect(bridge::path(sock)) {
        Ok(s) => Client::over(s),
        Err(_) => Client::connect(sock),
    }
}

fn until<T>(limit: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(v) = f() {
            return Some(v);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

struct Relay {
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    screen: Arc<Mutex<Vec<u8>>>,
    _master: Box<dyn MasterPty + Send>,
}

impl Relay {
    fn start(sock: &Path, target: &str) -> Relay {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(BIN);
        cmd.args(["--pty-relay", &sock.to_string_lossy(), target]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let screen = Arc::new(Mutex::new(Vec::new()));
        let sink = screen.clone();
        std::thread::spawn(move || {
            let mut b = [0u8; 4096];
            while let Ok(n @ 1..) = reader.read(&mut b) {
                sink.lock().unwrap().extend_from_slice(&b[..n]);
            }
        });
        Relay { child, writer: pair.master.take_writer().unwrap(), screen, _master: pair.master }
    }

    fn type_in(&mut self, s: &str) {
        self.writer.write_all(s.as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    fn shows(&self, needle: &str) -> bool {
        until(Duration::from_secs(5), || String::from_utf8_lossy(&self.screen.lock().unwrap()).contains(needle).then_some(()))
            .is_some()
    }

    fn exit_code(&mut self) -> Option<u32> {
        until(Duration::from_secs(5), || self.child.try_wait().ok().flatten()).map(|s| s.exit_code())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.screen.lock().unwrap()).into_owned()
    }
}

/// A session with some scrollback, left behind by a client that has gone, as a rebuild leaves it.
fn abandoned_session(sock: &Path) -> (u32, i32) {
    let mut c = Client::connect(sock);
    let (id, pid) = c.spawn_sh();
    c.send(&ClientMsg::Resize { id, cols: 80, rows: 24 });
    let mut wire = Vec::new();
    proto::encode(&Frame::Input(id, b"echo before-$((1+1))\n".to_vec()), &mut wire);
    c.s.write_all(&wire).unwrap();
    let seen = until(Duration::from_secs(5), || {
        c.pump();
        String::from_utf8_lossy(&c.out).contains("before-2").then_some(())
    });
    assert!(seen.is_some(), "the shell never ran the first command");
    (id, pid)
}

#[test]
fn a_relay_replays_the_old_session_and_carries_keystrokes_both_ways() {
    let (_dir, sock) = host();
    let (id, _) = abandoned_session(&sock);
    let mut relay = Relay::start(&sock, &id.to_string());
    assert!(relay.shows("before-2"), "the scrollback was not replayed");
    // checked for the result, not the echo: only a command that really ran prints 42
    relay.type_in("echo relay-$((6*7))\r");
    assert!(relay.shows("relay-42"), "the keystrokes never reached the old session");
}

#[test]
fn closing_the_relay_closes_the_session_it_relays() {
    let (_dir, sock) = host();
    let (id, _) = abandoned_session(&sock);
    let mut relay = Relay::start(&sock, &id.to_string());
    assert!(relay.shows("before-2"));
    // what the current host sends a session it is closing: its group, then again harder
    let group = relay.child.process_id().unwrap() as i32;
    unsafe { libc::killpg(group, libc::SIGHUP) };
    std::thread::sleep(Duration::from_millis(250));
    unsafe { libc::killpg(group, libc::SIGTERM) };
    assert_eq!(relay.exit_code(), Some(0));
    assert!(observe(&sock).wait_gone(id), "the old host still has the session");
}

#[test]
fn the_relay_ends_with_the_old_session_and_takes_its_exit_code() {
    let (_dir, sock) = host();
    let (id, _) = abandoned_session(&sock);
    let mut relay = Relay::start(&sock, &id.to_string());
    assert!(relay.shows("before-2"));
    relay.type_in("exit 3\r");
    assert_eq!(relay.exit_code(), Some(3));
    assert!(observe(&sock).wait_gone(id), "the exited session's record was left behind");
}

#[test]
fn a_relay_to_a_session_that_is_not_there_says_so_and_stops() {
    let (_dir, sock) = host();
    let mut relay = Relay::start(&sock, "99");
    assert!(relay.shows("no longer in that host"));
    assert_eq!(relay.exit_code(), Some(1));
}

#[test]
fn a_relay_finds_a_session_by_pid_when_its_id_was_unreadable() {
    let (_dir, sock) = host();
    let (id, pid) = abandoned_session(&sock);
    let mut relay = Relay::start(&sock, &format!("pid:{pid}"));
    assert!(relay.shows("before-2"));
    relay.type_in("echo by-pid-$((6*7))\r");
    assert!(relay.shows("by-pid-42"));
    // it resolved to the real id: closing it closes that session
    unsafe { libc::kill(relay.child.process_id().unwrap() as i32, libc::SIGHUP) };
    assert_eq!(relay.exit_code(), Some(0));
    assert!(observe(&sock).wait_gone(id));
}

#[test]
fn relays_to_two_sessions_of_one_host_both_keep_working() {
    let (_dir, sock) = host();
    let (a, _) = abandoned_session(&sock);
    let (b, _) = abandoned_session(&sock);
    let mut first = Relay::start(&sock, &a.to_string());
    assert!(first.shows("before-2"));
    let mut second = Relay::start(&sock, &b.to_string());
    assert!(second.shows("before-2"));
    // the host serves one client, and a second relay connecting straight to it cut the first off
    first.type_in("echo first-$((6*7))\r");
    assert!(first.shows("first-42"), "the first relay lost its session: {:?}", first.text());
    second.type_in("echo second-$((6*8))\r");
    assert!(second.shows("second-48"));
    assert!(!first.text().contains("second-48"), "a relay was shown another session's output");
}

#[test]
fn relays_started_together_all_get_their_sessions() {
    let (_dir, sock) = host();
    let ids: Vec<u32> = (0..3).map(|_| abandoned_session(&sock).0).collect();
    // no waiting in between, so they race to start the one bridge
    let mut relays: Vec<Relay> = ids.iter().map(|id| Relay::start(&sock, &id.to_string())).collect();
    for (i, r) in relays.iter_mut().enumerate() {
        assert!(r.shows("before-2"), "relay {i} was not replayed: {:?}", r.text());
        r.type_in(&format!("echo together-$(({i}+40))\r"));
    }
    for (i, r) in relays.iter().enumerate() {
        assert!(r.shows(&format!("together-{}", i + 40)), "relay {i} lost its session: {:?}", r.text());
    }
}

#[test]
fn a_relay_closed_while_still_starting_closes_its_session() {
    let (_dir, sock) = host();
    let (id, _) = abandoned_session(&sock);
    // stands in for a bridge that is closing down: it lets the relay in and drops it unanswered
    let at = bridge::path(&sock);
    let fake = UnixListener::bind(&at).unwrap();
    fake.set_nonblocking(true).unwrap();
    let mut relay = Relay::start(&sock, &id.to_string());
    let conn = until(Duration::from_secs(5), || fake.accept().ok()).expect("the relay never connected");
    unsafe { libc::killpg(relay.child.process_id().unwrap() as i32, libc::SIGHUP) };
    std::fs::remove_file(&at).unwrap();
    drop(conn);
    assert_eq!(relay.exit_code(), Some(0), "{:?}", relay.text());
    assert!(observe(&sock).wait_gone(id), "the old host still has the session");
}

#[test]
fn a_second_relay_to_the_same_session_is_turned_away() {
    let (_dir, sock) = host();
    let (id, _) = abandoned_session(&sock);
    let mut first = Relay::start(&sock, &id.to_string());
    assert!(first.shows("before-2"));
    let mut again = Relay::start(&sock, &id.to_string());
    assert!(again.shows("already relayed"));
    assert_eq!(again.exit_code(), Some(1));
    first.type_in("echo still-$((6*7))\r");
    assert!(first.shows("still-42"));
}

/// A host is a separate process here, since the check counts every socket the pid holds.
#[test]
fn a_host_counts_as_in_use_only_while_a_client_is_attached() {
    use std::os::fd::AsRawFd;
    struct Reap(i32);
    impl Drop for Reap {
        fn drop(&mut self) {
            unsafe { libc::kill(self.0, libc::SIGKILL) };
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join(format!("ptyd-{}.sock", proto::PROTO));
    assert!(std::process::Command::new(BIN).arg("--pty-host").arg(&sock).status().unwrap().success());
    let s = until(Duration::from_secs(5), || UnixStream::connect(&sock).ok()).expect("the host never bound");
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&raw mut pid).cast(), &mut len) };
    assert!(pid > 0);
    let _reap = Reap(pid);
    assert!(until(Duration::from_secs(2), || orphans::has_client(pid).then_some(())).is_some());
    drop(s);
    assert!(until(Duration::from_secs(2), || (!orphans::has_client(pid)).then_some(())).is_some());
}
