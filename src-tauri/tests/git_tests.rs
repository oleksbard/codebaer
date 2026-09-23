use codebaer_lib::eol::Eol;
use codebaer_lib::git::{blame_impl, discover, head_entry, read_blob_impl, read_file_at, resolve, run, run_locked, run_raw, stage_content_impl, status_impl, write_file_impl, FileText, Rev, LOCAL};
use codebaer_lib::git::{discard_all_impl, discard_preview_impl, revert_path_impl, stage_all_impl, stage_path_impl, unstage_all_impl, unstage_path_impl};
use codebaer_lib::git::{branches_impl, commit_impl, create_branch_impl, list_dir_impl, list_files_impl, stash_pop_impl, stash_push_impl, switch_branch_impl, Branch};
use codebaer_lib::git::{cancel_impl, push_args, run_net, AppState};
use codebaer_lib::AppError;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

pub fn sh(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(root).output().unwrap();
    assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

pub fn repo() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    sh(r, &["init", "-q", "-b", "main"]);
    sh(r, &["config", "user.email", "t@t"]);
    sh(r, &["config", "user.name", "t"]);
    fs::write(r.join("a.txt"), "a\nb\nc\nd\n").unwrap();
    sh(r, &["add", "a.txt"]);
    sh(r, &["commit", "-qm", "init"]);
    dir
}

/// Leaves `a.txt` unmerged. The merge is expected to fail, so its exit status is ignored.
pub fn conflicted_repo() -> TempDir {
    let d = repo();
    let r = d.path();
    sh(r, &["checkout", "-q", "-b", "other"]);
    fs::write(r.join("a.txt"), "theirs\n").unwrap();
    sh(r, &["commit", "-qam", "theirs"]);
    sh(r, &["checkout", "-q", "main"]);
    fs::write(r.join("a.txt"), "ours\n").unwrap();
    sh(r, &["commit", "-qam", "ours"]);
    let _ = Command::new("git").args(["merge", "other"]).current_dir(r).output().unwrap();
    d
}

#[test]
fn run_returns_stdout_and_errors_on_nonzero() {
    let d = repo();
    let out = run(d.path(), &["rev-parse", "--abbrev-ref", "HEAD"], None, Some(LOCAL)).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "main");
    let err = run(d.path(), &["rev-parse", "--verify", "nope"], None, Some(LOCAL)).unwrap_err();
    assert!(matches!(err, AppError::Git(ref s) if s.contains("fatal")));
}

#[test]
fn run_raw_reports_exit_code_without_error() {
    let d = repo();
    let out = run_raw(d.path(), &["rev-parse", "-q", "--verify", ":nope.txt"], None, Some(LOCAL), None).unwrap();
    assert_eq!(out.code, 1);
    assert!(out.stdout.is_empty());
}

#[test]
fn run_passes_stdin() {
    let d = repo();
    let out = run(d.path(), &["hash-object", "--stdin"], Some(b"hello\n"), Some(LOCAL)).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
}

#[test]
fn run_times_out_and_kills_the_process_group() {
    let d = repo();
    let script = d.path().join("fsm.sh");
    let pidfile = d.path().join("hook.pid");
    fs::write(&script, format!("#!/bin/sh\necho $$ > \"{}\"\nsleep 30\n", pidfile.to_str().unwrap())).unwrap();
    sh(d.path(), &["config", "core.fsmonitor", script.to_str().unwrap()]);
    Command::new("chmod").arg("+x").arg(&script).status().unwrap();
    let started = std::time::Instant::now();
    let err = run(d.path(), &["status", "--porcelain=v2"], None, Some(std::time::Duration::from_millis(500))).unwrap_err();
    assert_eq!(err, AppError::Timeout);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));

    let pid = fs::read_to_string(&pidfile)
        .expect("hook should have written its pid before sleeping")
        .trim()
        .to_string();
    // SIGKILL lands immediately but reaping the grandchild can lag by a beat,
    // so poll briefly instead of asserting on the very first sample.
    let gone = (0..20).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(50));
        !Command::new("ps").args(["-p", &pid]).output().unwrap().status.success()
    });
    assert!(gone, "hook process {pid} should have been killed with the process group");
}

#[test]
fn run_locked_retries_while_index_lock_exists() {
    let d = repo();
    let lock = d.path().join(".git/index.lock");
    fs::write(&lock, "").unwrap();
    fs::write(d.path().join("a.txt"), "a\nb\nc\nd\ne\n").unwrap();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = fs::remove_file(&lock);
    });
    let out = run_locked(d.path(), &["add", "a.txt"], None, Some(LOCAL)).unwrap();
    assert_eq!(out.code, 0);
    let staged = sh(d.path(), &["diff", "--cached", "--name-only"]);
    assert!(staged.contains("a.txt"));
}

#[test]
fn resolve_refuses_the_dangerous_shapes() {
    let d = repo();
    let r = d.path();
    fs::create_dir_all(r.join("src")).unwrap();
    fs::write(r.join("src/x.txt"), "x").unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "s").unwrap();
    std::os::unix::fs::symlink(outside.path(), r.join("outlink")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), r.join("filelink.txt")).unwrap();
    std::os::unix::fs::symlink(r.join("src"), r.join("inlink")).unwrap();

    for bad in ["", ".", "src/", "../x", "src/../x.txt", "/etc/passwd", ".git/config", ".GIT/hooks/pre-commit",
                "src/.git/x", "outlink/secret.txt"] {
        assert!(matches!(resolve(r, bad), Err(AppError::InvalidPath(_))), "should refuse {bad:?}");
    }
    for special in ["src", "filelink.txt", "inlink"] {
        assert_eq!(resolve(r, special).unwrap_err(), AppError::Special, "not a regular file: {special:?}");
    }
    assert!(resolve(r, "a.txt").is_ok());
    assert!(resolve(r, "src/x.txt").is_ok());
    assert!(resolve(r, "src/deep/new.txt").is_ok(), "missing components are allowed");
    assert!(resolve(r, "inlink/x.txt").is_ok(), "a directory symlink that stays inside the root is allowed");
    assert!(resolve(r, "a[1].txt").is_ok());
}

