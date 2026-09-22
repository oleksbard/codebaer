/// A shell-integration mark, or a bell. `133;B` (input start) is emitted by the scripts in
/// `shells` for convention's sake but carries no state this app needs, so it is not reported.
#[derive(Debug, Clone, PartialEq)]
pub enum Mark {
    PromptStart,
    CommandStart(String),
    CommandEnd(Option<i32>),
    Bell,
}

/// Beyond this an OSC payload is assumed to be a stream that never terminates its sequence,
/// and is abandoned so a malformed program cannot grow the daemon without bound.
const MAX_PAYLOAD: usize = 4096;

#[derive(Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

pub struct Scanner {
    state: State,
    payload: Vec<u8>,
}

impl Default for Scanner {
    fn default() -> Self {
        Scanner::new()
    }
}

impl Scanner {
    pub fn new() -> Scanner {
        Scanner { state: State::Ground, payload: Vec::new() }
    }

    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<Mark>) {
        for &b in bytes {
            match self.state {
                State::Ground => match b {
                    0x1b => self.state = State::Esc,
                    0x07 => out.push(Mark::Bell),
                    _ => {}
                },
                State::Esc => match b {
                    b']' => {
                        self.payload.clear();
                        self.state = State::Osc;
                    }
                    0x1b => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    0x07 => self.finish(out),
                    0x1b => self.state = State::OscEsc,
                    _ if self.payload.len() >= MAX_PAYLOAD => {
                        self.payload.clear();
                        self.state = State::Ground;
                    }
                    _ => self.payload.push(b),
                },
                State::OscEsc => {
                    match b {
                        b'\\' => self.finish(out),
                        0x1b => {
                            self.payload.clear();
                            self.state = State::Esc;
                        }
                        _ => {
                            self.payload.clear();
                            self.state = State::Ground;
                        }
                    };
                }
            }
        }
    }

    fn finish(&mut self, out: &mut Vec<Mark>) {
        let payload = String::from_utf8_lossy(&self.payload).into_owned();
        self.payload.clear();
        self.state = State::Ground;
        let Some(rest) = payload.strip_prefix("133;") else { return };
        // split at the first separator only, so a command containing one arrives whole
        let (letter, arg) = match rest.split_once(';') {
            Some((l, a)) => (l, Some(a)),
            None => (rest, None),
        };
        match letter {
            "A" => out.push(Mark::PromptStart),
            "C" => out.push(Mark::CommandStart(arg.unwrap_or_default().to_string())),
            "D" => out.push(Mark::CommandEnd(arg.and_then(|a| a.parse().ok()))),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunks: &[&[u8]]) -> Vec<Mark> {
        let mut s = Scanner::new();
        let mut out = Vec::new();
        for c in chunks {
            s.feed(c, &mut out);
        }
        out
    }

    #[test]
    fn reads_a_whole_prompt_cycle() {
        assert_eq!(
            scan(&[b"\x1b]133;A\x07$ \x1b]133;B\x07\x1b]133;C;ls -la\x07out\r\n\x1b]133;D;0\x07"]),
            vec![Mark::PromptStart, Mark::CommandStart("ls -la".into()), Mark::CommandEnd(Some(0))]
        );
    }

    #[test]
    fn a_command_containing_a_semicolon_survives_whole() {
        assert_eq!(
            scan(&[b"\x1b]133;C;for f in a; do echo $f; done\x07"]),
            vec![Mark::CommandStart("for f in a; do echo $f; done".into())]
        );
    }

    #[test]
    fn a_command_start_with_no_command_field_is_empty() {
        assert_eq!(scan(&[b"\x1b]133;C\x07"]), vec![Mark::CommandStart(String::new())]);
    }

    #[test]
    fn an_undeterminable_exit_code_is_none() {
        assert_eq!(scan(&[b"\x1b]133;D\x07"]), vec![Mark::CommandEnd(None)]);
        assert_eq!(scan(&[b"\x1b]133;D;\x07"]), vec![Mark::CommandEnd(None)]);
        assert_eq!(scan(&[b"\x1b]133;D;wat\x07"]), vec![Mark::CommandEnd(None)]);
    }

    #[test]
    fn reads_a_nonzero_exit_code() {
        assert_eq!(scan(&[b"\x1b]133;D;130\x07"]), vec![Mark::CommandEnd(Some(130))]);
    }

    #[test]
    fn accepts_the_string_terminator_as_well_as_bel() {
        assert_eq!(scan(&[b"\x1b]133;A\x1b\\"]), vec![Mark::PromptStart]);
    }

    #[test]
    fn a_sequence_split_across_reads_is_still_parsed() {
        assert_eq!(
            scan(&[b"\x1b]13", b"3;C;pnpm ", b"test\x07"]),
            vec![Mark::CommandStart("pnpm test".into())]
        );
    }

    #[test]
    fn the_bel_that_ends_a_sequence_is_not_a_bell() {
        assert_eq!(scan(&[b"\x1b]133;A\x07"]), vec![Mark::PromptStart]);
        assert_eq!(scan(&[b"\x1b]0;a title\x07"]), vec![]);
    }

    #[test]
    fn a_bare_bel_is_a_bell() {
        assert_eq!(scan(&[b"done\x07"]), vec![Mark::Bell]);
        assert_eq!(scan(&[b"\x1b]133;A\x07\x07"]), vec![Mark::PromptStart, Mark::Bell]);
    }

    #[test]
    fn other_osc_sequences_are_ignored() {
        assert_eq!(scan(&[b"\x1b]0;title\x07\x1b]7;file:///tmp\x07\x1b]133;A\x07"]), vec![Mark::PromptStart]);
    }

    #[test]
    fn an_unterminated_payload_is_abandoned_and_the_scanner_recovers() {
        let mut long = b"\x1b]133;C;".to_vec();
        long.extend(std::iter::repeat(b'x').take(MAX_PAYLOAD * 2));
        assert_eq!(scan(&[&long, b"\x1b]133;A\x07"]), vec![Mark::PromptStart]);
    }

    #[test]
    fn a_malformed_escape_inside_a_payload_does_not_wedge_the_scanner() {
        assert_eq!(scan(&[b"\x1b]133;C;x\x1bZ", b"\x1b]133;A\x07"]), vec![Mark::PromptStart]);
    }
}
