use std::io::Read;
use std::process::Command;
use std::time::{Duration, Instant};

use codebaer_lib::pty::orphans;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn stat(pid: i32) -> String {
    let out = Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A process of its own, since this test plays the host and every pty it holds counts.
#[test]
fn flushing_a_leftover_terminal_lets_a_session_stuck_exiting_finish() {
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
    let sh = |script: &str| {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    };
    // a live terminal with output its host has not read yet, which the flush must leave alone
    let live = native_pty_system().openpty(size).unwrap();
    let mut running = live.slave.spawn_command(sh("printf LIVEOUTPUT; sleep 10")).unwrap();
    drop(live.slave);

    let pair = native_pty_system().openpty(size).unwrap();
    let mut child = pair.slave.spawn_command(sh("printf %0200d 0; exit")).unwrap();
    drop(pair.slave);
    let pid = child.process_id().unwrap() as i32;
    // the master stays open and is never read, as the host left a closed session's
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !stat(pid).contains('E') {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(stat(pid).contains('E'), "the child never got stuck exiting: {:?}", stat(pid));

    let reaper = std::thread::spawn(move || child.wait());
    orphans::unstick(std::process::id() as i32, pid).unwrap();
    assert!(reaper.join().unwrap().is_ok());
    drop(pair.master);

    let mut out = [0u8; 64];
    let n = live.master.try_clone_reader().unwrap().read(&mut out).unwrap();
    running.kill().unwrap();
    assert_eq!(&out[..n], b"LIVEOUTPUT");
}
