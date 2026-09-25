//! Shares a stale host's one client connection among the relays attached to it. A host serves one
//! client and the newest connection wins, so a second relay connecting straight to it would cut
//! the first one off. The bridge holds the connection instead and hands each relay the frames of
//! the session it attached to.
//!
//! Detached like the host, so closing the relay that started it leaves the others running. It
//! goes a few seconds after its last relay does, which lets the host idle-reap again.

use std::collections::HashMap;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::proto::{ClientMsg, Frame, ServerMsg};
use super::relay::{control, frame, proto_of, Frames};

/// Covers a relay closed and another restored straight after, which then needs no new bridge.
const LINGER: Duration = Duration::from_secs(3);

pub fn path(sock: &Path) -> PathBuf {
    sock.with_extension("bridge")
}

/// Held for the bridge's whole life: a second bridge on a host would take its connection from
/// the first.
pub fn lock_path(sock: &Path) -> PathBuf {
    sock.with_extension("bridge.lock")
}

/// The bridge to `sock`, started if none answers. A start that finds another bridge holding the
/// lock steps aside, and that one may be closing, so the connect is tried again until it lands.
pub fn connect(sock: &Path) -> Result<UnixStream, String> {
    let at = path(sock);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = UnixStream::connect(&at) {
            return Ok(s);
        }
        if Instant::now() > deadline {
            return Err(format!("no bridge to {} came up", sock.display()));
        }
        let out = Command::new(&exe)
            .arg("--pty-bridge")
            .arg(sock)
            // a tagged process with no host above it is one the orphan finder offers to kill
            .env_remove("CODEBAER_SESSION")
            // the current host ends a relay with killpg, which would otherwise also reach a bridge
            // that has not detached yet
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if why.is_empty() { "the bridge to the old host did not start".into() } else { why });
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct Hub {
    clients: HashMap<u64, Arc<Mutex<UnixStream>>>,
    /// The relay each attached session belongs to.
    owner: HashMap<u32, u64>,
    /// Relays waiting for the host's answer to a Hello. Any answer does for all of them, since each
    /// only looks its own session up in it, and a host old enough to drop a reply when its queue
    /// is full would otherwise leave one waiting for good.
    hellos: Vec<u64>,
    next: u64,
    empty_since: Option<Instant>,
}

struct Bridge {
    hub: Mutex<Hub>,
    host: Mutex<UnixStream>,
    path: PathBuf,
    ino: u64,
}

impl Bridge {
    fn owns(&self, key: u64, id: u32) -> bool {
        self.hub.lock().unwrap().owner.get(&id) == Some(&key)
    }

    /// Takes `id` for `key` unless another relay has it, and says whether `key` now has it.
    fn claim(&self, key: u64, id: u32) -> bool {
        *self.hub.lock().unwrap().owner.entry(id).or_insert(key) == key
    }

    fn to_host(&self, wire: &[u8]) {
        let _ = self.host.lock().unwrap().write_all(wire);
    }
}

/// Called with the hub locked, so no relay is taken on while the bridge goes. The socket is left
/// alone once it is some later bridge's, which only a deleted lock file lets start.
fn quit(b: &Bridge) -> ! {
    if std::fs::symlink_metadata(&b.path).is_ok_and(|m| m.ino() == b.ino) {
        let _ = std::fs::remove_file(&b.path);
    }
    std::process::exit(0)
}

struct Ready {
    host: UnixStream,
    frames: Frames,
    listener: UnixListener,
    ino: u64,
    _lock: std::fs::File,
}

/// Everything that can fail with the relay still waiting, done before detaching so the reason
/// reaches it on stderr. `None` is another bridge already holding the host.
fn start(sock: &Path) -> Result<Option<Ready>, String> {
    let v = proto_of(sock).ok_or_else(|| format!("{} is not a pty host socket", sock.display()))?;
    let lock_at = lock_path(sock);
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(&lock_at)
        .map_err(|e| format!("{}: {e}", lock_at.display()))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(None);
        }
        return Err(format!("{}: {e}", lock_at.display()));
    }
    let host = UnixStream::connect(sock).map_err(|e| format!("{}: {e}", sock.display()))?;
    host.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let mut frames = Frames { s: host.try_clone().map_err(|e| e.to_string())?, buf: Vec::new() };
    (&host).write_all(&control(&ClientMsg::Hello { proto: v, client: "codebaer-bridge".into() })).map_err(|e| e.to_string())?;
    loop {
        let Frame::Control(json) = frames.next()? else { continue };
        let Ok(msg) = serde_json::from_slice::<Value>(&json) else { continue };
        match msg.get("t").and_then(Value::as_str) {
            Some("Hello") => break,
            Some("Error") => return Err(msg.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
            _ => {}
        }
    }
    host.set_read_timeout(None).map_err(|e| e.to_string())?;
    let at = path(sock);
    // the lock says no other bridge is alive, so a file left at the path is a dead one's
    let _ = std::fs::remove_file(&at);
    // before bind, as the host does: the socket carries keystrokes into every relayed session
    unsafe { libc::umask(0o077) };
    let listener = UnixListener::bind(&at).map_err(|e| format!("{}: {e}", at.display()))?;
    let ino = std::fs::symlink_metadata(&at).map_err(|e| format!("{}: {e}", at.display()))?.ino();
    Ok(Some(Ready { host, frames, listener, ino, _lock: lock }))
}