#[test]
fn resolve_refuses_a_symlink_alias_for_dot_git() {
    let d = repo();
    let r = d.path();
    std::os::unix::fs::symlink(r.join(".git"), r.join("gitlink")).unwrap();
    assert!(
        matches!(resolve(r, "gitlink/hooks/pre-commit"), Err(AppError::InvalidPath(_))),
        "a directory symlink aliasing .git must not let a write land inside .git"
    );
    assert!(
        matches!(resolve(r, "gitlink/config"), Err(AppError::InvalidPath(_))),
        "an existing file reached through a .git alias must also be refused"
    );
}

#[test]
fn resolve_allows_a_file_whose_directory_was_deleted() {
    let d = repo();
    assert!(resolve(d.path(), "gone/deeper/file.txt").is_ok());
}

#[test]
fn discover_gives_absolute_dirs_from_a_subdirectory_and_a_worktree() {
    let d = repo();
    let r = d.path();
    fs::create_dir_all(r.join("sub/deep")).unwrap();
    let info = discover(&r.join("sub/deep")).unwrap();
    assert_eq!(info.root, r.canonicalize().unwrap());
    assert!(info.git_dir.is_absolute() && info.git_dir.ends_with(".git"));
    assert_eq!(info.common_dir, info.git_dir);

    let wt = tempfile::tempdir().unwrap();
    sh(r, &["worktree", "add", "-q", wt.path().join("wt").to_str().unwrap(), "-b", "wt"]);
    let w = discover(&wt.path().join("wt")).unwrap();
    assert_eq!(w.root, wt.path().join("wt").canonicalize().unwrap());
    assert!(w.git_dir.to_string_lossy().contains(".git/worktrees/wt"));
    assert_eq!(w.common_dir, info.git_dir);
    let not_repo = tempfile::tempdir().unwrap();
    assert_eq!(discover(not_repo.path()).unwrap_err(), AppError::NotARepo);
}

#[test]
fn status_parses_a_real_partial_stage() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "A\nb\nc\nD\n").unwrap();
    fs::write(r.join("n.txt"), "new\n").unwrap();
    let st = status_impl(r).unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!((a.index_status, a.worktree_status), ('.', 'M'));
    assert!(st.files.iter().any(|f| f.path == "n.txt" && f.untracked));
}

#[test]
fn status_on_unborn_and_detached() {
    let dir = tempfile::tempdir().unwrap();
    sh(dir.path(), &["init", "-q", "-b", "main"]);
    let st = status_impl(dir.path()).unwrap();
    assert_eq!(st.head, None);
    let d = repo();
    sh(d.path(), &["checkout", "-q", "--detach"]);
    assert_eq!(status_impl(d.path()).unwrap().branch, None);
}

#[test]
fn read_file_normalises_and_reports_eol_and_absence() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("crlf.txt"), "a\r\nb\r\n").unwrap();
    let t = read_file_at(&r.join("crlf.txt")).unwrap();
    assert_eq!(t, FileText { text: "a\nb\n".into(), eol: Eol::Crlf, exists: true });
    let gone = read_file_at(&r.join("nope.txt")).unwrap();
    assert_eq!(gone, FileText { text: String::new(), eol: Eol::Lf, exists: false });
}

#[test]
fn read_file_typed_errors() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("bin"), b"ab\0cd").unwrap();
    assert_eq!(read_file_at(&r.join("bin")).unwrap_err(), AppError::Binary);
    fs::write(r.join("latin1.txt"), [0xe9, b'\n']).unwrap();
    assert_eq!(read_file_at(&r.join("latin1.txt")).unwrap_err(), AppError::NotUtf8);
    std::os::unix::fs::symlink(r.join("a.txt"), r.join("link.txt")).unwrap();
    assert_eq!(read_file_at(&r.join("link.txt")).unwrap_err(), AppError::Special);
    let big = fs::File::create(r.join("big.txt")).unwrap();
    big.set_len(2 * 1024 * 1024 + 1).unwrap();
    assert_eq!(read_file_at(&r.join("big.txt")).unwrap_err(), AppError::TooLarge);
}

#[test]
fn write_file_is_stale_when_disk_moved_and_keeps_mode_and_eol() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("s.sh"), "#!/bin/sh\r\necho 1\r\n").unwrap();
    fs::set_permissions(r.join("s.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    let err = write_file_impl(r, "s.sh", "#!/bin/sh\necho 2\n", Eol::Crlf, Some("stale text\n")).unwrap_err();
    assert!(matches!(err, AppError::Stale(ref cur) if cur.text == "#!/bin/sh\necho 1\n"));
    write_file_impl(r, "s.sh", "#!/bin/sh\necho 2\n", Eol::Crlf, Some("#!/bin/sh\necho 1\n")).unwrap();
    assert_eq!(fs::read(r.join("s.sh")).unwrap(), b"#!/bin/sh\r\necho 2\r\n");
    assert_eq!(fs::metadata(r.join("s.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    assert!(fs::read_dir(r).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".tmp")));
}

#[test]
fn write_file_expected_null_semantics_and_missing_parents() {
    let d = repo();
    let r = d.path();
    assert!(matches!(write_file_impl(r, "a.txt", "x\n", Eol::Lf, None).unwrap_err(), AppError::Stale(_)));
    assert!(matches!(write_file_impl(r, "ghost.txt", "x\n", Eol::Lf, Some("")).unwrap_err(), AppError::Stale(ref c) if !c.exists));
    write_file_impl(r, "new/deep/f.txt", "x\n", Eol::Lf, None).unwrap();
    assert_eq!(fs::read_to_string(r.join("new/deep/f.txt")).unwrap(), "x\n");
    std::os::unix::fs::symlink(r.join("a.txt"), r.join("link.txt")).unwrap();
    assert_eq!(write_file_impl(r, "link.txt", "x", Eol::Lf, Some("a\nb\nc\nd\n")).unwrap_err(), AppError::Special);
}

#[test]
fn write_file_new_file_gets_0644_and_temp_names_are_unique() {
    let d = repo();
    let r = d.path();
    write_file_impl(r, "one.txt", "one\n", Eol::Lf, None).unwrap();
    write_file_impl(r, "two.txt", "two\n", Eol::Lf, None).unwrap();
    assert_eq!(fs::read_to_string(r.join("one.txt")).unwrap(), "one\n");
    assert_eq!(fs::read_to_string(r.join("two.txt")).unwrap(), "two\n");
    assert_eq!(fs::metadata(r.join("one.txt")).unwrap().permissions().mode() & 0o777, 0o644);
    assert_eq!(fs::metadata(r.join("two.txt")).unwrap().permissions().mode() & 0o777, 0o644);
    assert!(fs::read_dir(r).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".tmp")));
}

#[test]
fn read_blob_index_head_absent_and_unborn() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "A\nb\nc\nd\n").unwrap();
    sh(r, &["add", "a.txt"]);
    let idx = read_blob_impl(r, Rev::Index, "a.txt").unwrap();
    assert_eq!(idx.text, "A\nb\nc\nd\n");
    assert!(idx.exists && idx.oid.is_some());
    let head = read_blob_impl(r, Rev::Head, "a.txt").unwrap();
    assert_eq!(head.text, "a\nb\nc\nd\n");
    let absent = read_blob_impl(r, Rev::Index, "nope.txt").unwrap();
    assert!(!absent.exists && absent.oid.is_none() && absent.text.is_empty());
    let u = tempfile::tempdir().unwrap();
    sh(u.path(), &["init", "-q"]);
    assert!(!read_blob_impl(u.path(), Rev::Head, "x.txt").unwrap().exists);
}

