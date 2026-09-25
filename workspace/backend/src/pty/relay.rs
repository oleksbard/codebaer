//! A session of the current host whose program is this relay, attached to one session of a stale
//! host through that host's bridge. It is the one way back to a host built for another protocol
//! version, because the app only ever connects to the host for its own.
//!
//! It speaks only Hello, Attach, Resize, Input and Close, and reads server messages as loose
//! JSON, so that a version skew costs it the messages it does not know rather than the session.

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::bridge;
use super::proto::{self, ClientMsg, Frame};

static HANGUP: AtomicBool = AtomicBool::new(false);

/// A session by id, or by pid for one whose id could not be read from its environment.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Id(u32),
    Pid(i32),
}

impl Target {
    pub fn parse(s: &str) -> Option<Target> {
        match s.strip_prefix("pid:") {
            Some(pid) => pid.parse().ok().map(Target::Pid),
            None => s.parse().ok().map(Target::Id),
        }
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Target::Id(id) => write!(f, "{id}"),
            Target::Pid(pid) => write!(f, "pid:{pid}"),
        }
    }
}

/// The version a host speaks is the one in its socket's name.
pub fn proto_of(sock: &Path) -> Option<u32> {
    sock.file_name()?.to_str()?.strip_prefix("ptyd-")?.strip_suffix(".sock")?.parse().ok()
}

enum End {
    Exit(i32),
    Closed,
    Error(String),
}

pub(super) fn frame(f: &Frame) -> Vec<u8> {
    let mut out = Vec::new();
    proto::encode(f, &mut out);
    out
}

pub(super) fn control(msg: &ClientMsg) -> Vec<u8> {
    frame(&Frame::Control(serde_json::to_vec(msg).unwrap_or_default()))
}

/// Only sets a flag: the socket may be mid-frame on another thread, and a Close written from
/// here could land inside it.
extern "C" fn hangup(_: libc::c_int) {
    HANGUP.store(true, Ordering::SeqCst);
}

fn winsize() -> Option<(u16, u16)> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0;
    (ok && ws.ws_col > 0 && ws.ws_row > 0).then_some((ws.ws_col, ws.ws_row))
}

/// Without this our own line discipline would echo and line-buffer every keystroke before the
/// old session's program saw it, and turn ^C into a signal for the relay instead of a byte for it.
fn raw_stdin() {
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) == 0 {
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(0, libc::TCSANOW, &t);
        }
    }
}

fn exited(s: &Value) -> bool {
    s.pointer("/state/t").and_then(Value::as_str) == Some("Exited")
}

/// Finds the session in the host's Hello reply, refusing one that has already exited.
fn resolve(hello: &Value, target: &Target) -> Result<u32, String> {
    let sessions = hello.get("sessions").and_then(Value::as_array).ok_or("the host sent no session list")?;
    let me = match target {
        Target::Id(id) => sessions.iter().find(|s| s.get("id").and_then(Value::as_u64) == Some(u64::from(*id))),
        // a title would be a guess: a shell that ran `exec bash` keeps the title it started with
        Target::Pid(_) if !sessions.is_empty() && sessions.iter().all(|s| s.get("pid").is_none()) => {
            return Err("that host is older than session pids, and this session's id is hidden".into());
        }
        // an exited record's pid may since have been handed to the very process being looked for
        Target::Pid(pid) => sessions
            .iter()
            .filter(|s| !exited(s))
            .find(|s| s.get("pid").and_then(Value::as_i64) == Some(i64::from(*pid))),
    };
    let me = me.ok_or_else(|| format!("session {target} is no longer in that host"))?;
    if exited(me) {
        return Err(format!("session {target} had already exited"));
    }
    me.get("id").and_then(Value::as_u64).and_then(|id| u32::try_from(id).ok()).ok_or("the host sent a bad id".into())
}

fn event(json: &[u8], id: u32) -> Option<End> {
    let v: Value = serde_json::from_slice(json).ok()?;
    let mine = v.get("id").and_then(Value::as_u64) == Some(u64::from(id));
    let unaddressed = v.get("id").is_none_or(Value::is_null);
    match v.get("t")?.as_str()? {
        "Exit" if mine => Some(End::Exit(v.get("code").and_then(Value::as_i64).map_or(0, |c| c as i32))),
        "Closed" if mine => Some(End::Closed),
        // an error with no id is about the connection, which the bridge shares among its relays
        "Error" if mine || unaddressed => {
            Some(End::Error(v.get("message").and_then(Value::as_str).unwrap_or("error").to_string()))
        }
        _ => None,
    }
}

