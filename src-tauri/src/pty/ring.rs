/// Private modes whose value must survive a wrapped replay, in the order they are re-emitted.
/// Alt screen comes first so the switch happens before any replayed content is drawn.
const TRACKED: [(u16, bool); 11] = [
    (1049, false), // alt screen
    (1047, false),
    (47, false),
    (25, true), // cursor visible
    (2004, false), // bracketed paste
    (1, false), // application cursor keys
    (1000, false), // mouse modes
    (1002, false),
    (1003, false),
    (1006, false),
    (1015, false),
];

#[derive(Debug)]
enum Scan {
    Ground,
    Esc,
    Csi,
    Priv(u16, Vec<u16>),
}

/// A fixed byte ring plus the private-mode state needed to replay it after it wraps.
pub struct Ring {
    buf: Box<[u8]>,
    pos: usize,
    wrapped: bool,
    modes: [bool; TRACKED.len()],
    scan: Scan,
}

/// A newline this far past the cut is treated as absent: dropping more than this to find a
/// clean line boundary would cost more history than the ragged first line is worth.
const NEWLINE_SEARCH: usize = 4096;

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring {
            buf: vec![0u8; cap.max(1)].into_boxed_slice(),
            pos: 0,
            wrapped: false,
            modes: TRACKED.map(|(_, default)| default),
            scan: Scan::Ground,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        // every byte is scanned, including the ones about to be overwritten: their modes outlive them
        for &b in bytes {
            self.feed(b);
        }
        let cap = self.buf.len();
        let src = if bytes.len() >= cap {
            self.wrapped = true;
            &bytes[bytes.len() - cap..]
        } else {
            bytes
        };
        let head = (cap - self.pos).min(src.len());
        self.buf[self.pos..self.pos + head].copy_from_slice(&src[..head]);
        if head < src.len() {
            self.buf[..src.len() - head].copy_from_slice(&src[head..]);
        }
        // >= not >: a push that ends exactly on capacity has filled the ring, and pos wrapping
        // to 0 without this would make replay() return the empty head of a full buffer
        if self.pos + src.len() >= cap {
            self.wrapped = true;
        }
        self.pos = (self.pos + src.len()) % cap;
    }

    /// The bytes a freshly attached client must receive to arrive at this session's current screen.
    pub fn replay(&self) -> Vec<u8> {
        if !self.wrapped {
            return self.buf[..self.pos].to_vec();
        }
        let mut content = Vec::with_capacity(self.buf.len());
        content.extend_from_slice(&self.buf[self.pos..]);
        content.extend_from_slice(&self.buf[..self.pos]);
        // the cut lands anywhere, including inside an escape sequence; a newline cannot, so
        // starting after one is what keeps the replay from being parsed as sequence parameters
        let start = content[..content.len().min(NEWLINE_SEARCH)]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(0, |i| i + 1);
        let mut out = b"\x1b[0m".to_vec();
        for (i, (code, default)) in TRACKED.iter().enumerate() {
            if self.modes[i] != *default {
                out.extend_from_slice(format!("\x1b[?{code}{}", if self.modes[i] { 'h' } else { 'l' }).as_bytes());
            }
        }
        out.extend_from_slice(&content[start..]);
        out
    }

    pub fn wrapped(&self) -> bool {
        self.wrapped
    }

    fn feed(&mut self, b: u8) {
        self.scan = match (std::mem::replace(&mut self.scan, Scan::Ground), b) {
            (_, 0x1b) => Scan::Esc,
            (Scan::Esc, b'[') => Scan::Csi,
            (Scan::Csi, b'?') => Scan::Priv(0, Vec::new()),
            (Scan::Priv(cur, params), b'0'..=b'9') => {
                Scan::Priv(cur.saturating_mul(10).saturating_add((b - b'0') as u16), params)
            }
            (Scan::Priv(cur, mut params), b';') => {
                params.push(cur);
                Scan::Priv(0, params)
            }
            (Scan::Priv(cur, mut params), set @ (b'h' | b'l')) => {
                params.push(cur);
                for code in params {
                    if let Some(i) = TRACKED.iter().position(|(c, _)| *c == code) {
                        self.modes[i] = set == b'h';
                    }
                }
                Scan::Ground
            }
            _ => Scan::Ground,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ESC: u8 = 0x1b;

    #[test]
    fn replays_an_unwrapped_ring_byte_for_byte() {
        let mut r = Ring::new(64);
        r.push(b"hello ");
        r.push(b"world");
        assert!(!r.wrapped());
        assert_eq!(r.replay(), b"hello world".to_vec());
    }

    #[test]
    fn an_empty_ring_replays_nothing() {
        assert_eq!(Ring::new(64).replay(), Vec::<u8>::new());
    }

    #[test]
    fn a_wrapped_replay_starts_after_a_newline() {
        let mut r = Ring::new(16);
        r.push(b"aaaa\nbbbb\ncccc\ndddd\n");
        assert!(r.wrapped());
        let out = r.replay();
        let text = String::from_utf8_lossy(&out).to_string();
        // the cut lands mid-line, so the first partial line is dropped rather than shown truncated
        assert!(text.ends_with("cccc\ndddd\n"), "{text:?}");
        assert!(!text.contains("aaaa"), "{text:?}");
    }

    #[test]
    fn a_wrapped_replay_reinstates_the_alt_screen() {
        let mut r = Ring::new(16);
        r.push(b"\x1b[?1049h");
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        let out = r.replay();
        assert!(out.starts_with(&[ESC, b'[', b'0', b'm']), "expected an SGR reset first");
        assert!(find(&out, b"\x1b[?1049h").is_some(), "alt screen must be restored");
    }

    #[test]
    fn a_wrapped_replay_omits_modes_left_at_their_default() {
        let mut r = Ring::new(16);
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        let out = r.replay();
        assert!(find(&out, b"\x1b[?1049").is_none(), "alt screen was never set");
        assert!(find(&out, b"\x1b[?25").is_none(), "cursor visibility is at its default");
        assert!(find(&out, b"\x1b[?2004").is_none());
    }

    #[test]
    fn a_wrapped_replay_restores_a_hidden_cursor() {
        let mut r = Ring::new(16);
        r.push(b"\x1b[?25l");
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        assert!(find(&r.replay(), b"\x1b[?25l").is_some());
    }

    #[test]
    fn a_mode_turned_back_off_is_not_restored() {
        let mut r = Ring::new(16);
        r.push(b"\x1b[?1049h");
        r.push(b"\x1b[?1049l");
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        assert!(find(&r.replay(), b"\x1b[?1049").is_none());
    }

    #[test]
    fn tracks_a_mode_sequence_split_across_pushes() {
        let mut r = Ring::new(16);
        r.push(b"\x1b[?10");
        r.push(b"49");
        r.push(b"h");
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        assert!(find(&r.replay(), b"\x1b[?1049h").is_some());
    }

    #[test]
    fn tracks_several_modes_set_by_one_sequence() {
        let mut r = Ring::new(16);
        r.push(b"\x1b[?1000;1006h");
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        let out = r.replay();
        assert!(find(&out, b"\x1b[?1000h").is_some());
        assert!(find(&out, b"\x1b[?1006h").is_some());
    }

    #[test]
    fn an_aborted_escape_sequence_does_not_set_a_mode() {
        let mut r = Ring::new(16);
        r.push(b"\x1b[?1049");
        r.push(b"x");
        r.push(b"aaaa\nbbbb\ncccc\ndddd\neeee\n");
        assert!(find(&r.replay(), b"\x1b[?1049").is_none());
    }

    #[test]
    fn a_push_larger_than_the_ring_keeps_the_tail_and_still_scans_modes() {
        let mut r = Ring::new(8);
        let mut big = b"\x1b[?25l".to_vec();
        big.extend_from_slice(b"0123456789\nabcdefgh");
        r.push(&big);
        assert!(r.wrapped());
        let out = r.replay();
        assert!(find(&out, b"\x1b[?25l").is_some(), "modes before the cut must survive");
        assert!(find(&out, b"abcdefgh").is_some());
        assert!(find(&out, b"01234").is_none());
    }

    #[test]
    fn a_wrapped_ring_with_no_newline_replays_all_of_its_contents() {
        let mut r = Ring::new(8);
        r.push(b"aaaaaaaaaabbbbbb");
        // 16 bytes into an 8 byte ring leaves the last 8, and a wrapped replay always
        // opens with the SGR reset even when no tracked mode moved
        assert_eq!(r.replay(), b"\x1b[0maabbbbbb".to_vec());
    }

    #[test]
    fn a_push_that_lands_exactly_on_capacity_has_still_wrapped() {
        let mut r = Ring::new(8);
        r.push(b"abcd");
        r.push(b"efgh");
        assert!(r.wrapped(), "the ring is full; pos landing on 0 is not the same as being empty");
        assert_eq!(r.replay(), b"\x1b[0mabcdefgh".to_vec());
    }

    #[test]
    fn a_ring_filled_by_exact_sized_reads_replays_its_contents() {
        // the daemon reads in 64 KiB chunks into a 4 MiB ring, so landing exactly on capacity
        // is what a fast producer does routinely, not an edge case
        let mut r = Ring::new(4 * 64);
        for _ in 0..4 {
            r.push(&[b'x'; 64]);
        }
        assert!(r.wrapped());
        assert_eq!(r.replay().len(), 4 + 4 * 64);
    }

    #[test]
    fn a_cut_with_no_newline_within_reach_is_replayed_whole() {
        let mut r = Ring::new(4096);
        r.push(&vec![b'x'; 5000]);
        let out = r.replay();
        assert_eq!(out.len(), 4 + 4096, "nothing may be dropped hunting a newline that is not there");
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }
}