pub fn run(sock: &Path) -> ! {
    let ready = match start(sock) {
        Ok(Some(ready)) => ready,
        Ok(None) => std::process::exit(0),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    };
    super::daemon::daemonize(&sock.with_extension("log"));
    let _ = env_logger::try_init();
    let b = Arc::new(Bridge {
        hub: Mutex::new(Hub {
            clients: HashMap::new(),
            owner: HashMap::new(),
            hellos: Vec::new(),
            next: 0,
            // from the start, so a bridge whose relay never arrives does not hold the host forever
            empty_since: Some(Instant::now()),
        }),
        host: Mutex::new(ready.host),
        path: path(sock),
        ino: ready.ino,
    });

    let reader = b.clone();
    let frames = ready.frames;
    std::thread::spawn(move || {
        from_host(&reader, frames);
        let _hub = reader.hub.lock().unwrap();
        quit(&reader);
    });

    let timer = b.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let h = timer.hub.lock().unwrap();
        if h.clients.is_empty() && h.empty_since.is_some_and(|t| t.elapsed() > LINGER) {
            quit(&timer);
        }
    });

    for stream in ready.listener.incoming() {
        let Ok(s) = stream else { break };
        let Ok(w) = s.try_clone() else { continue };
        let me = Arc::new(Mutex::new(w));
        let key = {
            let mut h = b.hub.lock().unwrap();
            h.next += 1;
            let key = h.next;
            h.clients.insert(key, me.clone());
            h.empty_since = None;
            key
        };
        let b = b.clone();
        std::thread::spawn(move || {
            from_relay(&b, key, s, &me);
            let mut h = b.hub.lock().unwrap();
            h.clients.remove(&key);
            h.owner.retain(|_, k| *k != key);
            if h.clients.is_empty() {
                h.empty_since = Some(Instant::now());
            }
        });
    }
    log::error!("bridge {}: accept failed", b.path.display());
    let _hub = b.hub.lock().unwrap();
    quit(&b);
}

fn refuse(to: &Mutex<UnixStream>, id: u32, message: String) {
    if let Ok(json) = serde_json::to_vec(&ServerMsg::Error { id: Some(id), message }) {
        let _ = to.lock().unwrap().write_all(&frame(&Frame::Control(json)));
    }
}

fn id_of(v: &Value) -> Option<u32> {
    v.get("id").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())
}

/// Passes on only what a relay sends, and only for the session it attached to. Anything else
/// would reach sessions that are not its own: an Attach with no id replays every one of them,
/// and a Shutdown ends them all.
fn from_relay(b: &Bridge, key: u64, s: UnixStream, me: &Mutex<UnixStream>) {
    let mut frames = Frames { s, buf: Vec::new() };
    while let Ok(f) = frames.next() {
        match f {
            Frame::Input(id, _) if b.owns(key, id) => b.to_host(&frame(&f)),
            Frame::Control(json) => {
                let Ok(msg) = serde_json::from_slice::<Value>(&json) else { continue };
                let id = id_of(&msg);
                let wire = frame(&Frame::Control(json));
                match (msg.get("t").and_then(Value::as_str), id) {
                    (Some("Hello"), _) => {
                        b.hub.lock().unwrap().hellos.push(key);
                        b.to_host(&wire);
                    }
                    // a Close can come first, from a relay closed while it was still starting
                    (Some(t @ ("Attach" | "Close")), Some(id)) => {
                        if b.claim(key, id) {
                            b.to_host(&wire);
                        } else if t == "Attach" {
                            refuse(me, id, format!("session {id} is already relayed in another terminal"));
                        }
                    }
                    (Some("Resize"), Some(id)) if b.owns(key, id) => b.to_host(&wire),
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// Returns when the host's connection ends, which ends every relay's too.
fn from_host(b: &Bridge, mut frames: Frames) {
    while let Ok(f) = frames.next() {
        let to: Vec<Arc<Mutex<UnixStream>>> = {
            let mut h = b.hub.lock().unwrap();
            let keys: Vec<u64> = match &f {
                Frame::Output(id, _) => h.owner.get(id).copied().into_iter().collect(),
                Frame::Input(..) => Vec::new(),
                Frame::Control(json) => {
                    let Ok(msg) = serde_json::from_slice::<Value>(json) else { continue };
                    match (msg.get("t").and_then(Value::as_str), id_of(&msg)) {
                        (Some("Hello"), _) => std::mem::take(&mut h.hellos),
                        (Some("Closed"), Some(id)) => h.owner.remove(&id).into_iter().collect(),
                        (_, Some(id)) => h.owner.get(&id).copied().into_iter().collect(),
                        // unaddressed, it is about the connection, which every relay here shares
                        (Some("Error"), None) => h.clients.keys().copied().collect(),
                        _ => Vec::new(),
                    }
                }
            };
            keys.iter().filter_map(|k| h.clients.get(k).cloned()).collect()
        };
        if to.is_empty() {
            continue;
        }
        let wire = frame(&f);
        for c in to {
            let _ = c.lock().unwrap().write_all(&wire);
        }
    }
}