#[test]
fn read_blob_conflicted_special_and_too_large() {
    let d = repo();
    let r = d.path();
    sh(r, &["checkout", "-q", "-b", "other"]);
    fs::write(r.join("a.txt"), "theirs\n").unwrap();
    sh(r, &["commit", "-qam", "theirs"]);
    sh(r, &["checkout", "-q", "main"]);
    fs::write(r.join("a.txt"), "ours\n").unwrap();
    sh(r, &["commit", "-qam", "ours"]);
    let _ = Command::new("git").args(["merge", "other"]).current_dir(r).output().unwrap();
    assert_eq!(read_blob_impl(r, Rev::Index, "a.txt").unwrap_err(), AppError::Conflicted);

    let d2 = repo();
    let r2 = d2.path();
    std::os::unix::fs::symlink("a.txt", r2.join("l.txt")).unwrap();
    sh(r2, &["add", "l.txt"]);
    assert_eq!(read_blob_impl(r2, Rev::Index, "l.txt").unwrap_err(), AppError::Special);
    fs::create_dir(r2.join("dir")).unwrap();
    fs::write(r2.join("dir/f.txt"), "f\n").unwrap();
    sh(r2, &["add", "dir"]);
    sh(r2, &["commit", "-qm", "dir"]);
    assert_eq!(read_blob_impl(r2, Rev::Head, "dir").unwrap_err(), AppError::Special);
    let big = vec![b'x'; 3 * 1024 * 1024];
    fs::write(r2.join("big.txt"), &big).unwrap();
    sh(r2, &["add", "big.txt"]);
    assert_eq!(read_blob_impl(r2, Rev::Index, "big.txt").unwrap_err(), AppError::TooLarge);
}

#[test]
fn read_blob_head_mode_comes_from_head_not_index() {
    let d = repo();
    let r = d.path();
    fs::remove_file(r.join("a.txt")).unwrap();
    std::os::unix::fs::symlink("b.txt", r.join("a.txt")).unwrap();
    sh(r, &["add", "a.txt"]);
    assert!(read_blob_impl(r, Rev::Head, "a.txt").unwrap().exists);
    assert_eq!(read_blob_impl(r, Rev::Index, "a.txt").unwrap_err(), AppError::Special);
}

fn index_oid(r: &Path, p: &str) -> Option<String> {
    let s = sh(r, &["ls-files", "-s", "--", p]);
    s.split_whitespace().nth(1).map(|x| x.to_string())
}

#[test]
fn stage_content_stages_half_a_file() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "A\nb\nc\nD\n").unwrap();
    let before = index_oid(r, "a.txt");
    let res = stage_content_impl(r, "a.txt", Some("A\nb\nc\nd\n"), Eol::Lf, before.as_deref()).unwrap();
    assert_eq!(res.oid, index_oid(r, "a.txt"));
    let st = sh(r, &["status", "--porcelain=v2"]);
    assert!(st.contains("1 MM "), "{st}");
    assert!(sh(r, &["diff", "--cached"]).contains("+A"));
    assert!(sh(r, &["diff"]).contains("+D"));
}

#[test]
fn stage_content_is_stale_when_the_index_moved() {
    let d = repo();
    let r = d.path();
    let old = index_oid(r, "a.txt");
    fs::write(r.join("a.txt"), "agent\n").unwrap();
    sh(r, &["add", "a.txt"]);
    assert_eq!(stage_content_impl(r, "a.txt", Some("mine\n"), Eol::Lf, old.as_deref()).unwrap_err(), AppError::StaleIndex);
    assert_eq!(sh(r, &["show", ":a.txt"]), "agent\n");
}

#[test]
fn stage_content_applies_clean_filters_and_text_auto() {
    let d = repo();
    let r = d.path();
    sh(r, &["config", "filter.upper.clean", "tr a-z A-Z"]);
    fs::write(r.join(".gitattributes"), "secret.txt filter=upper\ncrlf.txt text=auto\n").unwrap();
    fs::write(r.join("secret.txt"), "plain\n").unwrap();
    stage_content_impl(r, "secret.txt", Some("plain\n"), Eol::Lf, None).unwrap();
    assert_eq!(sh(r, &["show", ":secret.txt"]), "PLAIN\n");
    fs::write(r.join("crlf.txt"), "a\r\nb\r\n").unwrap();
    stage_content_impl(r, "crlf.txt", Some("a\nb\n"), Eol::Crlf, None).unwrap();
    assert_eq!(sh(r, &["show", ":crlf.txt"]), "a\nb\n");
    assert_eq!(fs::read(r.join("crlf.txt")).unwrap(), b"a\r\nb\r\n");
}