pub(super) struct Frames {
    pub(super) s: UnixStream,
    pub(super) buf: Vec<u8>,
}

impl Frames {
    pub(super) fn next(&mut self) -> Result<Frame, String> {
        let mut chunk = [0u8; 64 * 1024];
        loop {
            if let Some((f, used)) = proto::decode(&self.buf).map_err(|e| format!("protocol: {e:?}"))? {
                self.buf.drain(..used);
                return Ok(f);
            }
            match self.s.read(&mut chunk) {
                Ok(0) => return Err("the old host closed the connection".into()),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("the old host: {e}")),
            }
        }
    }
}

fn close_and_exit(w: &Mutex<UnixStream>, id: u32, code: i32) -> ! {
    if let Ok(mut s) = w.lock() {
        let _ = s.write_all(&control(&ClientMsg::Close { id }));
    }
    std::process::exit(code)
}

fn say(msg: &str) {
    let mut out = std::io::stdout();
    let _ = write!(out, "\r\n[codebaer relay] {msg}\r\n");
    let _ = out.flush();
}

pub fn run(sock: &Path, target: &Target) -> ! {
    match relay(sock, target) {
        Ok(never) => match never {},
        Err(e) => {
            say(&e);
            std::process::exit(1)
        }
    }
}

/// The host's answer to Hello. `Err` is the host refusing, `Ok(Err)` the connection lost first.
fn hello(frames: &mut Frames, mut writer: &UnixStream, v: u32) -> Result<Result<Value, String>, String> {
    let wire = control(&ClientMsg::Hello { proto: v, client: "codebaer-relay".into() });
    if let Err(e) = writer.write_all(&wire) {
        return Ok(Err(e.to_string()));
    }
    loop {
        let json = match frames.next() {
            Ok(Frame::Control(json)) => json,
            Ok(_) => continue,
            Err(e) => return Ok(Err(e)),
        };
        let Ok(msg) = serde_json::from_slice::<Value>(&json) else { continue };
        match msg.get("t").and_then(Value::as_str) {
            Some("Hello") => return Ok(Ok(msg)),
            Some("Error") => return Err(msg.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
            _ => {}
        }
    }
}

/// A bridge that is closing down can let a relay in and then drop it unanswered, which is
/// retried on a new connection.
fn join(sock: &Path, v: u32) -> Result<(Frames, UnixStream, Value), String> {
    let mut tries = 0;
    loop {
        let stream = bridge::connect(sock)?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
        let writer = stream.try_clone().map_err(|e| e.to_string())?;
        let mut frames = Frames { s: stream, buf: Vec::new() };
        match hello(&mut frames, &writer, v)? {
            Ok(msg) => {
                frames.s.set_read_timeout(None).map_err(|e| e.to_string())?;
                return Ok((frames, writer, msg));
            }
            Err(e) if tries >= 3 => return Err(e),
            Err(_) => tries += 1,
        }
    }
}

fn relay(sock: &Path, target: &Target) -> Result<std::convert::Infallible, String> {
    let v = proto_of(sock).ok_or_else(|| format!("{} is not a pty host socket", sock.display()))?;
    unsafe {
        // the current host ends a session with SIGHUP, then SIGTERM: both mean close the old one
        // too, and they can arrive before the handshake below is done
        libc::signal(libc::SIGHUP, hangup as extern "C" fn(libc::c_int) as libc::sighandler_t);
        libc::signal(libc::SIGTERM, hangup as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    let (mut frames, writer, hello) = join(sock, v)?;
    let writer = Arc::new(Mutex::new(writer));
    let id = resolve(&hello, target)?;

    if HANGUP.load(Ordering::SeqCst) {
        close_and_exit(&writer, id, 0);
    }
    raw_stdin();
    let mut size = winsize();
    {
        let mut attach = control(&ClientMsg::Attach { id: Some(id) });
        if let Some((cols, rows)) = size {
            attach.extend(control(&ClientMsg::Resize { id, cols, rows }));
        }
        writer.lock().unwrap().write_all(&attach).map_err(|e| e.to_string())?;
    }

    let input = writer.clone();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if input.lock().unwrap().write_all(&frame(&Frame::Input(id, chunk[..n].to_vec()))).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        // our own terminal is gone, which is this session being closed
        HANGUP.store(true, Ordering::SeqCst);
    });

    let watch = writer.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        if HANGUP.load(Ordering::SeqCst) {
            close_and_exit(&watch, id, 0);
        }
        // polled rather than taken from SIGWINCH, which would need a second handler for no gain
        let now = winsize();
        if now != size {
            size = now;
            if let Some((cols, rows)) = now {
                let _ = watch.lock().unwrap().write_all(&control(&ClientMsg::Resize { id, cols, rows }));
            }
        }
    });

    let mut out = std::io::stdout().lock();
    loop {
        match frames.next()? {
            Frame::Output(from, bytes) if from == id => {
                if out.write_all(&bytes).and_then(|()| out.flush()).is_err() {
                    close_and_exit(&writer, id, 0);
                }
            }
            Frame::Control(json) => match event(&json, id) {
                None => {}
                Some(End::Exit(code)) => close_and_exit(&writer, id, code),
                Some(End::Closed) => std::process::exit(0),
                Some(End::Error(e)) => return Err(e),
            },
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_from_the_socket_name() {
        assert_eq!(proto_of(Path::new("/a/Application Support/x/ptyd-1.sock")), Some(1));
        assert_eq!(proto_of(Path::new("/a/ptyd-12.sock")), Some(12));
        assert_eq!(proto_of(Path::new("/a/ptyd-x.sock")), None);
        assert_eq!(proto_of(Path::new("/a/other.sock")), None);
    }

    #[test]
    fn parses_a_target_by_id_or_by_pid() {
        assert_eq!(Target::parse("4"), Some(Target::Id(4)));
        assert_eq!(Target::parse("pid:7284"), Some(Target::Pid(7284)));
        assert_eq!(Target::parse("pid:"), None);
        assert_eq!(Target::parse("x"), None);
        assert_eq!(Target::Pid(7284).to_string(), "pid:7284");
    }

    fn ev(json: &str) -> Option<String> {
        event(json.as_bytes(), 4).map(|e| match e {
            End::Exit(c) => format!("exit {c}"),
            End::Closed => "closed".into(),
            End::Error(m) => format!("error {m}"),
        })
    }

    #[test]
    fn ends_only_on_its_own_session() {
        assert_eq!(ev(r#"{"t":"Exit","id":4,"code":130}"#).as_deref(), Some("exit 130"));
        assert_eq!(ev(r#"{"t":"Exit","id":5,"code":0}"#), None);
        assert_eq!(ev(r#"{"t":"Closed","id":4}"#).as_deref(), Some("closed"));
        assert_eq!(ev(r#"{"t":"Error","id":null,"message":"proto 1 != 2"}"#).as_deref(), Some("error proto 1 != 2"));
        assert_eq!(ev(r#"{"t":"Error","id":5,"message":"x"}"#), None);
        assert_eq!(ev(r#"{"t":"SomethingNewer","id":4}"#), None);
    }

    fn hello(sessions: &str) -> Value {
        serde_json::from_str(&format!(r#"{{"t":"Hello","proto":2,"sessions":{sessions}}}"#)).unwrap()
    }

    #[test]
    fn resolves_a_session_by_id_or_by_pid() {
        let h = hello(r#"[{"id":4,"pid":900,"state":{"t":"Idle"}},{"id":5,"pid":901,"state":{"t":"Idle"}}]"#);
        assert_eq!(resolve(&h, &Target::Id(5)), Ok(5));
        assert_eq!(resolve(&h, &Target::Pid(900)), Ok(4));
        assert!(resolve(&h, &Target::Pid(1)).is_err_and(|e| e.contains("no longer")));
        let reused = hello(r#"[{"id":3,"pid":900,"state":{"t":"Exited","code":0}},{"id":4,"pid":900,"state":{"t":"Idle"}}]"#);
        assert_eq!(resolve(&reused, &Target::Pid(900)), Ok(4));
    }

    #[test]
    fn gives_up_on_a_session_it_cannot_use() {
        let exited = hello(r#"[{"id":4,"pid":900,"state":{"t":"Exited","code":0}}]"#);
        assert!(resolve(&exited, &Target::Id(4)).is_err_and(|e| e.contains("already exited")));
    }

    #[test]
    fn an_empty_host_has_no_such_session_rather_than_being_too_old() {
        assert!(resolve(&hello("[]"), &Target::Pid(900)).is_err_and(|e| e.contains("no longer")));
    }

    #[test]
    fn will_not_guess_a_hidden_session_on_a_host_from_before_pids() {
        let old = hello(r#"[{"id":4,"title":"zsh","state":{"t":"Idle"}}]"#);
        assert!(resolve(&old, &Target::Pid(900)).is_err_and(|e| e.contains("older")));
        assert_eq!(resolve(&old, &Target::Id(4)), Ok(4));
    }
}
