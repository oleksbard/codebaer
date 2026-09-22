use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime, State};

use super::daemon;
use super::proto::{self, ClientMsg, Frame, ServerMsg, SpawnKind};
use super::shells::{self, Shell};
use crate::AppError;

/// Commands worth offering in the new-terminal menu when the login shell can find them.
const PROBE: [&str; 6] = ["claude", "codex", "node", "python3", "bun", "deno"];
/// Input is split at this size. A paste is one `onData` string of any length, and a frame
/// over `proto::MAX_FRAME` would be refused by the far side and take the connection with it.
const INPUT_CHUNK: usize = 256 * 1024;

#[derive(Default)]
pub struct PtyState(Mutex<Conn>);

#[derive(Default)]
struct Conn {
    /// Bumped per connection, so a pump thread that ends after its socket was replaced does
    /// not clear the handle that now belongs to a working one.
    gen: u64,
    write: Option<UnixStream>,
    out: Option<Channel<InvokeResponseBody>>,
    ev: Option<Channel<ServerMsg>>,
    menu: Option<Menu>,
    req: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Menu {
    pub shells: Vec<Shell>,
    pub default: String,
    pub commands: Vec<String>,
}

impl PtyState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn sock_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    let dir = app.path().app_config_dir().map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("ptyd-{}.sock", proto::PROTO)))
}

fn executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// One login shell run, cached: it is also the only way to see a PATH entry like ~/.local/bin,
/// which is where claude lives and which a Finder-launched app never inherits.
fn probe_commands(login: &str) -> Vec<String> {
    let script = format!(
        "for c in {}; do command -v \"$c\" >/dev/null 2>&1 && echo \"$c\"; done",
        PROBE.join(" ")
    );
    let out = std::process::Command::new(login).args(["-l", "-c", &script]).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

fn build_menu() -> Menu {
    let login = daemon::login_shell();
    let etc = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    // a Finder launch gets /usr/bin:/bin:/usr/sbin:/sbin and neither homebrew prefix
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/bin", "/usr/bin"] {
        let p = PathBuf::from(extra);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    let refs: Vec<&std::path::Path> = dirs.iter().map(PathBuf::as_path).collect();
    Menu {
        shells: shells::detect(&login, &etc, &refs, &executable),
        default: login.clone(),
        commands: probe_commands(&login),
    }
}

fn menu(state: &State<'_, PtyState>) -> Menu {
    if let Some(m) = state.0.lock().unwrap().menu.clone() {
        return m;
    }
    // built outside the lock: it runs a login shell, which is not something to hold a mutex over
    let m = build_menu();
    state.0.lock().unwrap().menu = Some(m.clone());
    m
}

fn send(conn: &mut Conn, frame: &Frame) -> Result<(), AppError> {
    let mut wire = Vec::new();
    match frame {
        // chunked here rather than at the call sites, so no caller can produce an oversized
        // frame: the far side rejects one and drops the connection, which strands every session
        Frame::Input(id, bytes) if bytes.len() > INPUT_CHUNK => {
            for part in bytes.chunks(INPUT_CHUNK) {
                proto::encode(&Frame::Input(*id, part.to_vec()), &mut wire);
            }
        }
        f => proto::encode(f, &mut wire),
    }
    match conn.write.as_mut() {
        Some(s) => s.write_all(&wire).map_err(AppError::from),
        None => Err(AppError::Io("no terminal host".into())),
    }
}

fn control(conn: &mut Conn, msg: &ClientMsg) -> Result<(), AppError> {
    let json = serde_json::to_vec(msg).map_err(|e| AppError::Io(e.to_string()))?;
    send(conn, &Frame::Control(json))
}

/// Connects to the host, starting one if nothing answers. The app subscribes at startup, so this
/// is also what reattaches to the sessions a previous run left running.
fn ensure<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    let state = app.state::<PtyState>();
    if state.0.lock().unwrap().write.is_some() {
        return Ok(());
    }
    let sock = sock_path(app)?;
    let stream = match UnixStream::connect(&sock) {
        Ok(s) => s,
        Err(_) => {
            let exe = std::env::current_exe()?;
            let mut child = std::process::Command::new(exe).arg("--pty-host").arg(&sock).spawn()?;
            // the host forks and this parent exits at once, so the wait is immediate and
            // leaves no zombie behind
            let _ = child.wait();
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match UnixStream::connect(&sock) {
                    Ok(s) => break s,
                    Err(e) if Instant::now() >= deadline => return Err(AppError::Io(format!("terminal host: {e}"))),
                    Err(_) => std::thread::sleep(Duration::from_millis(25)),
                }
            }
        }
    };
    let reader = stream.try_clone()?;
    let generation = {
        let mut c = state.0.lock().unwrap();
        c.gen += 1;
        c.write = Some(stream);
        control(&mut c, &ClientMsg::Hello { proto: proto::PROTO, client: "codebaer".into() })?;
        c.gen
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        pump(reader, &handle);
        let state = handle.state::<PtyState>();
        let mut c = state.0.lock().unwrap();
        if c.gen == generation {
            c.write = None;
        }
    });
    Ok(())
}

