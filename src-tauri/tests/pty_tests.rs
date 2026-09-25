use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use codebaer_lib::pty::daemon;
use codebaer_lib::pty::proto::{self, ClientMsg, Frame, ServerMsg, SpawnKind};

struct Harness {
    sock: PathBuf,
    _dir: tempfile::TempDir,
}

impl Harness {
    /// Neither the idle timeout nor the folder sweep fires inside a test run, so a test sees
    /// only what its own actions caused.
    fn start() -> Harness {
        Harness::sweeping(Duration::from_secs(3600))
    }

    fn sweeping(every: Duration) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("ptyd.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let hub = daemon::new_hub(sock.clone());
        std::thread::spawn(move || daemon::serve(listener, hub, Duration::from_secs(3600), every));
        Harness { sock, _dir: dir }
    }

    fn connect(&self) -> Client {
        let s = UnixStream::connect(&self.sock).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        let mut c = Client { s, buf: Vec::new(), out: Vec::new(), msgs: Vec::new() };
        c.send(&ClientMsg::Hello { proto: proto::PROTO, client: "test".into() });
        c
    }
}

struct Client {
    s: UnixStream,
    buf: Vec<u8>,
    out: Vec<(u32, Vec<u8>)>,
    msgs: Vec<ServerMsg>,
}

impl Client {
    fn send(&mut self, msg: &ClientMsg) {
        let mut wire = Vec::new();
        proto::encode(&Frame::Control(serde_json::to_vec(msg).unwrap()), &mut wire);
        self.s.write_all(&wire).unwrap();
    }

    fn input(&mut self, id: u32, bytes: &[u8]) {
        let mut wire = Vec::new();
        proto::encode(&Frame::Input(id, bytes.to_vec()), &mut wire);
        self.s.write_all(&wire).unwrap();
    }

    fn pump(&mut self, how_long: Duration) {
        let deadline = Instant::now() + how_long;
        let mut chunk = [0u8; 65536];
        while Instant::now() < deadline {
            match self.s.read(&mut chunk) {
                Ok(0) => return,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(_) => {}
            }
            let mut off = 0;
            while let Ok(Some((frame, used))) = proto::decode(&self.buf[off..]) {
                off += used;
                match frame {
                    Frame::Output(id, bytes) => self.out.push((id, bytes)),
                    Frame::Control(json) => {
                        if let Ok(m) = serde_json::from_slice::<ServerMsg>(&json) {
                            self.msgs.push(m);
                        }
                    }
                    Frame::Input(..) => {}
                }
            }
            self.buf.drain(..off);
        }
    }

    /// Pumps until `needle` shows up in a session's output, or gives up.
    fn wait_for(&mut self, needle: &str, how_long: Duration) -> bool {
        let deadline = Instant::now() + how_long;
        while Instant::now() < deadline {
            self.pump(Duration::from_millis(120));
            if self.text().contains(needle) {
                return true;
            }
        }
        false
    }

    fn text(&self) -> String {
        let mut all = Vec::new();
        for (_, b) in &self.out {
            all.extend_from_slice(b);
        }
        String::from_utf8_lossy(&all).into_owned()
    }

    fn spawn_sh(&mut self, cwd: &str) -> u32 {
        self.spawn_shell("/bin/sh", cwd)
    }

