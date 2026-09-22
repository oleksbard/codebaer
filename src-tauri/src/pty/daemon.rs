use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use super::osc133::{Mark, Scanner};
use super::proto::{self, ClientMsg, Frame, Info, ServerMsg, SpawnKind, State, Tier};
use super::ring::Ring;
use super::shells;

const RING: usize = 4 * 1024 * 1024;
pub const IDLE: Duration = Duration::from_secs(15 * 60);
/// Bounded on purpose: a full queue blocks the session's reader, which stops draining the pty,
/// which is what makes the kernel apply real backpressure to a program producing faster than
/// the webview can paint. Dropping frames instead would corrupt the stream.
const QUEUE: usize = 256;
const COALESCE: Duration = Duration::from_millis(8);
/// A shell that has produced output but no prompt mark by now is not going to: its rc files
/// defeated the injection (powerlevel10k's instant prompt does exactly this) and it drops to
/// the tier that only reports liveness.
const MARK_GRACE: Duration = Duration::from_secs(5);
const TERM_GRACE: Duration = Duration::from_secs(2);
const CHUNK: usize = 64 * 1024;

struct Session {
    info: Info,
    ring: Ring,
    scanner: Scanner,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Signalled instead of the child pid: killing the shell alone would leave whatever it
    /// launched running with no terminal and no parent.
    pgid: i32,
    started: Instant,
    saw_mark: bool,
    /// The injected rc files; removed from disk when the session record is dropped.
    _tmp: Option<tempfile::TempDir>,
}

pub struct Hub {
    sessions: BTreeMap<u32, Session>,
    out: Option<SyncSender<Frame>>,
    client: Option<UnixStream>,
    /// Bumped per accepted connection so a departing client cannot clear its successor's state.
    gen: u64,
    next_id: u32,
    idle_since: Option<Instant>,
    stop: bool,
    sock: PathBuf,
}

type Shared = Arc<Mutex<Hub>>;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The record macOS actually honours. `$SHELL` is set once at login and goes stale after chsh,
/// and a Finder-launched app may not have inherited a useful one at all.
pub fn login_shell() -> String {
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_shell.is_null() {
            if let Ok(s) = std::ffi::CStr::from_ptr((*pw).pw_shell).to_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    "/bin/zsh".to_string()
}

fn emit(hub: &Hub, msg: &ServerMsg) {
    if let (Some(tx), Ok(json)) = (&hub.out, serde_json::to_vec(msg)) {
        // a client 256 frames behind is about to be replaced anyway, and the app re-lists on
        // reconnect, so a dropped status is recoverable where a blocked dispatcher is not
        let _ = tx.try_send(Frame::Control(json));
    }
}

pub fn new_hub(sock: PathBuf) -> Shared {
    Arc::new(Mutex::new(Hub {
        sessions: BTreeMap::new(),
        out: None,
        client: None,
        gen: 0,
        next_id: 1,
        // runs from startup, so a daemon that is spawned and then never reached still reaps itself
        idle_since: Some(Instant::now()),
        stop: false,
        sock,
    }))
}

pub fn serve(listener: UnixListener, hub: Shared, idle: Duration) {
    let timer = hub.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let expired = {
            let h = timer.lock().unwrap();
            h.stop || h.idle_since.is_some_and(|t| t.elapsed() > idle)
        };
        if expired {
            wake(&timer);
            return;
        }
    });

    for stream in listener.incoming() {
        if hub.lock().unwrap().stop {
            return;
        }
        match stream {
            Ok(s) => accept(s, hub.clone()),
            Err(e) => {
                log::warn!("accept: {e}");
                return;
            }
        }
    }
}

/// Unblocks the accept loop by connecting to our own socket, the only portable way to make
/// `incoming()` return once the stop flag is set.
fn wake(hub: &Shared) {
    let path = {
        let mut h = hub.lock().unwrap();
        h.stop = true;
        h.sock.clone()
    };
    let _ = UnixStream::connect(path);
}

