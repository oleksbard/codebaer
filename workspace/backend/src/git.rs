use crate::eol;
use crate::eol::Eol;
use crate::error::AppError;
use crate::status::{self, Status};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

pub const LOCAL: Duration = Duration::from_secs(30);
pub const COMMIT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileText {
    pub text: String,
    pub eol: Eol,
    pub exists: bool,
}

#[derive(Debug)]
pub struct Out {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

pub fn kill_group(pid: u32) {
    signal_group(pid, libc::SIGKILL);
}

fn signal_group(pid: u32, signal: libc::c_int) {
    // pid 0 means "this process's own group" and 1 is init/launchd: never valid
    // targets here, and passing either through to libc::kill would take out the
    // app itself (0) or every process on the machine the caller can signal (1).
    if pid <= 1 {
        return;
    }
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

/// Clears the shared pid slot on every exit path (normal return, early `?`,
/// or panic). On the timeout path the slot is cleared before the child is
/// reaped; otherwise it is cleared immediately after `try_wait` observes
/// exit. A cancel landing in the few instructions between that observation
/// and the clear can still race a pid reused by an unrelated process.
struct PidGuard<'a> {
    slot: Option<&'a Mutex<Option<u32>>>,
}

impl<'a> PidGuard<'a> {
    fn new(slot: Option<&'a Mutex<Option<u32>>>, pid: u32) -> Self {
        if let Some(s) = slot {
            *s.lock().unwrap_or_else(|e| e.into_inner()) = Some(pid);
        }
        PidGuard { slot }
    }

    fn clear(&self) {
        if let Some(s) = self.slot {
            *s.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
}

impl<'a> Drop for PidGuard<'a> {
    fn drop(&mut self) {
        self.clear();
    }
}

fn spawn_reader<R: Read + Send + 'static>(mut pipe: R) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

/// The reader thread only exits once its pipe's write end is closed by every
/// holder. A backgrounding hook (e.g. core.fsmonitor) can inherit that fd and
/// outlive the git child, so joining the thread could block forever; instead
/// we drain whatever already arrived and give up after 200ms of silence.
fn drain(rx: mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
        out.extend_from_slice(&chunk);
    }
    out
}

fn git_command(root: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GIT_SSH_COMMAND");
    cmd
}

pub fn run_raw(
    root: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Option<Duration>,
    pid_slot: Option<&Mutex<Option<u32>>>,
) -> Result<Out, AppError> {
    run_child(git_command(root, args), stdin, timeout, pid_slot)
}

/// Runs the command in its own process group so a timeout kills its children too.
pub fn run_child(
    mut cmd: Command,
    stdin: Option<&[u8]>,
    timeout: Option<Duration>,
    pid_slot: Option<&Mutex<Option<u32>>>,
) -> Result<Out, AppError> {
    let start = Instant::now();
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn()?;
    let guard = PidGuard::new(pid_slot, child.id());
    if let Some(data) = stdin {
        let mut si = child.stdin.take().unwrap();
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = si.write_all(&data);
        });
    }
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let out_rx = spawn_reader(so);
    let err_rx = spawn_reader(se);
    let status = loop {
        if let Some(st) = child.try_wait()? {
            guard.clear();
            break st;
        }
        if let Some(t) = timeout {
            if start.elapsed() > t {
                kill_group(child.id());
                guard.clear();
                let _ = child.wait();
                return Err(AppError::Timeout);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = drain(out_rx);
    let stderr = String::from_utf8_lossy(&drain(err_rx)).trim().to_string();
    let code = status.code().unwrap_or(-1);
    log::debug!("{:?} {:?} -> {} in {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>(), code, start.elapsed());
    Ok(Out { code, stdout, stderr })
}

pub fn run(root: &Path, args: &[&str], stdin: Option<&[u8]>, timeout: Option<Duration>) -> Result<Out, AppError> {
    let out = run_raw(root, args, stdin, timeout, None)?;
    if out.code != 0 {
        return Err(AppError::Git(out.stderr));
    }
    Ok(out)
}

pub fn run_locked(root: &Path, args: &[&str], stdin: Option<&[u8]>, timeout: Option<Duration>) -> Result<Out, AppError> {
    let mut attempt = 0;
    loop {
        match run(root, args, stdin, timeout) {
            Err(AppError::Git(ref s)) if s.contains("index.lock") && attempt < 3 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
            other => return other,
        }
    }
}

fn has_git_component(rel_to_root: &Path) -> bool {
    rel_to_root
        .components()
        .any(|c| matches!(c, Component::Normal(s) if s.to_string_lossy().eq_ignore_ascii_case(".git")))
}

pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let bad = |m: &str| Err(AppError::InvalidPath(format!("{m}: {rel:?}")));
    if rel.is_empty() || rel == "." || rel.ends_with('/') {
        return bad("empty or directory path");
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return bad("absolute path");
    }
    for c in p.components() {
        match c {
            Component::Normal(s) if s.to_string_lossy().eq_ignore_ascii_case(".git") => return bad(".git component"),
            Component::Normal(_) => {}
            _ => return bad("relative component"),
        }
    }
    let root_c = root.canonicalize()?;
    let full = root_c.join(p);

    // symlink_metadata (not exists()) so a dangling symlink ancestor counts as
    // "found" instead of being climbed past; its target is validated below.
    let mut anc = full.parent().unwrap().to_path_buf();
    while std::fs::symlink_metadata(&anc).is_err() {
        anc = match anc.parent() {
            Some(a) => a.to_path_buf(),
            None => return bad("no existing ancestor"),
        };
    }
    let anc_c = match anc.canonicalize() {
        Ok(c) => c,
        Err(_) => return bad("broken ancestor"),
    };
    let anc_rel = match anc_c.strip_prefix(&root_c) {
        Ok(r) => r,
        Err(_) => return bad("outside repository"),
    };
    if has_git_component(anc_rel) {
        return bad(".git component");
    }

    if let Ok(md) = std::fs::symlink_metadata(&full) {
        if !md.is_file() {
            // The literal path never named a .git component, and the ancestor
            // chain didn't resolve into one either - but the final component
            // itself can still be a symlink pointing straight at .git (its
            // own parent never gets canonicalized above). Catch that redirect
            // before falling back to the ordinary "not a regular file" case.
            if let Ok(full_c) = full.canonicalize() {
                if let Ok(full_rel) = full_c.strip_prefix(&root_c) {
                    if has_git_component(full_rel) {
                        return bad(".git component");
                    }
                }
            }
            return Err(AppError::Special);
        }
    }
    Ok(full)
}

/// The directory counterpart of `resolve`: the same guards, but a directory is the thing being
/// asked for rather than the `Special` refusal `resolve` ends on.
pub fn resolve_dir(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let bad = |m: &str| -> Result<PathBuf, AppError> { Err(AppError::InvalidPath(format!("{m}: {rel:?}"))) };
    match resolve(root, rel) {
        Err(AppError::Special) => {}
        Err(e) => return Err(e),
        Ok(_) => return bad("not a directory"),
    }
    // resolve() stops short of canonicalizing the final component, so the check it cannot make
    // is made here: a symlinked directory inside the repo is browsable, one leaving it is not
    let root_c = root.canonicalize()?;
    let full = root_c.join(rel).canonicalize()?;
    let Ok(inside) = full.strip_prefix(&root_c) else { return bad("outside repository") };
    if has_git_component(inside) {
        return bad(".git component");
    }
    if full.is_dir() {
        Ok(full)
    } else {
        Err(AppError::Special)
    }
}

#[derive(Debug)]
pub struct Repo {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
}

pub struct AppState {
    pub repo: Mutex<Option<Repo>>,
    pub write_lock: Mutex<()>,
    pub net_pid: Mutex<Option<u32>>,
    pub net_lock: Mutex<()>,
    pub cancelled: AtomicBool,
    /// Set while `net_lock` is held by a background fetch, which a push, pull or fetch may stop.
    pub net_background: AtomicBool,
    /// The background fetch's git, kept apart from `net_pid` so stopping it can never signal the user's own.
    pub background_pid: Mutex<Option<u32>>,
    /// Set while a push, pull or fetch waits for a background fetch to let go: no new one starts meanwhile, and
    /// a Cancel counts even with no git running.
    pub net_waiting: AtomicBool,
    pub watcher: Mutex<Option<crate::watcher::Handle>>,
}

impl AppState {
    // Tauri builds this once in setup; a Default impl would have no caller.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        AppState {
            repo: Mutex::new(None),
            write_lock: Mutex::new(()),
            net_pid: Mutex::new(None),
            net_lock: Mutex::new(()),
            cancelled: AtomicBool::new(false),
            net_background: AtomicBool::new(false),
            background_pid: Mutex::new(None),
            net_waiting: AtomicBool::new(false),
            watcher: Mutex::new(None),
        }
    }

    pub fn root(&self) -> Result<PathBuf, AppError> {
        let root = self
            .repo
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|r| r.root.clone())
            .ok_or(AppError::NotARepo)?;
        // A deleted repo would otherwise fail every command in `spawn` with a
        // bare io error; NotARepo is what sends the UI back to the picker (§9.3).
        if !root.is_dir() {
            return Err(AppError::NotARepo);
        }
        Ok(root)
    }
}