fn pump<R: Runtime>(mut reader: UnixStream, app: &AppHandle<R>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        let mut off = 0;
        loop {
            match proto::decode(&buf[off..]) {
                Ok(Some((frame, used))) => {
                    off += used;
                    deliver(frame, app);
                }
                Ok(None) => break,
                Err(e) => {
                    log::warn!("terminal host protocol error: {e:?}");
                    return;
                }
            }
        }
        buf.drain(..off);
    }
}

fn deliver<R: Runtime>(frame: Frame, app: &AppHandle<R>) {
    let state = app.state::<PtyState>();
    // cloned and released before sending: holding it across the send would make this thread
    // wait behind term_input, which is itself blocked writing to the socket this thread
    // is supposed to be draining
    let (out, ev) = {
        let c = state.0.lock().unwrap();
        (c.out.clone(), c.ev.clone())
    };
    match frame {
        Frame::Output(id, bytes) => {
            if let Some(ch) = &out {
                // session id then bytes, so one channel carries every session without a
                // per-frame json envelope around pty output
                let mut payload = Vec::with_capacity(4 + bytes.len());
                payload.extend_from_slice(&id.to_le_bytes());
                payload.extend_from_slice(&bytes);
                let _ = ch.send(InvokeResponseBody::Raw(payload));
            }
        }
        Frame::Control(json) => {
            if let (Some(ch), Ok(msg)) = (&ev, serde_json::from_slice::<ServerMsg>(&json)) {
                let _ = ch.send(msg);
            }
        }
        Frame::Input(..) => {}
    }
}

#[tauri::command(async)]
pub fn term_menu(state: State<'_, PtyState>) -> Menu {
    menu(&state)
}

/// Called on every mount. A webview reload silently destroys the previous channels without
/// telling Rust, so re-attaching here is what replays the rings into fresh xterm instances.
#[tauri::command(async)]
pub fn term_subscribe<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PtyState>,
    out: Channel<InvokeResponseBody>,
    ev: Channel<ServerMsg>,
) -> Result<(), AppError> {
    ensure(&app)?;
    let mut c = state.0.lock().unwrap();
    c.out = Some(out);
    c.ev = Some(ev);
    control(&mut c, &ClientMsg::Hello { proto: proto::PROTO, client: "codebaer".into() })?;
    control(&mut c, &ClientMsg::Attach { id: None })
}

#[tauri::command(async)]
pub fn term_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PtyState>,
    git: State<'_, crate::git::AppState>,
    kind: SpawnKind,
    cols: u16,
    rows: u16,
) -> Result<u32, AppError> {
    // the webview picks from what detection found; it never composes a command line, and it
    // never names a directory
    let m = menu(&state);
    let ok = match &kind {
        SpawnKind::Shell { path } => m.shells.iter().any(|s| &s.path == path),
        SpawnKind::Command { argv0 } => m.commands.iter().any(|c| c == argv0),
    };
    if !ok {
        return Err(AppError::InvalidPath(format!("{kind:?}")));
    }
    let cwd = git.root()?;
    ensure(&app)?;
    let mut c = state.0.lock().unwrap();
    c.req += 1;
    let req = c.req;
    control(&mut c, &ClientMsg::Spawn { req, kind, cwd: cwd.to_string_lossy().into_owned(), cols, rows })?;
    Ok(req)
}

#[tauri::command(async)]
pub fn term_input(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), AppError> {
    let mut c = state.0.lock().unwrap();
    send(&mut c, &Frame::Input(id, data.into_bytes()))
}

/// xterm reports X10 and 1005 mouse events through `onBinary` rather than `onData`, because
/// those bytes are not UTF-8 and must not be re-encoded as if they were.
#[tauri::command(async)]
pub fn term_input_bytes(state: State<'_, PtyState>, id: u32, bytes: Vec<u8>) -> Result<(), AppError> {
    let mut c = state.0.lock().unwrap();
    send(&mut c, &Frame::Input(id, bytes))
}

#[tauri::command(async)]
pub fn term_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), AppError> {
    let mut c = state.0.lock().unwrap();
    control(&mut c, &ClientMsg::Resize { id, cols, rows })
}

#[tauri::command(async)]
pub fn term_kill(state: State<'_, PtyState>, id: u32) -> Result<(), AppError> {
    let mut c = state.0.lock().unwrap();
    control(&mut c, &ClientMsg::Kill { id })
}

#[tauri::command(async)]
pub fn term_close(state: State<'_, PtyState>, id: u32) -> Result<(), AppError> {
    let mut c = state.0.lock().unwrap();
    control(&mut c, &ClientMsg::Close { id })
}

/// Quitting is the one exit that takes the sessions with it. A rebuild kills this process with
/// SIGKILL, which cannot run this, which is exactly how the host tells the two apart.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<PtyState>();
    let mut c = state.0.lock().unwrap();
    if c.write.is_some() {
        let _ = control(&mut c, &ClientMsg::Shutdown);
        if let Some(s) = c.write.as_mut() {
            let _ = s.flush();
        }
    }
}