fn accept(stream: UnixStream, hub: Shared) {
    let (tx, rx) = sync_channel::<Frame>(QUEUE);
    let Ok(w) = stream.try_clone() else { return };
    let Ok(keep) = stream.try_clone() else { return };
    let gen = {
        let mut h = hub.lock().unwrap();
        h.gen += 1;
        // last connection wins: after a rebuild the new app must not queue behind the
        // half-open socket of the one that was killed
        if let Some(old) = h.client.take() {
            let _ = old.shutdown(Shutdown::Both);
        }
        h.client = Some(keep);
        h.out = Some(tx);
        h.idle_since = None;
        h.gen
    };
    std::thread::spawn(move || writer_loop(w, rx));
    std::thread::spawn(move || {
        client_loop(stream, &hub);
        let mut h = hub.lock().unwrap();
        if h.gen == gen {
            h.out = None;
            h.client = None;
            h.idle_since = Some(Instant::now());
        }
    });
}

fn writer_loop(mut w: UnixStream, rx: Receiver<Frame>) {
    let mut buf = Vec::new();
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        let deadline = Instant::now() + COALESCE;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(f) => batch.push(f),
                Err(_) => break,
            }
        }
        buf.clear();
        let mut it = batch.into_iter().peekable();
        while let Some(frame) = it.next() {
            match frame {
                Frame::Output(id, mut bytes) => {
                    // one write per session per tick instead of one per pty read, which is the
                    // difference between tens of frames and tens of thousands
                    while matches!(it.peek(), Some(Frame::Output(next, _)) if *next == id) {
                        if let Some(Frame::Output(_, more)) = it.next() {
                            bytes.extend_from_slice(&more);
                        }
                    }
                    proto::encode(&Frame::Output(id, bytes), &mut buf);
                }
                other => proto::encode(&other, &mut buf),
            }
        }
        if w.write_all(&buf).is_err() {
            return;
        }
    }
}

fn client_loop(mut s: UnixStream, hub: &Shared) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; CHUNK];
    loop {
        let n = match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        let mut off = 0;
        loop {
            match proto::decode(&buf[off..]) {
                Ok(Some((frame, used))) => {
                    off += used;
                    if dispatch(frame, hub) {
                        return;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    log::warn!("protocol error, dropping client: {e:?}");
                    return;
                }
            }
        }
        buf.drain(..off);
    }
}

/// Returns true when the client should be dropped.
fn dispatch(frame: Frame, hub: &Shared) -> bool {
    match frame {
        Frame::Input(id, bytes) => {
            let mut h = hub.lock().unwrap();
            if let Some(s) = h.sessions.get_mut(&id) {
                let _ = s.writer.write_all(&bytes);
                let _ = s.writer.flush();
            }
        }
        Frame::Output(..) => {}
        Frame::Control(json) => match serde_json::from_slice::<ClientMsg>(&json) {
            Ok(msg) => return control(msg, hub),
            Err(e) => log::warn!("bad control message: {e}"),
        },
    }
    false
}