    fn spawn_shell(&mut self, path: &str, cwd: &str) -> u32 {
        self.send(&ClientMsg::Spawn {
            req: 1,
            kind: SpawnKind::Shell { path: path.into() },
            cwd: cwd.into(),
            cols: 80,
            rows: 24,
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            self.pump(Duration::from_millis(100));
            for m in &self.msgs {
                if let ServerMsg::Spawned { info, .. } = m {
                    return info.id;
                }
            }
        }
        panic!("no session was spawned: {:?}", self.msgs);
    }

    /// The folders reported for `id`, oldest first.
    fn cwds(&self, id: u32) -> Vec<String> {
        self.msgs
            .iter()
            .filter_map(|m| match m {
                ServerMsg::Cwd { id: got, cwd } if *got == id => Some(cwd.clone()),
                _ => None,
            })
            .collect()
    }

    fn wait_for_cwd(&mut self, id: u32, want: &str, how_long: Duration) -> bool {
        let deadline = Instant::now() + how_long;
        while Instant::now() < deadline {
            self.pump(Duration::from_millis(120));
            if self.cwds(id).iter().any(|c| c == want) {
                return true;
            }
        }
        false
    }
}

/// Real paths, because that is what the kernel reports: a tempdir lives under /var, which is a
/// symlink to /private/var.
fn real_dir() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
    (dir, path)
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn a_session_runs_a_real_shell_and_echoes_its_output() {
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh("/tmp");
    c.input(id, b"echo codebaer-ok\n");
    assert!(c.wait_for("codebaer-ok", Duration::from_secs(5)), "got: {:?}", c.text());
}

#[test]
fn a_task_runs_its_line_and_stays_a_task_until_promoted() {
    let (_dir, cwd) = real_dir();
    let h = Harness::start();
    let mut c = h.connect();
    let kind = SpawnKind::Task { line: "echo task-$((40 + 2)) && exit 3".into(), title: "answer".into() };
    c.send(&ClientMsg::Spawn { req: 7, kind, cwd, cols: 80, rows: 24 });
    // the arithmetic proves a shell ran the line rather than a program being handed it as argv
    assert!(c.wait_for("task-42", Duration::from_secs(10)), "got: {:?}", c.text());
    let info = c
        .msgs
        .iter()
        .find_map(|m| match m {
            ServerMsg::Spawned { req: 7, info } => Some(info.clone()),
            _ => None,
        })
        .expect("a Spawned for the task");
    assert!(info.task);
    assert_eq!(info.title, "answer");

    let exited = |c: &Client| c.msgs.iter().any(|m| matches!(m, ServerMsg::Exit { id, code: Some(3) } if *id == info.id));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !exited(&c) {
        c.pump(Duration::from_millis(100));
    }
    assert!(exited(&c), "the shell ends with the line: {:?}", c.msgs);

    c.send(&ClientMsg::Promote { id: info.id });
    c.msgs.clear();
    c.send(&ClientMsg::Hello { proto: proto::PROTO, client: "test".into() });
    let listed = |c: &Client| {
        c.msgs.iter().find_map(|m| match m {
            ServerMsg::Hello { sessions, .. } => sessions.iter().find(|s| s.id == info.id).cloned(),
            _ => None,
        })
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && listed(&c).is_none() {
        c.pump(Duration::from_millis(100));
    }
    let after = listed(&c).expect("the exited task is still listed");
    assert!(!after.task, "a promoted task lists as a terminal, so a reload keeps it in the rail");
}

#[test]
fn a_reattaching_client_is_replayed_the_scrollback_it_missed() {
    let h = Harness::start();
    let id = {
        let mut first = h.connect();
        let id = first.spawn_sh("/tmp");
        first.input(id, b"echo before-the-reload\n");
        assert!(first.wait_for("before-the-reload", Duration::from_secs(5)));
        id
    };
    // the first client is dropped, exactly as a webview reload or a rebuild drops it
    let mut second = h.connect();
    second.send(&ClientMsg::Attach { id: None });
    assert!(
        second.wait_for("before-the-reload", Duration::from_secs(5)),
        "a new client must be replayed the ring, got: {:?}",
        second.text()
    );
    assert!(second.text().contains("before-the-reload"));
    let _ = id;
}

#[test]
fn the_session_survives_the_client_that_started_it() {
    let h = Harness::start();
    let id = {
        let mut first = h.connect();
        let id = first.spawn_sh("/tmp");
        first.input(id, b"echo one\n");
        assert!(first.wait_for("one", Duration::from_secs(5)));
        id
    };
    std::thread::sleep(Duration::from_millis(300));
    let mut second = h.connect();
    second.send(&ClientMsg::Attach { id: None });
    second.pump(Duration::from_millis(400));
    second.input(id, b"echo still-here\n");
    assert!(
        second.wait_for("still-here", Duration::from_secs(5)),
        "the same shell must still be accepting input: {:?}",
        second.text()
    );
}

#[test]
fn killing_a_session_reaches_past_the_shell_into_its_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("child.pid");
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh(&dir.path().to_string_lossy());
    // a job control shell puts this in a process group of its own, so killpg on the shell
    // alone would leave it running: this is the orphan the hangup has to reach
    c.input(id, format!("sleep 300 & echo $! > {} ; echo armed\n", pidfile.display()).as_bytes());
    assert!(c.wait_for("armed", Duration::from_secs(5)), "got: {:?}", c.text());

    let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    assert!(alive(pid), "the job should be running before we kill anything");

    c.send(&ClientMsg::Kill { id });
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!alive(pid), "pid {pid} outlived its session");
}

#[test]
fn shutdown_takes_every_session_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("child.pid");
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh(&dir.path().to_string_lossy());
    c.input(id, format!("sleep 300 & echo $! > {} ; echo armed\n", pidfile.display()).as_bytes());
    assert!(c.wait_for("armed", Duration::from_secs(5)));
    let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();

    c.send(&ClientMsg::Shutdown);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!alive(pid), "quitting the app must leave nothing behind, pid {pid} survived");
}

