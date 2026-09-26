use crate::eol;
use crate::eol::Eol;
use crate::error::AppError;
use crate::status::{self, Status};
use serde::{Deserialize, Serialize};
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
    // pid 0 means "this process's own group" and 1 is init/launchd: never valid
    // targets here, and passing either through to libc::kill would take out the
    // app itself (0) or every process on the machine the caller can signal (1).
    if pid <= 1 {
        return;
    }
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
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

pub fn run_raw(
    root: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Option<Duration>,
    pid_slot: Option<&Mutex<Option<u32>>>,
) -> Result<Out, AppError> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GIT_SSH_COMMAND");
    run_child(cmd, stdin, timeout, pid_slot)
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
    let out = run_locked(root, &["status", "--porcelain=v2", "--branch", "-uall", "-z"], None, Some(LOCAL))?;
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

fn readme_title(root: &Path) -> Option<String> {
    let readme = std::fs::read_dir(root).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("readme.md"))
    })?;
    let text = head_of(&readme, TITLE_BYTES)?;
    text.lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn package_name(root: &Path) -> Option<String> {
    let text = head_of(&root.join("package.json"), TITLE_BYTES)?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = json.get("name")?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// A human name for the repo, for the header. The remote's basename is deliberately not consulted:
/// it is the folder name in everything but `git clone <url> <other-dir>`, and it costs a subprocess.
pub(crate) fn repo_title(root: &Path) -> Option<String> {
    readme_title(root).or_else(|| package_name(root))
}

#[tauri::command(async)]
pub fn open_repo(state: State<AppState>, app: tauri::AppHandle, path: String) -> Result<Opened, AppError> {
    let repo = discover(Path::new(&path))?;
    let handle = crate::watcher::start(&app, &repo.root, &repo.git_dir, &repo.common_dir)?;
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

pub fn stash_push_impl(root: &Path) -> Result<(), AppError> {
    run_locked(root, &["stash", "push", "--include-untracked"], None, Some(LOCAL)).map(|_| ())
}

pub fn stash_pop_impl(root: &Path) -> Result<(), AppError> {
    run_locked(root, &["stash", "pop", "--index"], None, Some(LOCAL)).map(|_| ())
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

locked_cmd!(stash_push, stash_push_impl, ());
locked_cmd!(stash_pop, stash_pop_impl, ());

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

pub fn cancel_impl(state: &AppState) {
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
    fn opened_keeps_the_real_root_apart_from_its_label() {
        let home = std::env::var("HOME").unwrap();
        let root = format!("{home}/projects/app");
        let o = Opened::of(Path::new(&root));
        // the terminals compare their kernel-reported folders against `root`
        assert_eq!(o.root, root);
        assert_eq!(o.label, "~/projects/app");
    }
}