#[test]
fn stage_content_modes_follow_git_add() {
    let d = repo();
    let r = d.path();
    for (name, mode, want) in [("x755.sh", 0o755, "100755"), ("x611.sh", 0o611, "100644"), ("x700.sh", 0o700, "100755")] {
        fs::write(r.join(name), "#!/bin/sh\n").unwrap();
        fs::set_permissions(r.join(name), fs::Permissions::from_mode(mode)).unwrap();
        stage_content_impl(r, name, Some("#!/bin/sh\n"), Eol::Lf, None).unwrap();
        assert!(sh(r, &["ls-files", "-s", "--", name]).starts_with(want), "{name}");
    }
    fs::write(r.join("a.txt"), "a\nb\nc\nd\nmore\n").unwrap();
    fs::set_permissions(r.join("a.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let oid = index_oid(r, "a.txt");
    stage_content_impl(r, "a.txt", Some("a\nb\nc\nd\nmore\n"), Eol::Lf, oid.as_deref()).unwrap();
    assert!(sh(r, &["ls-files", "-s", "--", "a.txt"]).starts_with("100755"));
}

#[test]
fn stage_content_null_removes_and_bracket_names_stay_literal() {
    let d = repo();
    let r = d.path();
    fs::remove_file(r.join("a.txt")).unwrap();
    let oid = index_oid(r, "a.txt");
    let res = stage_content_impl(r, "a.txt", None, Eol::Lf, oid.as_deref()).unwrap();
    assert_eq!(res.oid, None);
    assert!(sh(r, &["status", "--porcelain=v2"]).contains("1 D. "));
    fs::write(r.join("a1.txt"), "1\n").unwrap();
    fs::write(r.join("a[1].txt"), "b\n").unwrap();
    stage_content_impl(r, "a[1].txt", Some("b\n"), Eol::Lf, None).unwrap();
    let staged = sh(r, &["diff", "--cached", "--name-only"]);
    assert!(staged.contains("a[1].txt") && !staged.contains("a1.txt") && !staged.contains(":(literal)"), "{staged}");
}

#[test]
fn stage_content_refuses_conflicted_paths() {
    let d = conflicted_repo();
    assert_eq!(stage_content_impl(d.path(), "a.txt", Some("x\n"), Eol::Lf, None).unwrap_err(), AppError::Conflicted);
}

#[test]
fn conflicted_is_set_by_status_and_cleared_by_stage_path() {
    let d = conflicted_repo();
    let r = d.path();
    let before = status_impl(r).unwrap();
    let a = before.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(a.conflicted, "{before:?}");
    stage_path_impl(r, "a.txt").unwrap();
    let after = status_impl(r).unwrap();
    let a = after.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(!a.conflicted, "{after:?}");
    assert_eq!(a.index_status, 'M');
}

#[test]
fn discard_all_is_refused_while_a_path_is_conflicted() {
    let d = conflicted_repo();
    let r = d.path();
    assert_eq!(discard_all_impl(r).unwrap_err(), AppError::Conflicted);
    assert!(fs::read_to_string(r.join("a.txt")).unwrap().contains("<<<<<<<"), "the conflicted file must be left alone");
}

#[test]
fn list_dir_lists_one_level_and_marks_subdirectories() {
    let d = repo();
    let r = d.path();
    fs::write(r.join(".gitignore"), "node_modules/\n").unwrap();
    fs::create_dir_all(r.join("node_modules/pkg/deep")).unwrap();
    fs::write(r.join("node_modules/x.js"), "1").unwrap();
    fs::write(r.join("node_modules/pkg/y.js"), "2").unwrap();

    assert_eq!(list_files_impl(r).unwrap().ignored, vec!["node_modules/"]);
    assert_eq!(list_dir_impl(r, "node_modules").unwrap(), vec!["node_modules/pkg/", "node_modules/x.js"]);
    assert_eq!(list_dir_impl(r, "node_modules/pkg").unwrap(), vec!["node_modules/pkg/deep/", "node_modules/pkg/y.js"]);
}

#[test]
fn list_dir_follows_a_symlinked_directory_inside_the_repo_but_not_one_leaving_it() {
    let d = repo();
    let r = d.path();
    fs::write(r.join(".gitignore"), "node_modules/\n").unwrap();
    fs::create_dir_all(r.join("node_modules/.store/pkg")).unwrap();
    fs::write(r.join("node_modules/.store/pkg/index.js"), "1").unwrap();
    std::os::unix::fs::symlink(r.join("node_modules/.store/pkg"), r.join("node_modules/pkg")).unwrap();
    let out = d.path().parent().unwrap().join("outside");
    fs::create_dir_all(&out).unwrap();
    std::os::unix::fs::symlink(&out, r.join("node_modules/escape")).unwrap();

    // a symlinked package is a directory, so pnpm-style trees stay browsable
    let top = list_dir_impl(r, "node_modules").unwrap();
    assert!(top.contains(&"node_modules/pkg/".to_string()), "{top:?}");
    assert_eq!(list_dir_impl(r, "node_modules/pkg").unwrap(), vec!["node_modules/pkg/index.js"]);
    assert!(matches!(list_dir_impl(r, "node_modules/escape"), Err(AppError::InvalidPath(_))));
}

#[test]
fn list_dir_refuses_a_file_and_anything_outside_the_repo() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "1").unwrap();
    assert!(matches!(list_dir_impl(r, "a.txt"), Err(AppError::InvalidPath(_))));
    assert!(matches!(list_dir_impl(r, "../.."), Err(AppError::InvalidPath(_))));
    assert!(matches!(list_dir_impl(r, "/etc"), Err(AppError::InvalidPath(_))));
    assert!(matches!(list_dir_impl(r, ".git"), Err(AppError::InvalidPath(_))));
    assert!(matches!(list_dir_impl(r, ".git/refs"), Err(AppError::InvalidPath(_))));
    assert!(matches!(list_dir_impl(r, "nope"), Err(AppError::InvalidPath(_))));
    assert!(list_dir_impl(r, "").is_err());
}

