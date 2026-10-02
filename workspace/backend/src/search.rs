use crate::error::AppError;
use crate::git::{AppState, MAX_BYTES};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::Lossy, BinaryDetection, SearcherBuilder};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

/// Matching lines a search reports at most, as VS Code does; past it the UI says the list is cut short.
pub const MAX_HITS: usize = 20_000;
/// Bytes of a line kept for its preview, and how many of them go before the first match.
const PREVIEW: usize = 240;
const LEAD: usize = 12;
/// How often found files go to the UI: one message per file would be thousands for a common word.
const FLUSH: Duration = Duration::from_millis(40);

/// `col` is the first match's column and `ranges` are the matches in `text`, both in UTF-16 units as the editor
/// counts them. `cut` is true when `text` starts past something other than indentation.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit {
    pub line: u64,
    pub col: u32,
    pub text: String,
    pub ranges: Vec<[u32; 2]>,
    pub cut: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileHits {
    pub path: String,
    pub hits: Vec<Hit>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "t")]
pub enum SearchMsg {
    Files { files: Vec<FileHits> },
    Done { truncated: bool },
}

/// The highest run id seen. The frontend numbers its searches, since two invokes can start in either order: a
/// search whose id is no longer the highest stops at its next line.
static LATEST: AtomicU64 = AtomicU64::new(0);

/// Searches the working tree for `query` and streams the files that hold it to `out`, then a `Done`. An empty
/// query only stops the search before it.
#[tauri::command(async)]
pub fn search(
    state: State<AppState>,
    query: String,
    include: String,
    run: u64,
    out: Channel<SearchMsg>,
) -> Result<(), AppError> {
    if LATEST.fetch_max(run, Ordering::SeqCst) > run || query.is_empty() {
        return Ok(());
    }
    let root = state.root()?;
    let current = || LATEST.load(Ordering::Relaxed) == run;
    let truncated = search_impl(&root, &query, &include, &current, |files| {
        let _ = out.send(SearchMsg::Files { files });
    })?;
    if current() {
        let _ = out.send(SearchMsg::Done { truncated });
    }
    Ok(())
}

/// Returns whether the search stopped at `MAX_HITS`. Literal and smart case: a query with no capital letter
/// ignores case. Honours .gitignore, the repo's exclude file and the global one; hidden files are searched, `.git`,
/// binary files and files too large for the editor to open are not.
pub fn search_impl(
    root: &Path,
    query: &str,
    include: &str,
    current: &(dyn Fn() -> bool + Sync),
    mut emit: impl FnMut(Vec<FileHits>),
) -> Result<bool, AppError> {
    let matcher = RegexMatcherBuilder::new()
        .fixed_strings(true)
        .case_smart(true)
        .line_terminator(Some(b'\n'))
        .build(query)
        .map_err(|e| AppError::InvalidPath(e.to_string()))?;
    let only = includes(include)?;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .max_filesize(Some(MAX_BYTES))
        .filter_entry(|e| e.file_name() != ".git")
        .build_parallel();
    let found = AtomicUsize::new(0);
    let (tx, rx) = channel::<FileHits>();
    std::thread::scope(|s| {
        s.spawn(|| {
            walker.run(|| {
                let tx = tx.clone();
                let matcher = matcher.clone();
                let found = &found;
                let only = &only;
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(b'\x00'))
                    // the editor keeps a BOM as a character, so a stripped one would put line 1's columns off by one
                    .bom_sniffing(false)
                    .line_number(true)
                    .build();
                Box::new(move |entry| {
                    // one hit past the cap is what tells a search that stopped from one that ended at it
                    if !current() || found.load(Ordering::Relaxed) > MAX_HITS {
                        return WalkState::Quit;
                    }
                    let Ok(entry) = entry else { return WalkState::Continue };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    let path = entry.path().strip_prefix(root).unwrap_or(entry.path());
                    if only.as_ref().is_some_and(|set| !set.is_match(path)) {
                        return WalkState::Continue;
                    }
                    let mut hits = Vec::new();
                    let sink = Lossy(|line_no, line| {
                        let mut ranges = Vec::new();
                        matcher.find_iter(line.as_bytes(), |m| {
                            ranges.push((m.start(), m.end()));
                            true
                        })?;
                        hits.push(hit(line_no, line, &ranges));
                        Ok(current() && found.load(Ordering::Relaxed) + hits.len() <= MAX_HITS)
                    });
                    // an unreadable file, or one that turns out binary, simply has no hits
                    let _ = searcher.search_path(&matcher, entry.path(), sink);
                    if hits.is_empty() {
                        return WalkState::Continue;
                    }
                    let before = found.fetch_add(hits.len(), Ordering::Relaxed);
                    hits.truncate(MAX_HITS.saturating_sub(before));
                    if hits.is_empty() {
                        return WalkState::Quit;
                    }
                    let _ = tx.send(FileHits { path: path.to_string_lossy().into_owned(), hits });
                    WalkState::Continue
                })
            });
            drop(tx);
        });
        let mut batch = Vec::new();
        let mut sent = Instant::now();
        loop {
            match rx.recv_timeout(FLUSH) {
                Ok(f) => batch.push(f),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !batch.is_empty() && sent.elapsed() >= FLUSH && current() {
                emit(std::mem::take(&mut batch));
                sent = Instant::now();
            }
        }
        if !batch.is_empty() && current() {
            emit(batch);
        }
    });
    Ok(found.load(Ordering::Relaxed) > MAX_HITS)
}

