use serde::{Deserialize, Serialize};

/// Bumped by any change to the frames or messages below. The socket file name carries it,
/// so an app never speaks to a daemon built against a different version; the orphan idle-reaps.
pub const PROTO: u32 = 2;
pub const MAX_FRAME: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// JSON, deserialized by the receiver into the message enum for its direction.
    Control(Vec<u8>),
    Output(u32, Vec<u8>),
    Input(u32, Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProtoError {
    TooLarge(usize),
    BadKind(u8),
    Short,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum SpawnKind {
    Shell { path: String },
    Command { argv0: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ClientMsg {
    Hello { proto: u32, client: String },
    Spawn { req: u32, kind: SpawnKind, cwd: String, cols: u16, rows: u16 },
    Attach { id: Option<u32> },
    Resize { id: u32, cols: u16, rows: u16 },
    Kill { id: u32 },
    Close { id: u32 },
    /// Re-reads every session's folder now, for when the app's idea of "inside" just changed.
    CheckCwd,
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Marks,
    Process,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum State {
    Starting,
    Idle,
    Running { command: Option<String>, since_ms: u64 },
    Exited { code: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Info {
    pub id: u32,
    /// The session's process, which also leads its group. The only link from a session to a pid
    /// that survives a platform binary such as /bin/zsh, whose environment `ps` cannot read.
    /// Defaulted so that a host from before it was added still parses.
    #[serde(default)]
    pub pid: Option<i32>,
    pub title: String,
    /// The folder as last read from the kernel, which starts out as the spawn folder.
    pub cwd: String,
    pub tier: Tier,
    pub state: State,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ServerMsg {
    Hello { proto: u32, sessions: Vec<Info> },
    Spawned { req: u32, info: Info },
    Status { id: u32, state: State, tier: Tier },
    /// One command inside a shell finished. Distinct from `Exit`, which is the session's own
    /// process ending, and only ever sent for a tier that has marks to read.
    Command { id: u32, code: Option<i32> },
    // portable-pty reports only a code, so a signal death arrives as its 128+n encoding
    Exit { id: u32, code: Option<i32> },
    Bell { id: u32 },
    /// Sent only when the folder differs from the last one reported, `Info::cwd` included.
    Cwd { id: u32, cwd: String },
    Closed { id: u32 },
    Error { id: Option<u32>, message: String },
}

pub fn encode(frame: &Frame, out: &mut Vec<u8>) {
    let (kind, id, payload): (u8, Option<u32>, &[u8]) = match frame {
        Frame::Control(p) => (0, None, p),
        Frame::Output(id, p) => (1, Some(*id), p),
        Frame::Input(id, p) => (2, Some(*id), p),
    };
    let len = 1 + if id.is_some() { 4 } else { 0 } + payload.len();
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(kind);
    if let Some(id) = id {
        out.extend_from_slice(&id.to_le_bytes());
    }
    out.extend_from_slice(payload);
}

/// Decodes one frame from the front of `buf`, returning it with the number of bytes consumed.
/// `Ok(None)` means the buffer holds less than one whole frame.
pub fn decode(buf: &[u8]) -> Result<Option<(Frame, usize)>, ProtoError> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_le_bytes(buf[..4].try_into().unwrap()) as usize;
    // checked before the body is waited for, so a bogus length cannot make the reader buffer forever
    if len > MAX_FRAME {
        return Err(ProtoError::TooLarge(len));
    }
    if len == 0 {
        return Err(ProtoError::Short);
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let body = &buf[4..4 + len];
    let rest = &body[1..];
    let frame = match body[0] {
        0 => Frame::Control(rest.to_vec()),
        k @ (1 | 2) => {
            if rest.len() < 4 {
                return Err(ProtoError::Short);
            }
            let id = u32::from_le_bytes(rest[..4].try_into().unwrap());
            let payload = rest[4..].to_vec();
            if k == 1 { Frame::Output(id, payload) } else { Frame::Input(id, payload) }
        }
        k => return Err(ProtoError::BadKind(k)),
    };
    Ok(Some((frame, 4 + len)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(f: Frame) {
        let mut out = Vec::new();
        encode(&f, &mut out);
        let (got, used) = decode(&out).unwrap().expect("a whole frame");
        assert_eq!(got, f);
        assert_eq!(used, out.len());
    }

    #[test]
    fn round_trips_every_frame_kind() {
        roundtrip(Frame::Control(b"{\"t\":\"Shutdown\"}".to_vec()));
        roundtrip(Frame::Output(7, vec![0x1b, b'[', b'0', b'm', 0xff, 0x00]));
        roundtrip(Frame::Input(0, b"ls -la\r".to_vec()));
    }

    #[test]
    fn round_trips_empty_payload() {
        roundtrip(Frame::Output(3, Vec::new()));
    }

    #[test]
    fn decodes_two_frames_from_one_buffer() {
        let mut out = Vec::new();
        encode(&Frame::Output(1, b"aa".to_vec()), &mut out);
        encode(&Frame::Output(2, b"bbbb".to_vec()), &mut out);
        let (first, used) = decode(&out).unwrap().unwrap();
        assert_eq!(first, Frame::Output(1, b"aa".to_vec()));
        let (second, used2) = decode(&out[used..]).unwrap().unwrap();
        assert_eq!(second, Frame::Output(2, b"bbbb".to_vec()));
        assert_eq!(used + used2, out.len());
    }

    #[test]
    fn wants_more_bytes_for_a_partial_frame() {
        let mut out = Vec::new();
        encode(&Frame::Output(1, b"hello".to_vec()), &mut out);
        for cut in 0..out.len() {
            assert_eq!(decode(&out[..cut]), Ok(None), "cut at {cut}");
        }
    }

    #[test]
    fn rejects_a_frame_over_the_cap() {
        let mut head = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
        head.push(1);
        assert_eq!(decode(&head), Err(ProtoError::TooLarge(MAX_FRAME + 1)));
    }

    #[test]
    fn rejects_an_unknown_kind() {
        let mut head = 1u32.to_le_bytes().to_vec();
        head.push(9);
        assert_eq!(decode(&head), Err(ProtoError::BadKind(9)));
    }

    #[test]
    fn rejects_an_output_frame_with_no_session_id() {
        let mut head = 3u32.to_le_bytes().to_vec();
        head.extend_from_slice(&[1, 0, 0]);
        assert_eq!(decode(&head), Err(ProtoError::Short));
    }

    #[test]
    fn messages_survive_json() {
        let m = ClientMsg::Spawn {
            req: 4,
            kind: SpawnKind::Shell { path: "/bin/zsh".into() },
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
        };
        let s = serde_json::to_vec(&m).unwrap();
        assert_eq!(serde_json::from_slice::<ClientMsg>(&s).unwrap(), m);

        let a = ClientMsg::Attach { id: None };
        let s = serde_json::to_vec(&a).unwrap();
        assert_eq!(serde_json::from_slice::<ClientMsg>(&s).unwrap(), a);

        let e = ServerMsg::Exit { id: 1, code: Some(130) };
        let s = serde_json::to_vec(&e).unwrap();
        assert_eq!(serde_json::from_slice::<ServerMsg>(&s).unwrap(), e);
    }
}