#[test]
fn a_shell_reports_its_prompt_and_command_marks() {
    let h = Harness::start();
    let mut c = h.connect();
    // zsh gets the injected hooks, so this is the real end to end check that the scripts in
    // shells.rs emit marks the scanner in osc133.rs actually reads
    c.send(&ClientMsg::Spawn {
        req: 9,
        kind: SpawnKind::Shell { path: "/bin/zsh".into() },
        cwd: "/tmp".into(),
        cols: 80,
        rows: 24,
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut id = 0;
    while Instant::now() < deadline && id == 0 {
        c.pump(Duration::from_millis(100));
        for m in &c.msgs {
            if let ServerMsg::Spawned { info, .. } = m {
                id = info.id;
            }
        }
    }
    assert!(id != 0, "zsh did not spawn");
    c.pump(Duration::from_millis(800));
    c.input(id, b"echo marked\n");
    assert!(c.wait_for("marked", Duration::from_secs(5)));
    c.pump(Duration::from_millis(500));

    let ran = c.msgs.iter().any(|m| {
        matches!(m, ServerMsg::Status { state: proto::State::Running { command: Some(cmd), .. }, .. } if cmd.contains("echo marked"))
    });
    let idle = c.msgs.iter().any(|m| matches!(m, ServerMsg::Status { state: proto::State::Idle, .. }));
    assert!(ran, "the command mark never arrived: {:?}", c.msgs);
    assert!(idle, "the prompt mark never arrived: {:?}", c.msgs);
}

#[test]
fn closing_a_live_session_does_not_strand_its_process_tree() {
    // Close used to only drop the record. Teardown iterates that map, and the reader thread
    // still holds a dup of the master fd, so nothing could ever reach the tree again.
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("child.pid");
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh(&dir.path().to_string_lossy());
    c.input(id, format!("sleep 300 & echo $! > {} ; echo armed\n", pidfile.display()).as_bytes());
    assert!(c.wait_for("armed", Duration::from_secs(5)));
    let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    assert!(alive(pid));

    c.send(&ClientMsg::Close { id });
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!alive(pid), "pid {pid} was stranded by Close");
}

#[test]
fn a_session_that_writes_as_it_closes_is_still_reaped() {
    // exit blocks until a tty's queued output drains, which nothing does while the host keeps
    // the master open without reading it; macOS lists such a process as `?E` with its name in
    // parentheses, and killpg refuses its group, so the host's own escalation cannot end it
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("shell.pid");
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh(&dir.path().to_string_lossy());
    let script = "trap '' TERM; trap 'printf a; sleep 0.3; printf b; sleep 0.3; printf c; exit' HUP";
    // quoted apart so the echo of the typed line cannot pass for it having run
    c.input(id, format!("{script}; echo $$ > {}; echo ar''med\n", pidfile.display()).as_bytes());
    assert!(c.wait_for("armed", Duration::from_secs(5)));
    let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();

    c.send(&ClientMsg::Close { id });
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && alive(pid) {
        c.pump(Duration::from_millis(100));
    }
    assert!(!alive(pid), "pid {pid} is stuck exiting after Close");
}

#[test]
fn a_new_session_reports_the_folder_its_shell_really_started_in() {
    let h = Harness::start();
    let mut c = h.connect();
    // /tmp is a symlink, so the kernel's answer differs from the spawn folder without any cd
    let id = c.spawn_sh("/tmp");
    assert!(
        c.wait_for_cwd(id, "/private/tmp", Duration::from_secs(5)),
        "the first output must trigger a check: {:?}",
        c.msgs
    );
}

#[test]
fn a_shell_that_changes_folder_reports_it_at_its_next_prompt() {
    let (_a, start) = real_dir();
    let (_b, moved) = real_dir();
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_shell("/bin/zsh", &start);
    c.pump(Duration::from_millis(800));
    c.input(id, format!("cd '{moved}'\n").as_bytes());
    assert!(c.wait_for_cwd(id, &moved, Duration::from_secs(5)), "got: {:?}", c.msgs);
}

#[test]
fn a_check_on_demand_finds_a_folder_change_nothing_announced() {
    let (_a, start) = real_dir();
    let (_b, moved) = real_dir();
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh(&start);
    c.input(id, format!("cd '{moved}' && echo moved-now\n").as_bytes());
    assert!(c.wait_for("moved-now", Duration::from_secs(5)), "got: {:?}", c.text());
    c.pump(Duration::from_millis(300));
    // sh has no prompt marks, so only the explicit check can have noticed
    assert!(c.cwds(id).is_empty(), "reported before anyone asked: {:?}", c.cwds(id));

    c.send(&ClientMsg::CheckCwd);
    assert!(c.wait_for_cwd(id, &moved, Duration::from_secs(5)), "got: {:?}", c.msgs);
}

#[test]
fn a_session_that_stayed_put_reports_nothing() {
    let (_a, start) = real_dir();
    let h = Harness::start();
    let mut c = h.connect();
    let id = c.spawn_sh(&start);
    c.input(id, b"echo settled\n");
    assert!(c.wait_for("settled", Duration::from_secs(5)));
    c.send(&ClientMsg::CheckCwd);
    c.pump(Duration::from_millis(500));
    assert!(c.cwds(id).is_empty(), "an unchanged folder is not news: {:?}", c.cwds(id));
}

#[test]
fn the_host_rechecks_every_session_on_its_own_timer() {
    let (_a, start) = real_dir();
    let (_b, moved) = real_dir();
    let h = Harness::sweeping(Duration::from_millis(200));
    let mut c = h.connect();
    let id = c.spawn_sh(&start);
    c.input(id, format!("cd '{moved}'\n").as_bytes());
    assert!(c.wait_for_cwd(id, &moved, Duration::from_secs(5)), "got: {:?}", c.msgs);
}