/// Every way a symlink can reach somewhere `resolve()` refuses for a file.
#[test]
fn list_dir_refuses_a_symlink_reaching_git_a_file_or_nothing() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "1").unwrap();
    let link = |target: &Path, name: &str| std::os::unix::fs::symlink(target, r.join(name)).unwrap();
    link(&r.join(".git"), "to_git");
    link(&r.join(".git/refs"), "to_git_refs");
    link(&r.join("a.txt"), "to_file");
    link(&r.join("does_not_exist"), "dangling");
    link(Path::new("/etc"), "to_etc");
    link(r.parent().unwrap(), "to_parent");

    for name in ["to_git", "to_git_refs", "to_etc", "to_parent"] {
        assert!(matches!(list_dir_impl(r, name), Err(AppError::InvalidPath(_))), "{name} was not refused");
    }
    // exists but is not a directory, which is the Special the file view already renders
    assert!(matches!(list_dir_impl(r, "to_file"), Err(AppError::Special)));
    assert!(list_dir_impl(r, "dangling").is_err());
    // a traversal that only becomes an escape after a symlink hop is caught too
    assert!(list_dir_impl(r, "to_parent/..").is_err());
}

/// The listing may not offer a row that expanding it would refuse: what `entry_suffix` marks
/// expandable has to be exactly what `resolve_dir` accepts.
#[test]
fn list_dir_never_offers_a_row_that_cannot_be_opened() {
    let d = repo();
    let r = d.path();
    fs::write(r.join(".gitignore"), "vendor/\n").unwrap();
    fs::create_dir_all(r.join("vendor/real")).unwrap();
    let out = d.path().parent().unwrap().join("outside-target");
    fs::create_dir_all(&out).unwrap();
    std::os::unix::fs::symlink(&out, r.join("vendor/escape")).unwrap();
    std::os::unix::fs::symlink(r.join(".git"), r.join("vendor/gitlink")).unwrap();
    std::os::unix::fs::symlink(r.join("vendor/gone"), r.join("vendor/dangling")).unwrap();

    let listed = list_dir_impl(r, "vendor").unwrap();
    // a link out of the repo is shown, because it is there, but never as something to expand
    assert!(listed.contains(&"vendor/escape".to_string()), "{listed:?}");
    assert!(matches!(list_dir_impl(r, "vendor/escape"), Err(AppError::InvalidPath(_))));
    // a link into .git is dropped, exactly as a literal .git entry is
    assert!(!listed.iter().any(|p| p.contains("gitlink")), "{listed:?}");
    assert!(listed.contains(&"vendor/dangling".to_string()), "{listed:?}");
    assert!(listed.contains(&"vendor/real/".to_string()), "{listed:?}");

    // every entry the listing marks expandable opens, and no other entry does
    for p in &listed {
        let opens = list_dir_impl(r, p.trim_end_matches('/')).is_ok();
        assert_eq!(opens, p.ends_with('/'), "{p} expandable={} but opens={opens}", p.ends_with('/'));
    }
}

/// A nested repository's .git is skipped, so the tree never offers a row `resolve()` will refuse.
#[test]
fn list_dir_skips_a_nested_git_directory() {
    let d = repo();
    let r = d.path();
    fs::write(r.join(".gitignore"), "vendor/\n").unwrap();
    fs::create_dir_all(r.join("vendor/inner/.git")).unwrap();
    fs::write(r.join("vendor/inner/f.txt"), "1").unwrap();

    assert_eq!(list_dir_impl(r, "vendor/inner").unwrap(), vec!["vendor/inner/f.txt"]);
}

#[test]
fn list_files_lists_a_conflicted_path_once() {
    let d = conflicted_repo();
    let files = list_files_impl(d.path()).unwrap().files;
    assert_eq!(files.iter().filter(|f| *f == "a.txt").count(), 1, "{files:?}");
}

#[test]
fn stage_content_respects_core_filemode_false() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("s.sh"), "#!/bin/sh\necho 1\n").unwrap();
    fs::set_permissions(r.join("s.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    sh(r, &["add", "s.sh"]);
    sh(r, &["commit", "-qm", "add script"]);
    sh(r, &["config", "core.fileMode", "false"]);
    fs::set_permissions(r.join("s.sh"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(r.join("s.sh"), "#!/bin/sh\necho 2\n").unwrap();
    let oid = index_oid(r, "s.sh");
    stage_content_impl(r, "s.sh", Some("#!/bin/sh\necho 2\n"), Eol::Lf, oid.as_deref()).unwrap();
    assert!(sh(r, &["ls-files", "-s", "--", "s.sh"]).starts_with("100755"));
}

#[test]
fn stage_content_stages_chmod_minus_x() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("s.sh"), "#!/bin/sh\necho 1\n").unwrap();
    fs::set_permissions(r.join("s.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    sh(r, &["add", "s.sh"]);
    sh(r, &["commit", "-qm", "add script"]);
    fs::set_permissions(r.join("s.sh"), fs::Permissions::from_mode(0o644)).unwrap();
    let oid = index_oid(r, "s.sh");
    stage_content_impl(r, "s.sh", Some("#!/bin/sh\necho 1\n"), Eol::Lf, oid.as_deref()).unwrap();
    assert!(sh(r, &["ls-files", "-s", "--", "s.sh"]).starts_with("100644"));
}

#[test]
fn stage_content_absent_file_takes_head_mode() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("s.sh"), "#!/bin/sh\necho 1\n").unwrap();
    fs::set_permissions(r.join("s.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    sh(r, &["add", "s.sh"]);
    sh(r, &["commit", "-qm", "add script"]);
    fs::remove_file(r.join("s.sh")).unwrap();
    sh(r, &["rm", "--cached", "-q", "s.sh"]);
    stage_content_impl(r, "s.sh", Some("#!/bin/sh\necho 1\n"), Eol::Lf, None).unwrap();
    assert!(sh(r, &["ls-files", "-s", "--", "s.sh"]).starts_with("100755"));
}

#[test]
fn head_entry_matches_bracket_names_literally() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("b[1].txt"), "x\n").unwrap();
    sh(r, &["add", "b[1].txt"]);
    sh(r, &["commit", "-qm", "bracket"]);
    let (mode, _) = head_entry(r, "b[1].txt").unwrap().unwrap();
    assert_eq!(mode, "100644");
}

#[test]
fn path_commands_are_literal_and_revert_restores_the_index() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a1.txt"), "1\n").unwrap();
    fs::write(r.join("a[1].txt"), "b\n").unwrap();
    stage_path_impl(r, "a[1].txt").unwrap();
    assert_eq!(sh(r, &["diff", "--cached", "--name-only"]).trim(), "a[1].txt");
    unstage_path_impl(r, "a[1].txt").unwrap();
    assert_eq!(sh(r, &["diff", "--cached", "--name-only"]).trim(), "");

    fs::write(r.join("a.txt"), "A\nb\nc\nD\n").unwrap();
    stage_content_impl(r, "a.txt", Some("A\nb\nc\nd\n"), Eol::Lf, index_oid(r, "a.txt").as_deref()).unwrap();
    revert_path_impl(r, "a.txt").unwrap();
    assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "A\nb\nc\nd\n");
    assert!(sh(r, &["status", "--porcelain=v2"]).contains("1 M. "));
}

