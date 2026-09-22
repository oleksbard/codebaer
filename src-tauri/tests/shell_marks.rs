//! The injected rc scripts are shell source, so the only honest test of them is a real shell
//! on a real pty. These drive bash and zsh the way a session does and read the marks back
//! through the same scanner the daemon uses.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use codebaer_lib::pty::osc133::{Mark, Scanner};
use codebaer_lib::pty::shells;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// Runs `shell` with our injection against a throwaway HOME, feeds `input`, returns the marks.
fn marks(shell: &str, home_files: &[(&str, &str)], input: &str) -> Vec<Mark> {
    let home = tempfile::tempdir().unwrap();
    let rcdir = tempfile::tempdir().unwrap();
    for (name, body) in home_files {
        std::fs::write(home.path().join(name), body).unwrap();
    }
    let inj = shells::injection(shell, rcdir.path(), None).expect("this shell is injectable");
    for (name, body) in &inj.files {
        std::fs::write(rcdir.path().join(name), body).unwrap();
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    let mut cmd = CommandBuilder::new(shell);
    for a in &inj.args {
        cmd.arg(a);
    }
    for (k, v) in &inj.env {
        cmd.env(k, v);
    }
    cmd.env("HOME", home.path());
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(home.path());
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let collector = std::thread::spawn(move || {
        let mut scanner = Scanner::new();
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            scanner.feed(&buf[..n], &mut out);
        }
        out
    });

    std::thread::sleep(Duration::from_millis(500));
    writer.write_all(input.as_bytes()).unwrap();
    writer.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    drop(writer);
    drop(pair.master);
    collector.join().unwrap()
}

fn commands(marks: &[Mark]) -> Vec<String> {
    marks
        .iter()
        .filter_map(|m| match m {
            Mark::CommandStart(c) => Some(c.clone()),
            _ => None,
        })
        .collect()
}

fn exits(marks: &[Mark]) -> Vec<Option<i32>> {
    marks
        .iter()
        .filter_map(|m| match m {
            Mark::CommandEnd(c) => Some(*c),
            _ => None,
        })
        .collect()
}

#[test]
fn bash_reports_the_command_the_user_ran() {
    let m = marks("/bin/bash", &[], "echo one\nfalse\nexit\n");
    assert!(commands(&m).iter().any(|c| c == "echo one"), "{:?}", commands(&m));
    assert!(exits(&m).contains(&Some(1)), "a failing command must report its code: {:?}", exits(&m));
}

#[test]
fn bash_reports_the_command_even_when_the_user_has_a_prompt_command() {
    // history -a, starship, direnv, atuin and oh-my-bash all set this, so it is the common
    // case: with our hook running first it consumed the DEBUG guard and every command was
    // reported as the user's prompt command instead of theirs
    let m = marks(
        "/bin/bash",
        &[(".bashrc", "PROMPT_COMMAND='history -a'\nPS1='$ '\n")],
        "echo one\nfalse\nexit\n",
    );
    let cmds = commands(&m);
    assert!(cmds.iter().any(|c| c == "echo one"), "{cmds:?}");
    assert!(!cmds.iter().any(|c| c.contains("history -a")), "reported the prompt command: {cmds:?}");
    assert!(exits(&m).contains(&Some(1)), "{:?}", exits(&m));
}

#[test]
fn zsh_reports_the_command_the_user_ran() {
    let m = marks("/bin/zsh", &[], "echo one\nfalse\nexit\n");
    assert!(commands(&m).iter().any(|c| c == "echo one"), "{:?}", commands(&m));
    assert!(exits(&m).contains(&Some(1)), "{:?}", exits(&m));
}

#[test]
fn zsh_keeps_the_config_of_a_user_who_sets_zdotdir_in_zshenv() {
    // the XDG layout. Overwriting ZDOTDIR without reading back what .zshenv set sent every
    // later startup file to $HOME, silently losing the user's aliases, PATH and prompt.
    let home = tempfile::tempdir().unwrap();
    let xdg = home.path().join(".config/zsh");
    std::fs::create_dir_all(&xdg).unwrap();
    std::fs::write(home.path().join(".zshenv"), format!("export ZDOTDIR={:?}\n", xdg)).unwrap();
    std::fs::write(xdg.join(".zshrc"), "export CB_REAL_RC=yes\n").unwrap();

    let rcdir = tempfile::tempdir().unwrap();
    let inj = shells::injection("/bin/zsh", rcdir.path(), None).unwrap();
    for (name, body) in &inj.files {
        std::fs::write(rcdir.path().join(name), body).unwrap();
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    let mut cmd = CommandBuilder::new("/bin/zsh");
    for a in &inj.args {
        cmd.arg(a);
    }
    for (k, v) in &inj.env {
        cmd.env(k, v);
    }
    cmd.env("HOME", home.path());
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(home.path());
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let collector = std::thread::spawn(move || {
        let mut all = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&all).into_owned()
    });
    std::thread::sleep(Duration::from_millis(600));
    writer.write_all(b"echo RC=[$CB_REAL_RC]\nexit\n").unwrap();
    writer.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    drop(writer);
    drop(pair.master);
    let text = collector.join().unwrap();
    assert!(text.contains("RC=[yes]"), "the user's own .zshrc never ran:\n{text}");
}