fn control(msg: ClientMsg, hub: &Shared) -> bool {
    match msg {
        ClientMsg::Hello { proto: v, .. } => {
            let h = hub.lock().unwrap();
            if v != proto::PROTO {
                emit(&h, &ServerMsg::Error { id: None, message: format!("proto {v} != {}", proto::PROTO) });
                return true;
            }
            let sessions = h.sessions.values().map(|s| s.info.clone()).collect();
            emit(&h, &ServerMsg::Hello { proto: proto::PROTO, sessions });
        }
        ClientMsg::Spawn { req, kind, cwd, cols, rows } => spawn(req, kind, &cwd, cols, rows, hub),
        ClientMsg::Attach { id } => attach(id, hub),
        ClientMsg::Resize { id, cols, rows } => {
            let h = hub.lock().unwrap();
            if let Some(s) = h.sessions.get(&id) {
                let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
            }
        }
        ClientMsg::Kill { id } => kill(id, hub),
        ClientMsg::Close { id } => {
            let exited = match hub.lock().unwrap().sessions.get(&id) {
                None => return false,
                Some(s) => matches!(s.info.state, State::Exited { .. }),
            };
            // dropping a live record would strand its process tree forever: teardown only
            // reaches sessions still in the map, and the reader thread holds a dup of the
            // master fd so dropping the record cannot even produce a tty hangup
            if !exited {
                kill(id, hub);
            }
            let mut h = hub.lock().unwrap();
            if h.sessions.remove(&id).is_some() {
                emit(&h, &ServerMsg::Closed { id });
            }
        }
        ClientMsg::Shutdown => {
            teardown(hub);
            wake(hub);
            return true;
        }
    }
    false
}

fn attach(id: Option<u32>, hub: &Shared) {
    let (replays, tx) = {
        let h = hub.lock().unwrap();
        let replays: Vec<(u32, Vec<u8>)> = h
            .sessions
            .values()
            .filter(|s| id.is_none_or(|want| want == s.info.id))
            .map(|s| (s.info.id, s.ring.replay()))
            .collect();
        (replays, h.out.clone())
    };
    let Some(tx) = tx else { return };
    for (id, bytes) in replays {
        // chunked so one 4 MiB replay cannot occupy a whole queue slot, and so a second
        // session's replay starts before the first has finished draining
        for part in bytes.chunks(CHUNK) {
            if tx.send(Frame::Output(id, part.to_vec())).is_err() {
                return;
            }
        }
    }
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn spawn(req: u32, kind: SpawnKind, cwd: &str, cols: u16, rows: u16, hub: &Shared) {
    match try_spawn(req, kind, cwd, cols, rows, hub) {
        Ok(()) => {}
        Err(e) => {
            let h = hub.lock().unwrap();
            emit(&h, &ServerMsg::Error { id: None, message: e });
        }
    }
}

fn try_spawn(req: u32, kind: SpawnKind, cwd: &str, cols: u16, rows: u16, hub: &Shared) -> Result<(), String> {
    let id = {
        let mut h = hub.lock().unwrap();
        h.next_id += 1;
        h.next_id - 1
    };
    let mut tmp = None;
    let (program, args, env, tier, title) = match &kind {
        SpawnKind::Shell { path } => {
            let dir = tempfile::Builder::new().prefix("codebaer-").tempdir().map_err(|e| e.to_string())?;
            let inj = shells::injection(path, dir.path(), std::env::var("ZDOTDIR").ok().as_deref());
            match inj {
                Some(inj) => {
                    for (name, body) in &inj.files {
                        std::fs::write(dir.path().join(name), body).map_err(|e| e.to_string())?;
                    }
                    tmp = Some(dir);
                    (path.clone(), inj.args, inj.env, Tier::Marks, basename(path).to_string())
                }
                None => (path.clone(), shells::login_args(path), Vec::new(), Tier::Process, basename(path).to_string()),
            }
        }
        // through the login shell, not directly: a Finder-launched app's PATH does not contain
        // ~/.local/bin, which is where claude lives
        SpawnKind::Command { argv0 } => (
            login_shell(),
            vec!["-l".into(), "-c".into(), format!("exec {}", quote(argv0))],
            Vec::new(),
            Tier::Process,
            basename(argv0).to_string(),
        ),
    };

    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "codebaer");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env("CODEBAER_SESSION", id.to_string());
    if !std::env::var("LANG").is_ok_and(|l| l.to_uppercase().contains("UTF-8")) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    // a bash-only convention that goes stale on the first resize; TIOCSWINSZ is the real channel
    cmd.env_remove("COLUMNS");
    cmd.env_remove("LINES");

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let killer = child.clone_killer();
    // portable-pty calls setsid() in the child before exec so it can claim the tty, which makes
    // it a session and process-group leader: its pid is its pgid, and killpg on it reaches
    // everything it goes on to launch.
    let pgid = child.process_id().unwrap_or(0) as i32;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut h = hub.lock().unwrap();
        let info = Info {
            id,
            title,
            cwd: cwd.to_string(),
            tier,
            state: State::Starting,
        };
        h.sessions.insert(
            id,
            Session {
                info: info.clone(),
                ring: Ring::new(RING),
                scanner: Scanner::new(),
                master: pair.master,
                writer,
                killer,
                pgid,
                started: Instant::now(),
                saw_mark: false,
                _tmp: tmp,
            },
        );
        emit(&h, &ServerMsg::Spawned { req, info });
    }

    let pump = hub.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; CHUNK];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let (tx, notes) = {
                let mut h = pump.lock().unwrap();
                let tx = h.out.clone();
                let Some(s) = h.sessions.get_mut(&id) else { break };
                s.ring.push(&buf[..n]);
                let mut marks = Vec::new();
                s.scanner.feed(&buf[..n], &mut marks);
                (tx, apply(s, marks))
            };
            if let Some(tx) = &tx {
                for note in &notes {
                    if let Ok(json) = serde_json::to_vec(note) {
                        // blocking: a dropped Bell, Command or Exit is a missing attention
                        // badge, and these are sent from outside the lock so waiting is safe
                        let _ = tx.send(Frame::Control(json));
                    }
                }
                // blocking, and deliberately so: this is the backpressure valve
                let _ = tx.send(Frame::Output(id, buf[..n].to_vec()));
            }
        }
        let code = child.wait().ok().map(|st| st.exit_code() as i32);
        let tx = {
            let mut h = pump.lock().unwrap();
            if let Some(s) = h.sessions.get_mut(&id) {
                s.info.state = State::Exited { code };
            }
            h.out.clone()
        };
        if let (Some(tx), Ok(json)) = (tx, serde_json::to_vec(&ServerMsg::Exit { id, code })) {
            let _ = tx.send(Frame::Control(json));
        }
    });
    Ok(())
}

