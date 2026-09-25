//! The premise of the whole feature: the pty host must not be reachable from the app's
//! process tree, because `tauri dev` kills that tree on every rebuild. These tests run the
//! real binary rather than `serve()` in a thread, so `daemonize()` is actually exercised.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use codebaer_lib::pty::proto::{self, ClientMsg, Frame, ServerMsg, SpawnKind};

const BIN: &str = env!("CARGO_BIN_EXE_CodeBär");

fn wait_for_socket(sock: &Path) -> UnixStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = UnixStream::connect(sock) {
            return s;
        }
        assert!(Instant::now() < deadline, "the host never bound {}", sock.display());
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn pgrep(sock: &Path) -> Vec<i32> {
    // the pattern must not start with a dash: pgrep parses "--pty-host ..." as its own option
    // and reports nothing, which would make every assertion below vacuously wrong
    let out = Command::new("pgrep").arg("-f").arg("--").arg(sock.display().to_string()).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect())
        .unwrap_or_default()
}

fn ppid_of(pid: i32) -> i32 {
    let out = Command::new("ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(-1)
}

fn send(s: &mut UnixStream, msg: &ClientMsg) {
    let mut wire = Vec::new();
    proto::encode(&Frame::Control(serde_json::to_vec(msg).unwrap()), &mut wire);
    s.write_all(&wire).unwrap();
}

struct Host {
    sock: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

impl Host {
    fn start() -> Host {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("ptyd.sock");
        let mut spawner = Command::new(BIN).arg("--pty-host").arg(&sock).spawn().unwrap();
        // the process we spawned forks and exits at once; the survivor is the host
        let status = spawner.wait().unwrap();
        assert!(status.success(), "the spawned process should exit immediately, got {status}");
        Host { sock, _dir: dir }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        for pid in pgrep(&self.sock) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

#[test]
fn the_host_reparents_itself_out_of_the_process_that_started_it() {
    let host = Host::start();
    let _s = wait_for_socket(&host.sock);
    let pids = pgrep(&host.sock);
    assert_eq!(pids.len(), 1, "expected exactly one host, found {pids:?}");
    let ppid = ppid_of(pids[0]);
    // 1 is launchd. Anything else means a walk of this test binary's child tree would find
    // the host, which is precisely what a rebuild does to the app.
    assert_eq!(ppid, 1, "host {} still has parent {ppid}", pids[0]);
}

#[test]
fn the_host_outlives_the_client_and_still_answers() {
    let host = Host::start();
    {
        let mut first = wait_for_socket(&host.sock);
        send(&mut first, &ClientMsg::Hello { proto: proto::PROTO, client: "one".into() });
        send(&mut first, &ClientMsg::Spawn {
            req: 1,
            kind: SpawnKind::Shell { path: "/bin/sh".into() },
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
        });
        std::thread::sleep(Duration::from_millis(600));
    }
    // the client is gone, as it is when the app is SIGKILLed mid-rebuild
    std::thread::sleep(Duration::from_millis(300));
    let mut second = wait_for_socket(&host.sock);
    second.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    send(&mut second, &ClientMsg::Hello { proto: proto::PROTO, client: "two".into() });

    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sessions = 0;
    while Instant::now() < deadline && sessions == 0 {
        if let Ok(n) = second.read(&mut chunk) {
            buf.extend_from_slice(&chunk[..n]);
        }
        let mut off = 0;
        while let Ok(Some((frame, used))) = proto::decode(&buf[off..]) {
            off += used;
            if let Frame::Control(json) = frame {
                if let Ok(ServerMsg::Hello { sessions: s, .. }) = serde_json::from_slice(&json) {
                    sessions = s.len();
                }
            }
        }
        buf.drain(..off);
    }
    assert_eq!(sessions, 1, "the session started by the first client must still be there");

    send(&mut second, &ClientMsg::Shutdown);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !pgrep(&host.sock).is_empty() {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(pgrep(&host.sock).is_empty(), "shutdown must take the host with it");
    assert!(!host.sock.exists(), "the socket file must be cleaned up");
}
