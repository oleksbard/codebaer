use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

pub fn detect(bytes: &[u8]) -> Eol {
    match bytes.iter().position(|&b| b == b'\n') {
        Some(i) if i > 0 && bytes[i - 1] == b'\r' => Eol::Crlf,
        _ => Eol::Lf,
    }
}

pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn apply(text: &str, eol: Eol) -> String {
    match eol {
        Eol::Lf => text.to_string(),
        Eol::Crlf => text.replace('\n', "\r\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_from_first_line_break() {
        assert_eq!(detect(b"a\r\nb\nc"), Eol::Crlf);
        assert_eq!(detect(b"a\nb\r\n"), Eol::Lf);
        assert_eq!(detect(b"no breaks"), Eol::Lf);
        assert_eq!(detect(b""), Eol::Lf);
    }

    #[test]
    fn normalize_makes_every_break_lf() {
        assert_eq!(normalize("a\r\nb\rc\nd"), "a\nb\nc\nd");
    }

    #[test]
    fn apply_round_trips_crlf() {
        assert_eq!(apply("a\nb\n", Eol::Crlf), "a\r\nb\r\n");
        assert_eq!(apply("a\nb\n", Eol::Lf), "a\nb\n");
        assert_eq!(normalize(&apply("x\ny", Eol::Crlf)), "x\ny");
    }
}