pub fn discover(path: &Path) -> Result<Repo, AppError> {
    let out = run(path, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], None, Some(LOCAL))
        .map_err(|_| AppError::NotARepo)?;
    let s = String::from_utf8_lossy(&out.stdout);
    let mut lines = s.lines().map(PathBuf::from);
    let root = lines.next().ok_or(AppError::NotARepo)?;
    let git_dir = lines.next().ok_or(AppError::NotARepo)?;
    let common_dir = lines.next().ok_or(AppError::NotARepo)?;
    Ok(Repo { root: root.canonicalize().map_err(|_| AppError::NotARepo)?, git_dir, common_dir })
}

pub fn status_impl(root: &Path) -> Result<Status, AppError> {
    let out = run_locked(root, &["status", "--porcelain=v2", "--branch", "--show-stash", "-uall", "-z"], None, Some(LOCAL))?;
    Ok(status::parse(&out.stdout))
}

#[derive(Debug, Serialize)]
pub struct Opened {
    /// Canonical, so it compares equal to the folders the kernel reports for the terminals.
    pub root: String,
    /// Display only, `~`-shortened.
    pub label: String,
    pub title: Option<String>,
}

impl Opened {
    fn of(root: &Path) -> Self {
        let path = root.to_string_lossy().to_string();
        Self { label: crate::recents::label(&path), root: path, title: repo_title(root) }
    }
}

/// Enough of a file to reach a README's first heading or to hold a whole package.json.
const TITLE_BYTES: u64 = 64 * 1024;

fn head_of(path: &Path, cap: u64) -> Option<String> {
    let mut buf = Vec::new();
    std::fs::File::open(path).ok()?.take(cap).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn readme(root: &Path) -> Option<String> {
    let readme = std::fs::read_dir(root).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("readme.md"))
    })?;
    head_of(&readme, TITLE_BYTES)
}

fn readme_title(root: &Path) -> Option<String> {
    readme(root)?
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn package_field(root: &Path, field: &str) -> Option<String> {
    let text = head_of(&root.join("package.json"), TITLE_BYTES)?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let value = json.get(field)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// A human name for the repo, for the header. The remote's basename is deliberately not consulted:
/// it is the folder name in everything but `git clone <url> <other-dir>`, and it costs a subprocess.
pub(crate) fn repo_title(root: &Path) -> Option<String> {
    readme_title(root).or_else(|| package_field(root, "name"))
}

/// Enough of a description to tell what a project is.
const ABOUT_CHARS: usize = 300;

/// The first paragraph of prose, past the headings, badges, pictures, HTML, tables and code.
fn readme_summary(text: &str) -> Option<String> {
    let skip = |l: &str| l.is_empty() || ["#", "<", "![", "[![", "|", "---", "==="].iter().any(|p| l.starts_with(p));
    let mut para: Vec<&str> = Vec::new();
    let mut fenced = false;
    for l in text.lines().map(str::trim) {
        let fence = l.starts_with("```") || l.starts_with("~~~");
        fenced ^= fence;
        if fence || fenced || skip(l) {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        para.push(l);
    }
    (!para.is_empty()).then(|| para.join(" "))
}

/// A crate's own `description = "..."`, read line by line: pulling in a TOML parser for one field is not worth it.
fn cargo_description(root: &Path) -> Option<String> {
    let text = head_of(&root.join("Cargo.toml"), TITLE_BYTES)?;
    let mut section = "";
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
        } else if matches!(section, "[package]" | "[workspace.package]") {
            let Some(value) = line.strip_prefix("description").map(str::trim_start).and_then(|l| l.strip_prefix('=')) else {
                continue;
            };
            let value = value.trim();
            let value = if let Some(literal) = value.strip_prefix('\'') {
                literal.split_once('\'')?.0
            } else {
                let value = value.strip_prefix('"')?;
                let mut escaped = false;
                let (end, _) = value.char_indices().find(|&(_, c)| {
                    let closes = c == '"' && !escaped;
                    escaped = c == '\\' && !escaped;
                    closes
                })?;
                &value[..end]
            };
            let value = value.trim();
            return (!value.is_empty()).then(|| value.to_string());
        }
    }
    None
}

/// What the repo is, in its own words, for the AI that picks its icon.
pub(crate) fn repo_about(root: &Path) -> Option<String> {
    let about = readme(root)
        .and_then(|t| readme_summary(&t))
        .or_else(|| package_field(root, "description"))
        .or_else(|| cargo_description(root))?;
    Some(about.chars().take(ABOUT_CHARS).collect())
}

#[tauri::command(async)]
pub fn open_repo(state: State<AppState>, app: tauri::AppHandle, path: String) -> Result<Opened, AppError> {
    let repo = discover(Path::new(&path))?;
    let emitter = app.clone();
    let handle = crate::watcher::start(&repo.root, &repo.git_dir, &repo.common_dir, move || {
        let _ = tauri::Emitter::emit(&emitter, "repo-changed", ());
    })?;
    let opened = Opened::of(&repo.root);
    // The watcher is created first, so a failure to start it leaves state
    // untouched; once it succeeds, the repo is stored before the new
    // watcher's handle becomes live.
    *state.repo.lock().unwrap_or_else(|e| e.into_inner()) = Some(repo);
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    // every way in (dialog, launch argument, second instance, File menu) lands here
    crate::recents::push(&app, &opened.root);
    crate::refresh_recent_menu(&app);
    Ok(opened)
}

/// Every repo command answers NotARepo after this, until the next `open_repo`.
#[tauri::command(async)]
pub fn close_repo(state: State<AppState>, app: tauri::AppHandle) {
    // the watcher first, so no change of the old repo is reported once it is gone
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.repo.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // the File menu's recents leave out the open repo, and there is none now
    crate::refresh_recent_menu(&app);
}

#[tauri::command(async)]
pub fn status(state: State<AppState>) -> Result<Status, AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    status_impl(&root)
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct DiffStat {
    pub added: u64,
    pub removed: u64,
}

/// Sums `diff --numstat -z --no-renames`, where every record is `added\tremoved\tpath`.
/// A binary file reports `-\t-` and counts nothing.
pub fn parse_numstat(out: &[u8]) -> DiffStat {
    let num = |c: Option<&[u8]>| c.and_then(|c| std::str::from_utf8(c).ok()?.parse::<u64>().ok());
    let mut stat = DiffStat::default();
    for rec in out.split(|&b| b == 0) {
        let mut cols = rec.splitn(3, |&b| b == b'\t');
        if let (Some(a), Some(r)) = (num(cols.next()), num(cols.next())) {
            stat.added += a;
            stat.removed += r;
        }
    }
    stat
}

/// The lines `--numstat` would count for an untracked file.
// ponytail: a file over MAX_BYTES counts as zero instead of being read on every refresh
fn untracked_lines(full: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(full) else { return 0 };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return 0;
    }
    let Ok(bytes) = std::fs::read(full) else { return 0 };
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return 0;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    newlines + u64::from(bytes.last().is_some_and(|&b| b != b'\n'))
}