#[test]
fn revert_path_restores_deleted_executable_in_deleted_directory_and_removes_untracked() {
    let d = repo();
    let r = d.path();
    fs::create_dir(r.join("bin")).unwrap();
    fs::write(r.join("bin/t.sh"), "#!/bin/sh\n").unwrap();
    fs::set_permissions(r.join("bin/t.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    sh(r, &["add", "bin"]);
    sh(r, &["commit", "-qm", "bin"]);
    fs::remove_dir_all(r.join("bin")).unwrap();
    revert_path_impl(r, "bin/t.sh").unwrap();
    assert_eq!(fs::metadata(r.join("bin/t.sh")).unwrap().permissions().mode() & 0o777, 0o755);

    fs::write(r.join("u.txt"), "u\n").unwrap();
    revert_path_impl(r, "u.txt").unwrap();
    assert!(!r.join("u.txt").exists());

    sh(r, &["rm", "-q", "a.txt"]);
    fs::write(r.join("a.txt"), "again\n").unwrap();
    revert_path_impl(r, "a.txt").unwrap();
    assert!(!r.join("a.txt").exists());
    assert!(sh(r, &["status", "--porcelain=v2"]).contains("1 D. "));
}

#[test]
fn discard_all_previews_then_removes_and_restores_on_an_unborn_branch() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "changed\n").unwrap();
    fs::create_dir(r.join("dir with space")).unwrap();
    fs::write(r.join("dir with space/ü.txt"), "x\n").unwrap();
    fs::write(r.join(".gitignore"), "ignored.log\n").unwrap();
    fs::write(r.join("ignored.log"), "x\n").unwrap();
    let preview = discard_preview_impl(r).unwrap();
    assert!(preview.iter().any(|p| p == "dir with space/"), "{preview:?}");
    assert!(!preview.iter().any(|p| p.contains("ignored")));
    discard_all_impl(r).unwrap();
    assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "a\nb\nc\nd\n");
    assert!(!r.join("dir with space").exists());
    assert!(r.join("ignored.log").exists());

    let u = tempfile::tempdir().unwrap();
    sh(u.path(), &["init", "-q"]);
    fs::write(u.path().join("s.txt"), "staged\n").unwrap();
    sh(u.path(), &["add", "s.txt"]);
    fs::write(u.path().join("s.txt"), "edited\n").unwrap();
    fs::write(u.path().join("n.txt"), "n\n").unwrap();
    discard_all_impl(u.path()).unwrap();
    assert_eq!(fs::read_to_string(u.path().join("s.txt")).unwrap(), "staged\n", "an unborn branch still has an index to restore from");
    assert!(!u.path().join("n.txt").exists());

    let empty = tempfile::tempdir().unwrap();
    sh(empty.path(), &["init", "-q"]);
    fs::write(empty.path().join("n.txt"), "n\n").unwrap();
    discard_all_impl(empty.path()).unwrap();
    assert!(!empty.path().join("n.txt").exists());
}

#[test]
fn root_is_not_a_repo_once_the_directory_is_gone() {
    let d = repo();
    let state = AppState::new();
    *state.repo.lock().unwrap() = Some(discover(d.path()).unwrap());
    assert!(state.root().is_ok());
    fs::remove_dir_all(d.path()).unwrap();
    assert_eq!(state.root().unwrap_err(), AppError::NotARepo);
}

#[test]
fn stage_all_and_unstage_all() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "x\n").unwrap();
    fs::write(r.join("n.txt"), "n\n").unwrap();
    stage_all_impl(r).unwrap();
    assert_eq!(sh(r, &["diff", "--cached", "--name-only"]).lines().count(), 2);
    unstage_all_impl(r).unwrap();
    assert_eq!(sh(r, &["diff", "--cached", "--name-only"]).trim(), "");
}

#[test]
fn commit_keeps_multiline_message() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "x\n").unwrap();
    sh(r, &["add", "a.txt"]);
    commit_impl(r, "subject\n\nbody line 1\nbody line 2\n").unwrap();
    assert_eq!(sh(r, &["log", "-1", "--format=%B"]).trim(), "subject\n\nbody line 1\nbody line 2");
}