/// The folders and globs to search, comma-separated, with git's pattern rules: a name with no slash matches at any
/// depth, one with a slash (a leading one, or `./`, too) from the root, and `*` stays inside one folder. Each also
/// takes everything under it, so `src/ui` is that folder. A filter on the walk, not an override: the `ignore` crate lets an override win over
/// .gitignore, and `src` would then search every `node_modules` below it.
fn includes(include: &str) -> Result<Option<GlobSet>, AppError> {
    let mut b = GlobSetBuilder::new();
    let mut any = false;
    for raw in patterns(include) {
        let raw = raw.trim();
        let p = raw.trim_start_matches("./").trim_end_matches('/');
        let anchored = raw.starts_with("./") || p.contains('/');
        let p = p.trim_start_matches('/');
        if p.is_empty() {
            continue;
        }
        let pats = if anchored { [p.to_string(), format!("{p}/**")] } else { [format!("**/{p}"), format!("**/{p}/**")] };
        for pat in pats {
            let glob = GlobBuilder::new(&pat).literal_separator(true).build();
            b.add(glob.map_err(|e| AppError::InvalidPath(e.to_string()))?);
        }
        any = true;
    }
    if !any {
        return Ok(None);
    }
    b.build().map(Some).map_err(|e| AppError::InvalidPath(e.to_string()))
}

/// Splits at the commas outside braces, so `src/{a,b}` stays one pattern.
fn patterns(include: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut from) = (0i32, 0);
    for (i, c) in include.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth <= 0 => {
                out.push(&include[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(&include[from..]);
    out
}

fn floor(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn utf16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// One matching line, cut to a preview around its first match. `ranges` are byte offsets into `line`.
pub(crate) fn hit(line_no: u64, line: &str, ranges: &[(usize, usize)]) -> Hit {
    let line = line.trim_end_matches(['\n', '\r']);
    let first = floor(line, ranges.first().map_or(0, |r| r.0));
    let indent = line.len() - line.trim_start().len();
    let start = if first > LEAD + indent { floor(line, first - LEAD) } else { indent.min(first) };
    let end = floor(line, start + PREVIEW);
    let text = &line[start..end];
    let ranges = ranges
        .iter()
        .take_while(|r| r.0 < end)
        .map(|&(a, b)| {
            let a = floor(line, a.max(start)) - start;
            let b = floor(line, b.min(end)) - start;
            [utf16(&text[..a]), utf16(&text[..b])]
        })
        .collect();
    Hit { line: line_no, col: utf16(&line[..first]), text: text.to_string(), ranges, cut: start > indent }
}

#[cfg(test)]
mod tests {
    use super::{hit, includes, LEAD, PREVIEW};

    #[test]
    fn a_short_line_keeps_all_but_its_indentation() {
        let h = hit(3, "    let total = 0;\n", &[(8, 13)]);
        assert_eq!(h.text, "let total = 0;");
        assert_eq!(h.ranges, vec![[4, 9]]);
        assert_eq!((h.line, h.col, h.cut), (3, 8, false));
    }

    #[test]
    fn a_long_line_is_cut_to_a_window_around_its_first_match() {
        let line = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let h = hit(1, &line, &[(500, 506)]);
        assert!(h.cut);
        assert_eq!(h.text.len(), PREVIEW);
        assert_eq!(h.ranges, vec![[LEAD as u32, LEAD as u32 + 6]]);
        assert_eq!(h.col, 500);
    }

    #[test]
    fn columns_and_ranges_count_utf16_units_as_the_editor_does() {
        // the emoji is 4 bytes and 2 UTF-16 units, the é 2 bytes and 1 unit
        let line = "😀é x = needle;";
        let at = line.find("needle").unwrap();
        let h = hit(1, line, &[(at, at + 6)]);
        assert_eq!(h.col, 8);
        assert_eq!(h.ranges, vec![[8, 14]]);
    }

    #[test]
    fn matches_past_the_preview_are_dropped_and_one_across_its_end_is_clipped() {
        let line = format!("needle{}needle{}needle", "x".repeat(PREVIEW - 9), "y".repeat(400));
        let second = PREVIEW - 3;
        let third = line.rfind("needle").unwrap();
        let h = hit(1, &line, &[(0, 6), (second, second + 6), (third, third + 6)]);
        assert_eq!(h.ranges, vec![[0, 6], [second as u32, PREVIEW as u32]]);
    }

    #[test]
    fn an_empty_include_searches_everything_and_a_bad_glob_is_an_error() {
        assert!(includes(" , ").unwrap().is_none());
        assert!(includes("src/{a").is_err());
    }
}