/// Lines added and removed across the review queue: index to working tree, plus untracked files.
pub fn diff_stat_impl(root: &Path) -> Result<DiffStat, AppError> {
    let tracked = run(root, &["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"], None, Some(LOCAL))?;
    let mut stat = parse_numstat(&tracked.stdout);
    let others = run(root, &["ls-files", "--others", "--exclude-standard", "-z"], None, Some(LOCAL))?;
    for rel in others.stdout.split(|&b| b == 0).filter(|p| !p.is_empty()) {
        stat.added += untracked_lines(&root.join(OsStr::from_bytes(rel)));
    }
    Ok(stat)
}

#[tauri::command(async)]
pub fn diff_stat(state: State<AppState>) -> Result<DiffStat, AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    diff_stat_impl(&root)
}

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn text_from_bytes(bytes: Vec<u8>) -> Result<FileText, AppError> {
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(AppError::Binary);
    }
    let e = eol::detect(&bytes);
    let s = String::from_utf8(bytes).map_err(|_| AppError::NotUtf8)?;
    Ok(FileText { text: eol::normalize(&s), eol: e, exists: true })
}

pub fn read_file_at(full: &Path) -> Result<FileText, AppError> {
    match std::fs::symlink_metadata(full) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileText { text: String::new(), eol: Eol::Lf, exists: false })
        }
        Err(e) => return Err(e.into()),
        Ok(md) => {
            if !md.is_file() {
                return Err(AppError::Special);
            }
            if md.len() > MAX_BYTES {
                return Err(AppError::TooLarge);
            }
        }
    }
    match std::fs::read(full) {
        Ok(bytes) => text_from_bytes(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileText { text: String::new(), eol: Eol::Lf, exists: false }),
        Err(e) => Err(e.into()),
    }
}

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn write_file_impl(root: &Path, rel: &str, text: &str, e: Eol, expected: Option<&str>) -> Result<(), AppError> {
    let full = resolve(root, rel)?;
    let current = read_file_at(&full)?;
    let matches = match (expected, current.exists) {
        (None, false) => true,
        (Some(x), true) => x == current.text,
        _ => false,
    };
    if !matches {
        return Err(AppError::Stale(current));
    }
    let mode = current.exists.then(|| std::fs::metadata(&full).map(|m| m.permissions())).transpose()?;
    let dir = full.parent().unwrap();
    std::fs::create_dir_all(dir)?;
    let n = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".codebaer-{}-{n}.tmp", std::process::id()));
    let result: Result<(), AppError> = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(eol::apply(&eol::normalize(text), e).as_bytes())?;
        match mode {
            Some(p) => std::fs::set_permissions(&tmp, p)?,
            None => std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644))?,
        }
        std::fs::rename(&tmp, &full)?;
        Ok(())
    })();
    if let Err(err) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn read_file(state: State<AppState>, path: String) -> Result<FileText, AppError> {
    let root = state.root()?;
    read_file_at(&resolve(&root, &path)?)
}

#[tauri::command(async)]
pub fn write_file(state: State<AppState>, path: String, text: String, eol: Eol, expected: Option<String>) -> Result<(), AppError> {
    let root = state.root()?;
    write_file_impl(&root, &path, &text, eol, expected.as_deref())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Rev {
    Index,
    Head,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Blob {
    pub text: String,
    pub eol: Eol,
    pub oid: Option<String>,
    pub exists: bool,
}

pub fn literal(rel: &str) -> String {
    format!(":(literal){rel}")
}

pub fn is_conflicted(root: &Path, rel: &str) -> Result<bool, AppError> {
    let out = run(root, &["ls-files", "-u", "--", &literal(rel)], None, Some(LOCAL))?;
    Ok(!out.stdout.is_empty())
}

/// `ls-files -s` line: `<mode> <oid> <stage>\t<path>`
pub fn index_entry(root: &Path, rel: &str) -> Result<Option<(String, String)>, AppError> {
    let out = run(root, &["ls-files", "-s", "--", &literal(rel)], None, Some(LOCAL))?;
    let s = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() > 1 {
        return Err(AppError::Conflicted);
    }
    Ok(lines.first().and_then(|l| {
        let mut it = l.split_whitespace();
        Some((it.next()?.to_string(), it.next()?.to_string()))
    }))
}

pub fn head_exists(root: &Path) -> Result<bool, AppError> {
    Ok(run_raw(root, &["rev-parse", "-q", "--verify", "HEAD"], None, Some(LOCAL), None)?.code == 0)
}

/// `ls-tree -z` line: `<mode> <type> <oid>\t<path>`
pub fn head_entry(root: &Path, rel: &str) -> Result<Option<(String, String)>, AppError> {
    if !head_exists(root)? {
        return Ok(None);
    }
    let out = run(root, &["ls-tree", "-z", "HEAD", "--", rel], None, Some(LOCAL))?;
    let s = String::from_utf8_lossy(&out.stdout);
    Ok(s.split('\0').find_map(|l| {
        let (meta, path) = l.split_once('\t')?;
        if path != rel {
            return None;
        }
        let mut it = meta.split_whitespace();
        let mode = it.next()?.to_string();
        let _kind = it.next()?;
        Some((mode, it.next()?.to_string()))
    }))
}

pub fn read_blob_impl(root: &Path, rev: Rev, rel: &str) -> Result<Blob, AppError> {
    if is_conflicted(root, rel)? {
        return Err(AppError::Conflicted);
    }
    let entry = match rev {
        Rev::Index => index_entry(root, rel)?,
        Rev::Head => head_entry(root, rel)?,
    };
    let Some((mode, oid)) = entry else {
        return Ok(Blob { text: String::new(), eol: Eol::Lf, oid: None, exists: false });
    };
    if mode != "100644" && mode != "100755" {
        return Err(AppError::Special);
    }
    let size_s = String::from_utf8_lossy(&run(root, &["cat-file", "-s", &oid], None, Some(LOCAL))?.stdout).trim().to_string();
    let size: u64 = size_s.parse().map_err(|_| AppError::Git(format!("unparsable blob size: {size_s:?}")))?;
    if size > MAX_BYTES {
        return Err(AppError::TooLarge);
    }
    let ft = text_from_bytes(run(root, &["cat-file", "blob", &oid], None, Some(LOCAL))?.stdout)?;
    Ok(Blob { text: ft.text, eol: ft.eol, oid: Some(oid), exists: true })
}

#[tauri::command(async)]
pub fn read_blob(state: State<AppState>, rev: Rev, path: String) -> Result<Blob, AppError> {
    let root = state.root()?;
    resolve(&root, &path)?;
    read_blob_impl(&root, rev, &path)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StageResult {
    pub oid: Option<String>,
}

/// `git add` ignores the working-tree execute bit when `core.fileMode` is
/// false (exFAT, SMB, some Windows-originated checkouts), keeping whatever
/// mode the index already had; `git config --bool` prints nothing and exits
/// 1 when the key is unset, which we treat as the git default of true.
fn file_mode_tracked(root: &Path) -> Result<bool, AppError> {
    let out = run_raw(root, &["config", "--bool", "core.fileMode"], None, Some(LOCAL), None)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim() != "false")
}

fn fallback_mode(root: &Path, rel: &str, current: &Option<(String, String)>) -> Result<String, AppError> {
    Ok(current
        .as_ref()
        .map(|(m, _)| m.clone())
        .or(head_entry(root, rel)?.map(|(m, _)| m))
        .unwrap_or_else(|| "100644".to_string()))
}

pub fn stage_content_impl(root: &Path, rel: &str, text: Option<&str>, e: Eol, expected_oid: Option<&str>) -> Result<StageResult, AppError> {
    let full = resolve(root, rel)?;
    let current = index_entry(root, rel)?;
    if current.as_ref().map(|(_, o)| o.as_str()) != expected_oid {
        return Err(AppError::StaleIndex);
    }
    let Some(t) = text else {
        run_locked(root, &["update-index", "--force-remove", "--", rel], None, Some(LOCAL))?;
        return Ok(StageResult { oid: None });
    };
    if let Some((m, _)) = &current {
        if m != "100644" && m != "100755" {
            return Err(AppError::Special);
        }
    }
    let mode = if file_mode_tracked(root)? {
        match std::fs::symlink_metadata(&full) {
            Ok(md) if md.is_file() => if md.permissions().mode() & 0o100 != 0 { "100755" } else { "100644" }.to_string(),
            Ok(_) => return Err(AppError::Special),
            Err(_) => fallback_mode(root, rel, &current)?,
        }
    } else {
        fallback_mode(root, rel, &current)?
    };
    let bytes = eol::apply(&eol::normalize(t), e);
    let h = run(root, &["hash-object", "-w", "--stdin", "--path", rel], Some(bytes.as_bytes()), Some(LOCAL))?;
    let oid = String::from_utf8_lossy(&h.stdout).trim().to_string();
    let info = format!("{mode},{oid},{rel}");
    run_locked(root, &["update-index", "--add", "--cacheinfo", &info], None, Some(LOCAL))?;
    Ok(StageResult { oid: Some(oid) })
}

#[tauri::command(async)]
pub fn stage_content(state: State<AppState>, path: String, text: Option<String>, eol: Eol, expected_oid: Option<String>) -> Result<StageResult, AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    stage_content_impl(&root, &path, text.as_deref(), eol, expected_oid.as_deref())
}

pub fn stage_path_impl(root: &Path, rel: &str) -> Result<(), AppError> {
    resolve(root, rel)?;
    run_locked(root, &["add", "-A", "--", &literal(rel)], None, Some(LOCAL)).map(|_| ())
}

pub fn unstage_path_impl(root: &Path, rel: &str) -> Result<(), AppError> {
    resolve(root, rel)?;
    run_locked(root, &["reset", "-q", "--", &literal(rel)], None, Some(LOCAL)).map(|_| ())
}

pub fn revert_path_impl(root: &Path, rel: &str) -> Result<(), AppError> {
    let full = resolve(root, rel)?;
    if is_conflicted(root, rel)? {
        return Err(AppError::Conflicted);
    }
    if index_entry(root, rel)?.is_some() {
        run_locked(root, &["checkout", "--", &literal(rel)], None, Some(LOCAL))?;
    } else if full.exists() {
        std::fs::remove_file(&full)?;
    }
    Ok(())
}

pub fn stage_all_impl(root: &Path) -> Result<(), AppError> {
    run_locked(root, &["add", "-A"], None, Some(LOCAL)).map(|_| ())
}

pub fn unstage_all_impl(root: &Path) -> Result<(), AppError> {
    run_locked(root, &["reset", "-q"], None, Some(LOCAL)).map(|_| ())
}

pub fn discard_preview_impl(root: &Path) -> Result<Vec<String>, AppError> {
    let out = run(root, &["-c", "core.quotePath=false", "clean", "-nd"], None, Some(LOCAL))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("Would remove ").map(|s| s.to_string()))
        .collect())
}