/// Folds the marks a read produced into the session and returns what the client must be told.
fn apply(s: &mut Session, marks: Vec<Mark>) -> Vec<ServerMsg> {
    let mut out = Vec::new();
    let before = s.info.state.clone();
    for mark in marks {
        match mark {
            Mark::PromptStart => {
                s.saw_mark = true;
                s.info.state = State::Idle;
            }
            Mark::CommandStart(command) => {
                s.saw_mark = true;
                s.info.state = State::Running {
                    command: (!command.is_empty()).then_some(command),
                    since_ms: now_ms(),
                };
            }
            Mark::CommandEnd(code) => {
                s.saw_mark = true;
                s.info.state = State::Idle;
                out.push(ServerMsg::Command { id: s.info.id, code });
            }
            Mark::Bell => out.push(ServerMsg::Bell { id: s.info.id }),
        }
    }
    if matches!(s.info.state, State::Starting) && !s.saw_mark {
        s.info.state = State::Running { command: None, since_ms: now_ms() };
    }
    if s.info.tier == Tier::Marks && !s.saw_mark && s.started.elapsed() > MARK_GRACE {
        s.info.tier = Tier::Process;
    }
    if s.info.state != before || out.iter().any(|m| matches!(m, ServerMsg::Command { .. })) {
        out.push(ServerMsg::Status { id: s.info.id, state: s.info.state.clone(), tier: s.info.tier });
    }
    out
}

fn kill(id: u32, hub: &Shared) {
    let pgid = match hub.lock().unwrap().sessions.get_mut(&id) {
        Some(s) => {
            // covers the one case signals cannot: a child whose pid we failed to learn
            if s.pgid <= 0 {
                s.killer.kill().ok();
            }
            s.pgid
        }
        None => return,
    };
    hangup(&[pgid]);
    std::thread::spawn(move || {
        std::thread::sleep(TERM_GRACE);
        signal(pgid, libc::SIGKILL);
    });
}

