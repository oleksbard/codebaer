use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use codebaer_lib::git::status_impl;
use codebaer_lib::watcher;

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(root).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// What a refresh does is read the repo, and on Linux inotify reports every file that opens: counted as a change,
/// each refresh would start the next one.
#[test]
fn reading_the_repo_is_not_a_change_and_writing_a_file_is() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    git(&root, &["init", "-q"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&root, &["add", "a.txt"]);
    git(&root, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
    std::fs::write(root.join("a.txt"), "two\n").unwrap();
    // past the index's timestamp resolution, so the status below settles the index for good
    std::thread::sleep(Duration::from_millis(1100));
    status_impl(&root).unwrap();

    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let gd = root.join(".git");
    let _w = watcher::start(&root, &gd, &gd, move || {
        counter.fetch_add(1, Ordering::SeqCst);
    })
    .unwrap();
    std::thread::sleep(Duration::from_secs(1));
    hits.store(0, Ordering::SeqCst);

    for _ in 0..3 {
        status_impl(&root).unwrap();
        std::thread::sleep(Duration::from_millis(300));
    }
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(hits.load(Ordering::SeqCst), 0, "a git status counted as a change");

    std::fs::write(root.join("a.txt"), "three\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while hits.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(hits.load(Ordering::SeqCst) > 0, "a write went unnoticed");
}
