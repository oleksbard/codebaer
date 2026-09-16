use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
pub struct Status {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub index_status: char,
    pub worktree_status: char,
    pub untracked: bool,
    pub conflicted: bool,
}

pub fn parse(bytes: &[u8]) -> Status {
    let mut st = Status::default();
    let mut recs = bytes
        .split(|&b| b == 0)
        .map(|r| String::from_utf8_lossy(r).into_owned())
        .collect::<Vec<_>>()
        .into_iter();
    while let Some(rec) = recs.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" => st.head = (v != "(initial)").then(|| v.to_string()),
                "branch.head" => st.branch = (v != "(detached)").then(|| v.to_string()),
                "branch.ab" => {
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        match rec.as_bytes()[0] {
            b'1' => {
                let (x, y, path) = fields(&rec, 8);
                if !path.is_empty() {
                    push(&mut st, path, x, y, false, false);
                }
            }
            b'2' => {
                let (_, y, new_path) = fields(&rec, 9);
                let old_path = recs.next().unwrap_or_default();
                if new_path.is_empty() || old_path.is_empty() {
                    continue;
                }
                push(&mut st, &old_path, 'D', '.', false, false);
                push(&mut st, new_path, 'A', y, false, false);
            }
            b'u' => {
                let (x, y, path) = fields(&rec, 10);
                if !path.is_empty() {
                    push(&mut st, path, x, y, false, true);
                }
            }
            b'?' => {
                let path = rec.get(2..).unwrap_or("");
                if !path.is_empty() {
                    push(&mut st, path, '.', '.', true, false);
                }
            }
            _ => {}
        }
    }
    st
}

/// Porcelain v2 puts the path after a fixed number of space-separated fields; paths may contain spaces.
fn fields(rec: &str, n: usize) -> (char, char, &str) {
    if rec.len() < 4 {
        return ('.', '.', "");
    }
    // get(), not a slice: from_utf8_lossy can leave a multi-byte char straddling
    // byte 2 or 4 when the stream was truncated, and indexing there panics.
    let mut chars = rec.get(2..4).unwrap_or("..").chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let mut seen = 0;
    let mut start = rec.len();
    for (i, ch) in rec.char_indices() {
        if ch == ' ' {
            seen += 1;
            if seen == n {
                start = i + 1;
                break;
            }
        }
    }
    (x, y, &rec[start..])
}

fn push(st: &mut Status, path: &str, x: char, y: char, untracked: bool, conflicted: bool) {
    // git emits at most one record per path, except a staged deletion (`1 D.`) followed by the recreated file's `?` line, which is the case merged here.
    if let Some(e) = st.files.iter_mut().find(|e| e.path == path) {
        if untracked {
            e.untracked = true;
        } else {
            e.index_status = x;
            e.worktree_status = y;
            e.conflicted = conflicted;
        }
        return;
    }
    st.files.push(FileEntry { path: path.to_string(), index_status: x, worktree_status: y, untracked, conflicted });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(recs: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for r in recs {
            v.extend_from_slice(r.as_bytes());
            v.push(0);
        }
        v
    }

    const H: &str = "1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ";

    #[test]
    fn parses_branch_headers() {
        let s = parse(&z(&["# branch.oid 1234567890123456789012345678901234567890", "# branch.head main",
                          "# branch.upstream origin/main", "# branch.ab +2 -1"]));
        assert_eq!(s.head.as_deref(), Some("1234567890123456789012345678901234567890"));
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
    }

    #[test]
    fn unborn_and_detached_and_no_upstream() {
        let s = parse(&z(&["# branch.oid (initial)", "# branch.head (detached)"]));
        assert_eq!(s.head, None);
        assert_eq!(s.branch, None);
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn ordinary_untracked_and_conflicted_entries() {
        let s = parse(&z(&[&format!("{H}src/a b.txt"), "? new.txt",
            "u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc c.txt"]));
        assert_eq!(s.files[0], FileEntry { path: "src/a b.txt".into(), index_status: '.', worktree_status: 'M', untracked: false, conflicted: false });
        assert_eq!(s.files[1], FileEntry { path: "new.txt".into(), index_status: '.', worktree_status: '.', untracked: true, conflicted: false });
        assert_eq!(s.files[2], FileEntry { path: "c.txt".into(), index_status: 'U', worktree_status: 'U', untracked: false, conflicted: true });
    }

    #[test]
    fn rename_becomes_two_entries() {
        let s = parse(&z(&["2 RM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new.txt", "old.txt"]));
        assert_eq!(s.files.len(), 2);
        assert_eq!((s.files[0].path.as_str(), s.files[0].index_status, s.files[0].worktree_status), ("old.txt", 'D', '.'));
        assert_eq!((s.files[1].path.as_str(), s.files[1].index_status, s.files[1].worktree_status), ("new.txt", 'A', 'M'));
    }

    #[test]
    fn staged_deletion_plus_recreated_file_is_one_entry() {
        let s = parse(&z(&["1 D. N... 100644 000000 000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0000000000000000000000000000000000000000 x.txt", "? x.txt"]));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0], FileEntry { path: "x.txt".into(), index_status: 'D', worktree_status: '.', untracked: true, conflicted: false });
    }

    #[test]
    fn keeps_quotes_and_non_ascii_verbatim() {
        let s = parse(&z(&[&format!("{H}quote\"and\\back.txt"), &format!("{H}ümläut.txt")]));
        assert_eq!(s.files[0].path, "quote\"and\\back.txt");
        assert_eq!(s.files[1].path, "ümläut.txt");
    }

    #[test]
    fn truncated_record_is_skipped() {
        // Truncated records with empty paths are skipped without panic
        let s = parse(&z(&["1 .", "? ", &format!("{H}valid.txt")]));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].path, "valid.txt");

        // One-character untracked filename is parsed correctly
        let s = parse(&z(&["? a"]));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0], FileEntry { path: "a".into(), index_status: '.', worktree_status: '.', untracked: true, conflicted: false });
    }

    #[test]
    fn truncated_rename_keeps_the_stream_aligned() {
        // the old path is itself a well-formed `1` record, so a parser that does not
        // consume it as the rename's second field adds a bogus entry for it
        let s = parse(&z(&["2 R. N... 100644 100644 100644", &format!("{H}old.txt"), &format!("{H}after.txt")]));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0], FileEntry { path: "after.txt".into(), index_status: '.', worktree_status: 'M', untracked: false, conflicted: false });
    }

    #[test]
    fn bare_question_mark_record_is_skipped() {
        let s = parse(&z(&["?", &format!("{H}ok.txt")]));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].path, "ok.txt");
    }
}