/// SIGHUP first because it is what a closing terminal sends, and a job-control shell responds
/// to it by hanging up its own jobs, which live in process groups of their own and are
/// therefore out of killpg's reach from here.
fn hangup(pgids: &[i32]) {
    for p in pgids {
        signal(*p, libc::SIGHUP);
        signal(*p, libc::SIGTERM);
    }
}

fn signal(pgid: i32, sig: i32) {
    if pgid > 0 {
        unsafe {
            libc::killpg(pgid, sig);
        }
    }
}

pub fn teardown(hub: &Shared) {
    let pgids: Vec<i32> = {
        let mut h = hub.lock().unwrap();
        for s in h.sessions.values_mut() {
            if s.pgid <= 0 {
                s.killer.kill().ok();
            }
        }
        h.sessions.values().map(|s| s.pgid).collect()
    };
    hangup(&pgids);
    std::thread::sleep(TERM_GRACE);
    for p in &pgids {
        signal(*p, libc::SIGKILL);
    }
    // dropping the records closes every pty master, and the kernel turns that into a real tty
    // hangup for anything still holding a slave: the last net under a job we never signalled
    hub.lock().unwrap().sessions.clear();
}

/// Leaves the app's process group and reparents to pid 1, so neither a process-group signal
/// nor a walk of the app's child tree can reach us. `tauri dev` does the latter on every
/// rebuild, which is the whole reason this process exists.
fn daemonize(log: &Path) {
    unsafe {
        if libc::fork() > 0 {
            libc::_exit(0);
        }
        libc::setsid();
        // the app's stdout and stderr are pipes the tauri cli reads; holding them open would
        // stop it seeing EOF when it kills the app, and the inherited cwd would pin a directory
        let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
        if null >= 0 {
            libc::dup2(null, 0);
            libc::dup2(null, 1);
            if null > 2 {
                libc::close(null);
            }
        }
        // stderr goes to a file rather than /dev/null: this is the one process whose logs
        // cannot be read from a terminal
        if let Ok(path) = std::ffi::CString::new(log.as_os_str().as_encoded_bytes()) {
            let fd = libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND, 0o600);
            if fd >= 0 {
                libc::dup2(fd, 2);
                if fd > 2 {
                    libc::close(fd);
                }
            }
        }
        libc::chdir(c"/".as_ptr());
    }
}

/// Binds, or steps aside if a live daemon already holds the path.
fn bind(path: &Path) -> std::io::Result<UnixListener> {
    // set before bind, not chmod after: the gap between the two is a window in which another
    // local account could connect and then drive every session
    unsafe { libc::umask(0o077) };
    match UnixListener::bind(path) {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if UnixStream::connect(path).is_ok() {
                std::process::exit(0);
            }
            std::fs::remove_file(path)?;
            UnixListener::bind(path)
        }
        Err(e) => Err(e),
    }
}

pub fn run(sock: &Path) -> ! {
    if let Some(dir) = sock.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    daemonize(&sock.with_extension("log"));
    // without this every log::warn! in the host, including the protocol errors, goes nowhere
    let _ = env_logger::try_init();
    let listener = match bind(sock) {
        Ok(l) => l,
        Err(e) => {
            log::error!("bind {}: {e}", sock.display());
            std::process::exit(1);
        }
    };
    // the socket carries this app's keystrokes; nothing else on the machine may connect
    let _ = std::fs::set_permissions(sock, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o600));
    let hub = new_hub(sock.to_path_buf());
    serve(listener, hub.clone(), IDLE);
    // idempotent: the Shutdown path has already emptied the map, so this only does work
    // when serve() returned for another reason, such as the idle timer
    teardown(&hub);
    let _ = std::fs::remove_file(sock);
    std::process::exit(0);
}