#[test]
fn branches_split_remotes_and_drop_head_symref() {
    let d = repo();
    let r = d.path();
    let origin = tempfile::tempdir().unwrap();
    sh(origin.path(), &["init", "-q", "--bare"]);
    sh(r, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    sh(r, &["remote", "add", "a/b", origin.path().to_str().unwrap()]);
    sh(r, &["push", "-q", "origin", "main"]);
    sh(r, &["push", "-q", "origin", "main:feature/x"]);
    sh(r, &["fetch", "-q", "a/b"]);
    sh(r, &["remote", "set-head", "origin", "main"]);
    let bs = branches_impl(r).unwrap();
    assert!(bs.contains(&Branch::Local { name: "main".into() }));
    assert!(bs.contains(&Branch::Remote { remote: "origin".into(), branch: "feature/x".into() }));
    assert!(bs.contains(&Branch::Remote { remote: "a/b".into(), branch: "main".into() }));
    assert!(!bs.iter().any(|b| matches!(b, Branch::Remote { branch, .. } if branch == "HEAD")));
    assert!(!bs.iter().any(|b| matches!(b, Branch::Local { name } if name == "origin")));
}

#[test]
fn switch_remote_creates_tracking_branch_once_then_switches() {
    let d = repo();
    let r = d.path();
    let origin = tempfile::tempdir().unwrap();
    sh(origin.path(), &["init", "-q", "--bare"]);
    sh(r, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    sh(r, &["push", "-q", "origin", "main:feat"]);
    sh(r, &["fetch", "-q"]);
    let remote = Branch::Remote { remote: "origin".into(), branch: "feat".into() };
    switch_branch_impl(r, &remote).unwrap();
    assert_eq!(sh(r, &["branch", "--show-current"]).trim(), "feat");
    switch_branch_impl(r, &Branch::Local { name: "main".into() }).unwrap();
    switch_branch_impl(r, &remote).unwrap();
    assert_eq!(sh(r, &["branch", "--show-current"]).trim(), "feat");
}

#[test]
fn switch_branch_rejects_option_shaped_names() {
    let d = repo();
    let r = d.path();
    let head_oid = sh(r, &["rev-parse", "main"]).trim().to_string();
    assert!(switch_branch_impl(r, &Branch::Local { name: "--force-create=main".into() }).is_err());
    assert!(switch_branch_impl(r, &Branch::Local { name: "-c".into() }).is_err());
    assert_eq!(sh(r, &["rev-parse", "main"]).trim(), head_oid);
    assert_eq!(sh(r, &["branch", "--show-current"]).trim(), "main");
    assert!(switch_branch_impl(r, &Branch::Remote { remote: "-x".into(), branch: "y".into() }).is_err());
    assert!(sh(r, &["branch", "--list", "y"]).trim().is_empty());
}

#[test]
fn create_branch_forks_head_keeps_the_worktree_and_rejects_bad_names() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "edited\n").unwrap();
    create_branch_impl(r, "feat/x").unwrap();
    assert_eq!(sh(r, &["branch", "--show-current"]).trim(), "feat/x");
    assert_eq!(sh(r, &["rev-parse", "feat/x"]).trim(), sh(r, &["rev-parse", "main"]).trim());
    assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "edited\n");
    assert!(create_branch_impl(r, "--orphan=boom").is_err());
    assert!(create_branch_impl(r, "feat/x").is_err());
    assert!(sh(r, &["branch", "--list", "boom"]).trim().is_empty());
    assert_eq!(sh(r, &["branch", "--show-current"]).trim(), "feat/x");
}

/// `main` tracks `origin/main`; the bare repo is returned so it outlives the work tree.
fn repo_with_remote() -> (TempDir, TempDir) {
    let bare = tempfile::tempdir().unwrap();
    sh(bare.path(), &["init", "-q", "--bare", "."]);
    let d = repo();
    sh(d.path(), &["remote", "add", "origin", bare.path().to_str().unwrap()]);
    sh(d.path(), &["push", "-q", "-u", "origin", "main"]);
    (d, bare)
}

#[test]
fn push_names_the_remote_when_the_branch_tracks_a_local_one() {
    let (d, _bare) = repo_with_remote();
    let r = d.path();
    sh(r, &["config", "branch.autoSetupMerge", "always"]);
    sh(r, &["switch", "-q", "-c", "feat"]);
    // the shape that made a bare push a silent no-op: the upstream is this repository
    assert_eq!(sh(r, &["config", "--get", "branch.feat.remote"]).trim(), ".");
    assert_eq!(push_args(r).unwrap(), vec!["push", "--set-upstream", "origin", "feat"]);
}

#[test]
fn push_stays_bare_when_the_branch_already_tracks_a_remote() {
    let (d, _bare) = repo_with_remote();
    assert_eq!(sh(d.path(), &["config", "--get", "branch.main.remote"]).trim(), "origin");
    assert_eq!(push_args(d.path()).unwrap(), vec!["push"]);
}

#[test]
fn push_refuses_a_repository_with_no_remote() {
    let d = repo();
    assert!(push_args(d.path()).is_err());
}

#[test]
fn stash_round_trips_partial_stage_and_untracked() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("a.txt"), "A\nb\nc\nD\n").unwrap();
    stage_content_impl(r, "a.txt", Some("A\nb\nc\nd\n"), Eol::Lf, index_oid(r, "a.txt").as_deref()).unwrap();
    fs::write(r.join("u.txt"), "u\n").unwrap();
    stash_push_impl(r).unwrap();
    assert!(!r.join("u.txt").exists());
    stash_pop_impl(r).unwrap();
    assert!(sh(r, &["status", "--porcelain=v2"]).contains("1 MM "));
    assert!(r.join("u.txt").exists());
}

#[test]
fn list_files_dedupes_conflicts_and_keeps_deleted_for_ui_filtering() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("u.txt"), "u\n").unwrap();
    fs::remove_file(r.join("a.txt")).unwrap();
    let files = list_files_impl(r).unwrap().files;
    assert!(files.contains(&"u.txt".to_string()));
    assert_eq!(files.iter().filter(|f| *f == "a.txt").count(), 1);
}