pub fn discard_all_impl(root: &Path) -> Result<(), AppError> {
    if !run(root, &["ls-files", "-u"], None, Some(LOCAL))?.stdout.is_empty() {
        return Err(AppError::Conflicted);
    }
    // Gated on the index, not on HEAD: an unborn branch can hold staged files
    // whose working-tree edits the dialog promised to discard, and an empty
    // index is the only case where `checkout -- .` fails with "did not match".
    if !run(root, &["ls-files", "-z"], None, Some(LOCAL))?.stdout.is_empty() {
        run_locked(root, &["checkout", "--", "."], None, Some(LOCAL))?;
    }
    run_locked(root, &["clean", "-fd"], None, Some(LOCAL)).map(|_| ())
}

// Every command below runs git through `run_child`, which sleep-polls the child; on the main
// thread that freezes the window for the whole call. `(async)` moves the sync body onto the
// async runtime instead.
// ponytail: that occupies a tokio worker for the duration; spawn_blocking (as in ai.rs) needs an
// Arc'd AppState, worth it only if these ever outnumber the workers
macro_rules! locked_path_cmd {
    ($name:ident, $imp:ident) => {
        #[tauri::command(async)]
        pub fn $name(state: State<AppState>, path: String) -> Result<(), AppError> {
            let root = state.root()?;
            let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
            $imp(&root, &path)
        }
    };
}
macro_rules! locked_cmd {
    ($name:ident, $imp:ident, $ret:ty) => {
        #[tauri::command(async)]
        pub fn $name(state: State<AppState>) -> Result<$ret, AppError> {
            let root = state.root()?;
            let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
            $imp(&root)
        }
    };
}
locked_path_cmd!(stage_path, stage_path_impl);
locked_path_cmd!(unstage_path, unstage_path_impl);
locked_path_cmd!(revert_path, revert_path_impl);
locked_cmd!(stage_all, stage_all_impl, ());
locked_cmd!(unstage_all, unstage_all_impl, ());
locked_cmd!(discard_all, discard_all_impl, ());

#[tauri::command(async)]
pub fn discard_preview(state: State<AppState>) -> Result<Vec<String>, AppError> {
    discard_preview_impl(&state.root()?)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Branch {
    Local { name: String },
    Remote { remote: String, branch: String },
}

pub fn commit_impl(root: &Path, message: &str) -> Result<(), AppError> {
    run_locked(root, &["commit", "-F", "-"], Some(message.as_bytes()), Some(COMMIT)).map(|_| ())
}

pub fn branches_impl(root: &Path) -> Result<Vec<Branch>, AppError> {
    let remotes_out = run(root, &["remote"], None, Some(LOCAL))?;
    let mut remotes: Vec<String> = String::from_utf8_lossy(&remotes_out.stdout).lines().map(|s| s.to_string()).collect();
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let out = run(root, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], None, Some(LOCAL))?;
    let mut result = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(name) = line.strip_prefix("refs/heads/") {
            result.push(Branch::Local { name: name.to_string() });
        } else if let Some(rest) = line.strip_prefix("refs/remotes/") {
            let Some(remote) = remotes.iter().find(|r| rest.starts_with(&format!("{r}/"))) else { continue };
            let branch = &rest[remote.len() + 1..];
            if branch == "HEAD" {
                continue;
            }
            result.push(Branch::Remote { remote: remote.clone(), branch: branch.to_string() });
        }
    }
    Ok(result)
}