#[test]
fn list_files_collapses_an_ignored_directory_and_keeps_it_out_of_files() {
    let d = repo();
    let r = d.path();
    fs::write(r.join(".gitignore"), "node_modules/\nsecret.env\n").unwrap();
    fs::create_dir(r.join("node_modules")).unwrap();
    fs::write(r.join("node_modules/a.js"), "a\n").unwrap();
    fs::write(r.join("node_modules/b.js"), "b\n").unwrap();
    fs::write(r.join("secret.env"), "k=v\n").unwrap();

    let listing = list_files_impl(r).unwrap();

    assert_eq!(listing.ignored, vec!["node_modules/".to_string(), "secret.env".to_string()]);
    assert!(!listing.files.iter().any(|f| f.starts_with("node_modules")), "{:?}", listing.files);
    assert!(listing.files.contains(&".gitignore".to_string()));
}

#[test]
fn push_to_bare_remote_and_pull_are_plain_git() {
    let d = repo();
    let r = d.path();
    let origin = tempfile::tempdir().unwrap();
    sh(origin.path(), &["init", "-q", "--bare"]);
    sh(r, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    sh(r, &["push", "-q", "-u", "origin", "main"]);
    fs::write(r.join("a.txt"), "x\n").unwrap();
    sh(r, &["commit", "-qam", "x"]);
    let state = AppState::new();
    *state.repo.lock().unwrap() = Some(discover(r).unwrap());
    run_net(&state, &["push"]).unwrap();
    assert_eq!(sh(r, &["rev-list", "--count", "origin/main..main"]).trim(), "0");
    run_net(&state, &["pull"]).unwrap();
}

#[test]
fn cancel_kills_a_running_network_command() {
    let d = repo();
    let r = d.path();
    sh(r, &["remote", "add", "slow", "ext::sleep 30"]);
    sh(r, &["config", "protocol.ext.allow", "always"]);
    let state = std::sync::Arc::new(AppState::new());
    *state.repo.lock().unwrap() = Some(discover(r).unwrap());
    let s2 = state.clone();
    let t = std::thread::spawn(move || run_net(s2.as_ref(), &["fetch", "slow"]));
    std::thread::sleep(std::time::Duration::from_millis(400));
    cancel_impl(state.as_ref());
    let res = t.join().unwrap();
    assert_eq!(res.unwrap_err(), AppError::Cancelled);
}

#[test]
fn run_net_recovers_a_poisoned_net_lock() {
    let d = repo();
    let r = d.path();
    let origin = tempfile::tempdir().unwrap();
    sh(origin.path(), &["init", "-q", "--bare"]);
    sh(r, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    sh(r, &["push", "-q", "-u", "origin", "main"]);
    let state = std::sync::Arc::new(AppState::new());
    *state.repo.lock().unwrap() = Some(discover(r).unwrap());
    let s2 = state.clone();
    let t = std::thread::spawn(move || {
        let _g = s2.net_lock.lock().unwrap();
        panic!("poison net_lock");
    });
    let _ = t.join();
    run_net(&state, &["push"]).unwrap();
}

#[test]
fn run_net_refuses_a_second_concurrent_network_command() {
    let d = repo();
    let r = d.path();
    sh(r, &["remote", "add", "slow", "ext::sleep 30"]);
    sh(r, &["config", "protocol.ext.allow", "always"]);
    let state = std::sync::Arc::new(AppState::new());
    *state.repo.lock().unwrap() = Some(discover(r).unwrap());
    let s2 = state.clone();
    let t = std::thread::spawn(move || run_net(s2.as_ref(), &["fetch", "slow"]));
    std::thread::sleep(std::time::Duration::from_millis(300));
    let start = std::time::Instant::now();
    let err = run_net(state.as_ref(), &["fetch", "slow"]).unwrap_err();
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    assert!(matches!(err, AppError::Git(ref s) if s.contains("already running")));
    cancel_impl(state.as_ref());
    let res = t.join().unwrap();
    assert_eq!(res.unwrap_err(), AppError::Cancelled);
}

#[test]
fn ai_commit_message_needs_staged_changes() {
    let d = repo();
    assert!(matches!(codebaer_lib::ai::commit_message_impl(d.path()), Err(AppError::Ai(_))));
}

#[test]
fn blame_attributes_one_line_and_marks_uncommitted_ones() {
    let d = repo();
    let r = d.path();
    let committed = "a\nb\nc\nd\n";
    let b = blame_impl(r, "a.txt", 2, committed, Eol::Lf).unwrap();
    assert_eq!(b.oid.len(), 40);
    assert_eq!(b.author, "t");
    assert_eq!(b.summary, "init");
    assert!(b.time > 0);
    // a dirty buffer is piped in, so the inserted line falls outside HEAD and the
    // line below it keeps its commit despite having moved
    let edited = "a\nnew\nb\nc\nd\n";
    assert_eq!(blame_impl(r, "a.txt", 2, edited, Eol::Lf).unwrap().oid, "0".repeat(40));
    assert_eq!(blame_impl(r, "a.txt", 3, edited, Eol::Lf).unwrap().summary, "init");
    // nothing to blame on a path that never reached HEAD, nor past the end of the buffer
    fs::write(r.join("u.txt"), "x\n").unwrap();
    assert!(matches!(blame_impl(r, "u.txt", 1, "x\n", Eol::Lf), Err(AppError::Git(_))));
    assert!(matches!(blame_impl(r, "a.txt", 99, committed, Eol::Lf), Err(AppError::Git(_))));
}

/// The editor's document is always LF, so a CRLF file reaches git re-encoded or every one of its
/// committed lines comes back as the zero oid.
#[test]
fn blame_re_encodes_the_buffer_to_the_files_line_endings() {
    let d = repo();
    let r = d.path();
    fs::write(r.join("w.txt"), "a\r\nb\r\n").unwrap();
    sh(r, &["add", "w.txt"]);
    sh(r, &["commit", "-qm", "crlf"]);
    let doc = "a\nb\n";
    assert_eq!(blame_impl(r, "w.txt", 2, doc, Eol::Crlf).unwrap().summary, "crlf");
    assert_eq!(blame_impl(r, "w.txt", 2, doc, Eol::Lf).unwrap().oid, "0".repeat(40));
}