/// Rejects anything git's own ref-name rules disallow, and anything that
/// could be read as an option by `git switch` (an argument starting with
/// `-`), since `name`/`remote`/`branch` reach the command line as bare
/// positional arguments sourced from the IPC boundary.
fn valid_ref_part(s: &str) -> Result<(), AppError> {
    let ok = !s.is_empty()
        && !s.starts_with('-')
        && !s.contains("..")
        && !s.chars().any(|c| c.is_whitespace() || c.is_ascii_control() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'));
    if ok {
        Ok(())
    } else {
        Err(AppError::Git(format!("invalid branch name: {s:?}")))
    }
}

pub fn switch_branch_impl(root: &Path, b: &Branch) -> Result<(), AppError> {
    match b {
        Branch::Local { name } => {
            valid_ref_part(name)?;
            run_locked(root, &["switch", "--", name], None, Some(LOCAL)).map(|_| ())
        }
        Branch::Remote { remote, branch } => {
            valid_ref_part(remote)?;
            valid_ref_part(branch)?;
            let local = format!("refs/heads/{branch}");
            let exists = run_raw(root, &["rev-parse", "-q", "--verify", &local], None, Some(LOCAL), None)?.code == 0;
            if exists {
                run_locked(root, &["switch", "--", branch], None, Some(LOCAL)).map(|_| ())
            } else {
                let track = format!("{remote}/{branch}");
                run_locked(root, &["switch", "--track", "--", &track], None, Some(LOCAL)).map(|_| ())
            }
        }
    }
}

pub fn create_branch_impl(root: &Path, name: &str) -> Result<(), AppError> {
    valid_ref_part(name)?;
    run_locked(root, &["switch", "-c", name], None, Some(LOCAL)).map(|_| ())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StashKind {
    /// Staged, unstaged and untracked changes.
    All,
    Staged,
    /// Unstaged and untracked changes; the index stays as it is.
    Unstaged,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Stash {
    /// The n of `stash@{n}`.
    pub index: u32,
    pub oid: String,
    /// None for a stash made on a detached HEAD, or one whose message git did not write.
    pub branch: Option<String>,
    pub message: String,
    /// The message is git's own `WIP on <branch>: <commit>`, which says only where the stash was made.
    pub wip: bool,
    pub time: i64,
}

fn line_of(out: Out) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn run_with_index(root: &Path, index: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Out, AppError> {
    let mut cmd = git_command(root, args);
    cmd.env("GIT_INDEX_FILE", index);
    let out = run_child(cmd, stdin, Some(LOCAL), None)?;
    if out.code != 0 {
        return Err(AppError::Git(out.stderr));
    }
    Ok(out)
}

/// `git stash` commits under a stand-in name when the user set none; `user.useConfigOnly` does not stop it either.
const FALLBACK_IDENT: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "git stash"),
    ("GIT_AUTHOR_EMAIL", "git@stash"),
    ("GIT_COMMITTER_NAME", "git stash"),
    ("GIT_COMMITTER_EMAIL", "git@stash"),
];

fn commit_tree(root: &Path, ident: &[(&str, &str)], tree: &str, parents: &[String], message: &str) -> Result<String, AppError> {
    let mut args = vec!["commit-tree", tree];
    for p in parents {
        args.extend(["-p", p.as_str()]);
    }
    args.extend(["-F", "-"]);
    let mut cmd = git_command(root, &args);
    cmd.envs(ident.iter().copied());
    let out = run_child(cmd, Some(message.as_bytes()), Some(LOCAL), None)?;
    if out.code != 0 {
        return Err(AppError::Git(out.stderr));
    }
    Ok(line_of(out))
}

/// Deletes the file, then each parent folder it leaves empty, as `git clean -d` would.
fn remove_untracked(root: &Path, rel: &str) -> Result<(), AppError> {
    let full = root.join(rel);
    match std::fs::remove_file(&full) {
        Err(e) if !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => return Err(e.into()),
        _ => {}
    }
    for dir in full.ancestors().skip(1).take_while(|d| *d != root) {
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
    }
    Ok(())
}

/// The listed paths that `index` no longer matches on disk. Changes inside a submodule do not count: no stash holds
/// them, so they are left where they are.
fn changed_since(root: &Path, index: &Path, paths: &HashSet<String>) -> Result<Vec<String>, AppError> {
    let out = run_with_index(root, index, &["diff-files", "--ignore-submodules=dirty", "--name-only", "-z"], None)?;
    Ok(nul_separated(&out.stdout).into_iter().filter(|p| paths.contains(p)).collect())
}

/// `diff-files --raw -z`: each changed path with its status letter.
fn raw_changes(out: &[u8]) -> Vec<(u8, &[u8])> {
    let mut parts = out.split(|&b| b == 0);
    let mut changes = Vec::new();
    while let (Some(meta), Some(path)) = (parts.next(), parts.next()) {
        if let (Some(&status), false) = (meta.last(), path.is_empty()) {
            changes.push((status, path));
        }
    }
    changes
}

/// The first file under `dir` that is not listed: an ignored file, one made since the listing, or a nested
/// repository's. The folder itself when it cannot be read.
fn unlisted_file(root: &Path, dir: &Path, listed: &HashSet<String>) -> Option<String> {
    let Ok(entries) = std::fs::read_dir(root.join(dir)) else { return Some(dir.to_string_lossy().into_owned()) };
    for e in entries {
        let Ok(e) = e else { return Some(dir.to_string_lossy().into_owned()) };
        let rel = dir.join(e.file_name());
        let found = match e.file_type() {
            Ok(t) if t.is_dir() => unlisted_file(root, &rel, listed),
            _ => Some(rel.to_string_lossy().into_owned()).filter(|r| !listed.contains(r)),
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// git has no flag for this: `--keep-index` puts the staged changes in the stash too, and popping it later brings
/// them back as unstaged ones. So the stash is built by hand with the index, not HEAD, as its base, and `stash pop
/// --index` then puts back only the unstaged changes and leaves the index alone. False when there was nothing to
/// stash.
fn stash_unstaged(root: &Path, message: Option<&str>) -> Result<bool, AppError> {
    if !run(root, &["ls-files", "-u"], None, Some(LOCAL))?.stdout.is_empty() {
        return Err(AppError::Conflicted);
    }
    // a file only touched would otherwise be listed as changed, and git's own stash refreshes first too
    run_raw(root, &["update-index", "-q", "--refresh"], None, Some(LOCAL), None)?;
    let raw = run(root, &["diff-files", "--raw", "-z"], None, Some(LOCAL))?.stdout;
    let changes = raw_changes(&raw);
    // a nested repository is listed as its folder with a trailing slash; git's own stash leaves it in place too
    let untracked: Vec<String> = nul_separated(&run(root, &["ls-files", "-o", "--exclude-standard", "-z"], None, Some(LOCAL))?.stdout)
        .into_iter()
        .filter(|p| !p.ends_with('/'))
        .collect();
    if changes.is_empty() && untracked.is_empty() {
        return Ok(false);
    }
    let head = run(root, &["rev-parse", "-q", "--verify", "HEAD"], None, Some(LOCAL))
        .map_err(|_| AppError::Git("You do not have the initial commit yet".into()))
        .map(line_of)?;
    let index_tree = line_of(run_locked(root, &["write-tree"], None, Some(LOCAL))?);

    // `write-tree` leaves out a file added with `add -N`, so checking it out afterwards would write it empty; git
    // refuses too. One whose file is gone reads like any deleted file, except that the tree lacks it.
    let deleted: Vec<&[u8]> = changes.iter().filter(|c| c.0 == b'D').map(|c| c.1).collect();
    let in_tree: HashSet<Vec<u8>> = if deleted.is_empty() {
        HashSet::new()
    } else {
        let out = run(root, &["ls-tree", "-r", "-z", "--name-only", &index_tree], None, Some(LOCAL))?.stdout;
        out.split(|&b| b == 0).map(<[u8]>::to_vec).collect()
    };
    let intent = changes.iter().find(|(st, p)| *st == b'A' || (*st == b'D' && !in_tree.contains(*p)));
    if let Some((_, p)) = intent {
        let p = String::from_utf8_lossy(p);
        return Err(AppError::Git(format!("{p} was added with git add -N. Stage it or unstage it, then stash again.")));
    }
    // Some(true) for a folder, Some(false) for anything else, None for nothing
    let kind_at = |p: &[u8]| std::fs::symlink_metadata(root.join(OsStr::from_bytes(p))).ok().map(|m| m.is_dir());
    // putting a deleted file back replaces a folder at its path whole, and the stash holds only the listed files
    let listed: HashSet<String> = untracked.iter().cloned().collect();
    for p in &deleted {
        let rel = Path::new(OsStr::from_bytes(p));
        if kind_at(p) == Some(true) {
            if let Some(f) = unlisted_file(root, rel, &listed) {
                let p = rel.display();
                return Err(AppError::Git(format!("{f} is in {p}, where a tracked file was deleted, and a stash cannot take it. Move it, then stash again.")));
            }
        }
    }

    let branch = run_raw(root, &["symbolic-ref", "--short", "-q", "HEAD"], None, Some(LOCAL), None)?;
    let branch = if branch.code == 0 { line_of(branch) } else { "(no branch)".to_string() };
    let on = format!("{branch}: {}", line_of(run(root, &["log", "-1", "--format=%h %s", "HEAD"], None, Some(LOCAL))?));
    let has_ident = run_raw(root, &["var", "GIT_COMMITTER_IDENT"], None, Some(LOCAL), None)?.code == 0;
    let ident: &[(&str, &str)] = if has_ident { &[] } else { &FALLBACK_IDENT };
    let changed: Vec<u8> = changes.iter().flat_map(|c| c.1.iter().copied().chain([0])).collect();

    let tmp = tempfile::tempdir()?;
    let work_index = tmp.path().join("work");
    run_with_index(root, &work_index, &["read-tree", &index_tree], None)?;
    run_with_index(root, &work_index, &["update-index", "--add", "--remove", "-z", "--stdin"], Some(&changed))?;
    let work_tree = line_of(run_with_index(root, &work_index, &["write-tree"], None)?);
    // a submodule with changes inside it is listed, but a stash cannot hold them
    if work_tree == index_tree && untracked.is_empty() {
        return Ok(false);
    }
    let base = commit_tree(root, ident, &index_tree, &[head], &format!("index on {on}"))?;
    let index = commit_tree(root, ident, &index_tree, std::slice::from_ref(&base), &format!("index on {on}"))?;
    let mut parents = vec![base, index];
    let untracked_index = tmp.path().join("untracked");
    if !untracked.is_empty() {
        let list: Vec<u8> = untracked.iter().flat_map(|p| p.bytes().chain([0])).collect();
        run_with_index(root, &untracked_index, &["update-index", "--add", "-z", "--stdin"], Some(&list))?;
        let tree = line_of(run_with_index(root, &untracked_index, &["write-tree"], None)?);
        parents.push(commit_tree(root, ident, &tree, &[], &format!("untracked files on {on}"))?);
    }
    let subject = match message {
        Some(m) => format!("On {branch}: {m}"),
        None => format!("WIP on {on}"),
    };
    let stash = commit_tree(root, ident, &work_tree, &parents, &subject)?;
    run_locked(root, &["stash", "store", "-m", &subject, &stash], None, Some(LOCAL))?;

    // checked as late as can be: the cleanup below would drop an edit an agent made after its file was read
    let changed_set: HashSet<String> = changes.iter().map(|c| String::from_utf8_lossy(c.1).into_owned()).collect();
    let mut moved = changed_since(root, &work_index, &changed_set)?;
    moved.extend(deleted.iter().filter(|p| kind_at(p) == Some(false)).map(|p| String::from_utf8_lossy(p).into_owned()));
    if !untracked.is_empty() {
        moved.extend(changed_since(root, &untracked_index, &listed)?);
    }
    if let Some(p) = moved.first() {
        let top = run_raw(root, &["rev-parse", "-q", "--verify", "stash@{0}"], None, Some(LOCAL), None)?;
        let ours = top.code == 0 && line_of(top) == stash;
        let dropped = ours && run_locked(root, &["stash", "drop", "-q", "stash@{0}"], None, Some(LOCAL)).is_ok();
        let what = if dropped { "Nothing was stashed; try again." } else { "The stash was kept, and nothing was removed." };
        return Err(AppError::Git(format!("{p} changed while it was being stashed. {what}")));
    }

    // untracked files first: one can stand where a tracked file comes back, or inside a folder that becomes one
    for p in &untracked {
        remove_untracked(root, p)?;
    }
    // a folder still there holds a file made since the check, and checking the deleted file out would remove it
    let checkout: Vec<u8> = changes
        .iter()
        .filter(|(st, p)| *st != b'D' || kind_at(p) != Some(true))
        .flat_map(|c| c.1.iter().copied().chain([0]))
        .collect();
    // without -u it needs no index.lock, which an agent's commit may hold; the next status refreshes the stat data
    if !checkout.is_empty() {
        run(root, &["checkout-index", "-f", "-q", "-z", "--stdin"], Some(&checkout), Some(LOCAL))?;
    }
    Ok(true)
}

/// `message` becomes the stash's message on one line; without one git writes its own. False when there was nothing
/// to stash.
pub fn stash_push_impl(root: &Path, kind: StashKind, message: Option<&str>) -> Result<bool, AppError> {
    let message = message.map(|m| m.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|m| !m.is_empty());
    if kind == StashKind::Unstaged {
        return stash_unstaged(root, message.as_deref());
    }
    // with unstaged changes but nothing staged, `--staged` fails rather than saying there is nothing to save
    if kind == StashKind::Staged && run_raw(root, &["diff", "--cached", "--quiet"], None, Some(LOCAL), None)?.code == 0 {
        return Ok(false);
    }
    let flag = message.map(|m| format!("--message={m}"));
    let mut args = vec!["stash", "push", if kind == StashKind::All { "--include-untracked" } else { "--staged" }];
    args.extend(flag.as_deref());
    let out = run_locked(root, &args, None, Some(LOCAL))?;
    Ok(!String::from_utf8_lossy(&out.stdout).contains("No local changes to save"))
}

/// `On <branch>: <message>` when a message was given, `WIP on <branch>: <commit>` when git wrote it.
fn parse_stash_subject(subject: &str) -> (Option<String>, String, bool) {
    let (rest, wip) = match (subject.strip_prefix("WIP on "), subject.strip_prefix("On ")) {
        (Some(r), _) => (r, true),
        (None, Some(r)) => (r, false),
        (None, None) => return (None, subject.to_string(), false),
    };
    // a branch name cannot hold a colon
    match rest.split_once(": ") {
        Some((b, m)) => ((b != "(no branch)").then(|| b.to_string()), m.to_string(), wip),
        None => (None, subject.to_string(), false),
    }
}

pub fn stash_list_impl(root: &Path) -> Result<Vec<Stash>, AppError> {
    let out = run(root, &["stash", "list", "--format=%H%x00%ct%x00%gs"], None, Some(LOCAL))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut stashes = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let mut fields = line.splitn(3, '\0');
        let (Some(oid), Some(time), Some(subject)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let (branch, message, wip) = parse_stash_subject(subject);
        stashes.push(Stash { index: n as u32, oid: oid.to_string(), branch, message, wip, time: time.parse().unwrap_or(0) });
    }
    Ok(stashes)
}

/// `oid` is what `stash@{index}` was when the list was read: another stash made or dropped since then moves the
/// numbers, and the pop must not take a different one.
pub fn stash_pop_impl(root: &Path, index: u32, oid: &str) -> Result<(), AppError> {
    let at = format!("stash@{{{index}}}");
    let now = run_raw(root, &["rev-parse", "-q", "--verify", &at], None, Some(LOCAL), None)?;
    if now.code != 0 || line_of(now) != oid {
        return Err(AppError::Git("The list of stashes changed. Pick the stash again.".into()));
    }
    run_locked(root, &["stash", "pop", "--index", &at], None, Some(LOCAL)).map(|_| ())
}

/// `ignored` carries a trailing slash on a wholly ignored directory, which is how the tree tells
/// a collapsed directory from a single ignored file.
#[derive(Debug, serde::Serialize)]
pub struct Listing {
    pub files: Vec<String>,
    pub ignored: Vec<String>,
}

fn nul_separated(out: &[u8]) -> Vec<String> {
    out.split(|&b| b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
}

pub fn list_files_impl(root: &Path) -> Result<Listing, AppError> {
    let listed = run(root, &["ls-files", "-co", "--exclude-standard", "--deduplicate", "-z"], None, Some(LOCAL))?;
    // --directory keeps this bounded: without it an ignored node_modules lists every file under it
    let ignored = run(root, &["ls-files", "-oi", "--exclude-standard", "--directory", "-z"], None, Some(LOCAL))?;
    Ok(Listing { files: nul_separated(&listed.stdout), ignored: nul_separated(&ignored.stdout) })
}

/// How one entry is listed: `None` drops it, `Some("/")` makes it an expandable directory. A
/// symlink is judged by where it lands, so the tree never offers a row that opening it refuses -
/// a pnpm-style link into the repo expands, one leaving it is an ordinary row, one reaching .git
/// is dropped the same way a literal .git is.
fn entry_suffix(root_c: &Path, e: &std::fs::DirEntry) -> Option<&'static str> {
    let Ok(kind) = e.file_type() else { return None };
    if !kind.is_symlink() {
        return Some(if kind.is_dir() { "/" } else { "" });
    }
    let Ok(full) = e.path().canonicalize() else { return Some("") };
    match full.strip_prefix(root_c) {
        Ok(inside) if has_git_component(inside) => None,
        Ok(_) => Some(if full.is_dir() { "/" } else { "" }),
        Err(_) => Some(""),
    }
}

/// One level of a directory `list_files_impl` collapsed, so an ignored tree can still be browsed.
/// Subdirectories keep the trailing slash, which is what marks them as not listed yet.
pub fn list_dir_impl(root: &Path, rel: &str) -> Result<Vec<String>, AppError> {
    let dir = resolve_dir(root, rel)?;
    let root_c = root.canonicalize()?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir)? {
        // one entry lost to a package manager churning the directory must not lose the rest
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let Some(slash) = entry_suffix(&root_c, &e) else { continue };
        out.push(format!("{rel}/{name}{slash}"));
    }
    out.sort();
    Ok(out)
}

#[tauri::command(async)]
pub fn commit(state: State<AppState>, message: String) -> Result<(), AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    commit_impl(&root, &message)
}

#[tauri::command(async)]
pub fn branches(state: State<AppState>) -> Result<Vec<Branch>, AppError> {
    branches_impl(&state.root()?)
}

#[tauri::command(async)]
pub fn switch_branch(state: State<AppState>, branch: Branch) -> Result<(), AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    switch_branch_impl(&root, &branch)
}

#[tauri::command(async)]
pub fn create_branch(state: State<AppState>, name: String) -> Result<(), AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    create_branch_impl(&root, &name)
}

/// `root` is the repo the stash was asked for: the AI's description can take a minute, and another repo opened
/// meanwhile must not be stashed.
#[tauri::command(async)]
pub fn stash_push(state: State<AppState>, root: String, kind: StashKind, message: Option<String>) -> Result<bool, AppError> {
    let open = state.root()?;
    if open != Path::new(&root) {
        return Err(AppError::Git("Another repository was opened, so nothing was stashed.".into()));
    }
    let root = open;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    stash_push_impl(&root, kind, message.as_deref())
}

#[tauri::command(async)]
pub fn stash_list(state: State<AppState>) -> Result<Vec<Stash>, AppError> {
    stash_list_impl(&state.root()?)
}

#[tauri::command(async)]
pub fn stash_pop(state: State<AppState>, index: u32, oid: String) -> Result<(), AppError> {
    let root = state.root()?;
    let _g = state.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    stash_pop_impl(&root, index, &oid)
}

#[tauri::command(async)]
pub fn list_files(state: State<AppState>) -> Result<Listing, AppError> {
    list_files_impl(&state.root()?)
}

#[tauri::command(async)]
pub fn list_dir(state: State<AppState>, path: String) -> Result<Vec<String>, AppError> {
    list_dir_impl(&state.root()?, &path)
}

fn default_push_remote(root: &Path) -> Result<String, AppError> {
    let cfg = run_raw(root, &["config", "--get", "remote.pushDefault"], None, Some(LOCAL), None)?;
    let configured = String::from_utf8_lossy(&cfg.stdout).trim().to_string();
    if !configured.is_empty() {
        return Ok(configured);
    }
    let out = run(root, &["remote"], None, Some(LOCAL))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let remotes: Vec<&str> = text.lines().collect();
    if remotes.contains(&"origin") {
        return Ok("origin".to_string());
    }
    match remotes.as_slice() {
        [only] => Ok((*only).to_string()),
        [] => Err(AppError::Git("this repository has no remote to push to".to_string())),
        _ => Err(AppError::Git(format!("no default push remote; set remote.pushDefault (remotes: {})", remotes.join(", ")))),
    }
}

/// A branch created from a local branch under `branch.autoSetupMerge = always` tracks that
/// local branch, with `branch.<name>.remote = .`. Bare `git push` resolves its remote from
/// that setting, so it pushes into this same repository and exits 0 while nothing reaches a
/// remote. Such branches, and branches with no upstream, get an explicit remote instead.
pub fn push_args(root: &Path) -> Result<Vec<String>, AppError> {
    let head = run_raw(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], None, Some(LOCAL), None)?;
    if head.code != 0 {
        return Ok(vec!["push".to_string()]);
    }
    let branch = String::from_utf8_lossy(&head.stdout).trim().to_string();
    let cfg = run_raw(root, &["config", "--get", &format!("branch.{branch}.remote")], None, Some(LOCAL), None)?;
    let remote = String::from_utf8_lossy(&cfg.stdout).trim().to_string();
    if !remote.is_empty() && remote != "." {
        return Ok(vec!["push".to_string()]);
    }
    let target = default_push_remote(root)?;
    valid_ref_part(&target)?;
    valid_ref_part(&branch)?;
    Ok(vec!["push".to_string(), "--set-upstream".to_string(), target, branch])
}

pub fn run_net(state: &AppState, args: &[&str]) -> Result<(), AppError> {
    let _net_guard = match state.net_lock.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) if state.net_background.swap(false, Ordering::SeqCst) => {
            state.cancelled.store(false, Ordering::SeqCst);
            state.net_waiting.store(true, Ordering::SeqCst);
            let g = take_from_background(state);
            state.net_waiting.store(false, Ordering::SeqCst);
            g?
        }
        Err(std::sync::TryLockError::WouldBlock) => {
            return Err(AppError::Git("a push or pull is already running".to_string()))
        }
    };
    let root = state.root()?;
    state.cancelled.store(false, Ordering::SeqCst);
    let out = run_raw(&root, args, None, None, Some(&state.net_pid))?;
    if state.cancelled.swap(false, Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }
    if out.code != 0 {
        return Err(AppError::Git(out.stderr));
    }
    Ok(())
}

/// Signals the background git and waits for `net_lock`. The pid is read on every try, since a fetch that had
/// not spawned its git yet had none. SIGTERM lets git remove its lock files; a second into the wait it is SIGKILL.
/// A background fetch that cannot exit, e.g. stuck on a dead mount, is left behind by a Cancel.
fn take_from_background(state: &AppState) -> Result<std::sync::MutexGuard<'_, ()>, AppError> {
    let start = Instant::now();
    loop {
        let g = match state.net_lock.try_lock() {
            Ok(g) => Some(g),
            Err(std::sync::TryLockError::Poisoned(p)) => Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        if state.cancelled.swap(false, Ordering::SeqCst) {
            return Err(AppError::Cancelled);
        }
        if let Some(g) = g {
            return Ok(g);
        }
        if let Some(pid) = *state.background_pid.lock().unwrap_or_else(|e| e.into_inner()) {
            // a fetch that took the lock after the one this was waiting for reads it as stopped too
            state.net_background.store(false, Ordering::SeqCst);
            signal_group(pid, if start.elapsed() < Duration::from_secs(1) { libc::SIGTERM } else { libc::SIGKILL });
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn cancel_impl(state: &AppState) {
    if state.net_waiting.load(Ordering::SeqCst) {
        state.cancelled.store(true, Ordering::SeqCst);
    }
    if let Some(pid) = *state.net_pid.lock().unwrap_or_else(|e| e.into_inner()) {
        state.cancelled.store(true, Ordering::SeqCst);
        kill_group(pid);
    }
}

#[tauri::command(async)]
pub fn push(state: State<AppState>) -> Result<(), AppError> {
    let args = push_args(&state.root()?)?;
    run_net(&state, &args.iter().map(String::as_str).collect::<Vec<_>>())
}

#[tauri::command(async)]
pub fn pull(state: State<AppState>) -> Result<(), AppError> {
    run_net(&state, &["pull"])
}

/// Refresh only: this moves the remote-tracking refs, so ahead/behind in the next status
/// are current, and leaves HEAD and the working tree alone.
#[tauri::command(async)]
pub fn fetch(state: State<AppState>) -> Result<(), AppError> {
    run_net(&state, &["fetch", "--prune"])
}

/// Long enough for a fetch after weeks away; a hung connection holds nothing the user needs, since a push,
/// pull or fetch stops it.
const BACKGROUND: Duration = Duration::from_secs(120);

/// The fetch the app runs on its own to keep ahead/behind current. It skips while a push, pull or fetch runs or
/// waits, and gives way to one that starts. Git, askpass and Git Credential Manager do not prompt: a remote that
/// needs credentials they do not already have fails instead. An SSH agent or the keychain can still ask.
/// No --prune, unlike the user's Fetch: a refspec into refs/heads would have it delete unpushed local branches.
/// Auto gc is off because the user did not ask for anything to run, and FETCH_HEAD is left to a fetch run by hand
/// in a terminal.
pub fn fetch_background_impl(state: &AppState) -> Result<(), AppError> {
    if state.net_waiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    let _net_guard = match state.net_lock.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
    };
    let root = state.root()?;
    state.net_background.store(true, Ordering::SeqCst);
    let mut cmd = git_command(&root, &["fetch", "--no-auto-gc", "--no-write-fetch-head"]);
    cmd.env("GIT_ASKPASS", "/usr/bin/false").env("SSH_ASKPASS_REQUIRE", "never").env("GCM_INTERACTIVE", "never");
    let res = run_child(cmd, None, Some(BACKGROUND), Some(&state.background_pid));
    // cleared by run_net, which stopped this fetch to run its own
    if !state.net_background.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    let out = res?;
    if out.code != 0 {
        return Err(AppError::Git(out.stderr));
    }
    Ok(())
}

/// Checks the settings file on every call, like the AI gate, so a hand edit turning it off holds at once.
#[tauri::command(async)]
pub fn fetch_background(app: tauri::AppHandle, state: State<AppState>) -> Result<(), AppError> {
    if crate::settings::load(&app).auto_fetch == crate::settings::AutoFetch::Off {
        return Ok(());
    }
    fetch_background_impl(&state)
}

#[tauri::command(async)]
pub fn cancel(state: State<AppState>) {
    cancel_impl(&state)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlameLine {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
}

pub fn blame_impl(root: &Path, rel: &str, line: u32, contents: &str, e: Eol) -> Result<BlameLine, AppError> {
    let spec = format!("{line},{line}");
    let args = ["blame", "--porcelain", "-L", &spec, "--contents", "-", "--", rel];
    // git runs the piped text through the same clean filter it would apply to the working file,
    // so a CRLF file has to arrive as CRLF: an LF copy of a committed line differs from its blob
    // and blames to the zero oid, which would read as "uncommitted" for the whole file
    let bytes = eol::apply(&eol::normalize(contents), e);
    let out = run(root, &args, Some(bytes.as_bytes()), Some(LOCAL))?;
    let s = String::from_utf8_lossy(&out.stdout);
    // length is not checked: sha1 prints 40 hex digits and an --object-format=sha256 repo 64
    let oid = s
        .lines()
        .next()
        .and_then(|l| l.split(' ').next())
        .filter(|o| !o.is_empty() && o.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| AppError::Git("unparsable blame output".to_string()))?;
    let field = |k: &str| s.lines().find_map(|l| l.strip_prefix(k)).unwrap_or("").to_string();
    Ok(BlameLine {
        oid: oid.to_string(),
        author: field("author "),
        time: field("author-time ").parse().unwrap_or(0),
        summary: field("summary "),
    })
}

#[tauri::command(async)]
pub fn blame(state: State<AppState>, path: String, line: u32, contents: String, eol: Eol) -> Result<BlameLine, AppError> {
    let root = state.root()?;
    resolve(&root, &path)?;
    blame_impl(&root, &path, line, &contents, eol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_edited_after_it_was_read_into_an_index_is_caught() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        run(r, &["init", "-q"], None, Some(LOCAL)).unwrap();
        std::fs::write(r.join("a.txt"), "a\n").unwrap();
        std::fs::write(r.join("b.txt"), "b\n").unwrap();
        let index = r.join(".git/scratch-index");
        run_with_index(r, &index, &["update-index", "--add", "-z", "--stdin"], Some(b"a.txt\0b.txt\0")).unwrap();
        let listed: HashSet<String> = ["a.txt".to_string()].into();
        assert_eq!(changed_since(r, &index, &listed).unwrap(), Vec::<String>::new());
        std::fs::write(r.join("a.txt"), "agent\n").unwrap();
        std::fs::write(r.join("b.txt"), "not listed\n").unwrap();
        assert_eq!(changed_since(r, &index, &listed).unwrap(), ["a.txt"]);
    }

    #[test]
    fn a_stash_subject_yields_its_branch_and_message() {
        let p = parse_stash_subject;
        assert_eq!(p("On main: Adds a thing: really"), (Some("main".into()), "Adds a thing: really".into(), false));
        assert_eq!(p("WIP on feat/x: 1a2b3c4 Fix it"), (Some("feat/x".into()), "1a2b3c4 Fix it".into(), true));
        assert_eq!(p("On (no branch): Detached"), (None, "Detached".into(), false));
        assert_eq!(p("hand-made entry"), (None, "hand-made entry".into(), false));
        assert_eq!(p("On nothing"), (None, "On nothing".into(), false));
    }

    #[test]
    fn repo_title_prefers_the_readme_heading_over_the_package_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(repo_title(root), None);

        std::fs::write(root.join("package.json"), r#"{"name": "codebaer"}"#).unwrap();
        assert_eq!(repo_title(root).as_deref(), Some("codebaer"));

        std::fs::write(root.join("ReadMe.md"), "<p>badge</p>\n\n#  CodeB\u{e4}r \n\n# Later\n").unwrap();
        assert_eq!(repo_title(root).as_deref(), Some("CodeB\u{e4}r"));
    }

    #[test]
    fn repo_about_is_the_readme_s_first_prose_then_a_manifest_description() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(repo_about(root), None);

        std::fs::write(root.join("Cargo.toml"), "[package]\ndescription = \"\"\"\nMany lines\n\"\"\"\n").unwrap();
        assert_eq!(repo_about(root), None);
        std::fs::write(root.join("Cargo.toml"), "[workspace.package]\ndescription = 'A \\\"raw\\\" one'\n").unwrap();
        assert_eq!(repo_about(root).as_deref(), Some(r#"A \"raw\" one"#));
        std::fs::write(root.join("Cargo.toml"), "[dependencies]\ndescription = \"no\"\n[package]\nname = \"x\"\ndescription = \"A \\\"quoted\\\" crate\" # the \"why\"\n").unwrap();
        assert_eq!(repo_about(root).as_deref(), Some(r#"A \"quoted\" crate"#));

        std::fs::write(root.join("package.json"), r#"{"description": " Shop front "}"#).unwrap();
        assert_eq!(repo_about(root).as_deref(), Some("Shop front"));

        std::fs::write(root.join("README.md"), "# Title\n\n[![ci](b.svg)](ci)\n<p align=center>\n\n```sh\nnpm i\n```\n\nFirst  line\nsecond line\n\nLater\n").unwrap();
        assert_eq!(repo_about(root).as_deref(), Some("First  line second line"));

        std::fs::write(root.join("README.md"), format!("# Title\n\n{}\n", "\u{e4}".repeat(ABOUT_CHARS + 5))).unwrap();
        assert_eq!(repo_about(root).map(|a| a.chars().count()), Some(ABOUT_CHARS));

        std::fs::write(root.join("README.md"), "# Only a title\n").unwrap();
        assert_eq!(repo_about(root).as_deref(), Some("Shop front"));
    }

    #[test]
    fn opened_keeps_the_real_root_apart_from_its_label() {
        let home = std::env::var("HOME").unwrap();
        let root = format!("{home}/projects/app");
        let o = Opened::of(Path::new(&root));
        // the terminals compare their kernel-reported folders against `root`
        assert_eq!(o.root, root);
        assert_eq!(o.label, "~/projects/app");
    }
}
