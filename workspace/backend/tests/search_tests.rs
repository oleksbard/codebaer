use codebaer_lib::search::{search_impl, FileHits, MAX_HITS};
use codebaer_lib::AppError;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tempfile::TempDir;

fn repo(files: &[(&str, &str)]) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new("git").args(["init", "-q"]).current_dir(dir.path()).output().unwrap();
    assert!(out.status.success());
    for (path, text) in files {
        let p = dir.path().join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    dir
}

/// The files found, sorted by path, each with its hits' line numbers.
fn find(root: &Path, query: &str, include: &str) -> Result<(Vec<FileHits>, bool), AppError> {
    let mut all = Vec::new();
    let truncated = search_impl(root, query, include, &|| true, |files| all.extend(files))?;
    all.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((all, truncated))
}

fn paths(found: &[FileHits]) -> Vec<&str> {
    found.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn finds_each_matching_line_with_its_line_number_and_ranges() {
    let r = repo(&[("src/a.ts", "const total = 1;\nlet x = total + total;\n"), ("b.md", "nothing here\n")]);
    let (found, truncated) = find(r.path(), "total", "").unwrap();
    assert!(!truncated);
    assert_eq!(paths(&found), ["src/a.ts"]);
    let hits = &found[0].hits;
    assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(hits[1].text, "let x = total + total;");
    assert_eq!(hits[1].ranges, vec![[8, 13], [16, 21]]);
    assert_eq!(hits[1].col, 8);
}

#[test]
fn ignores_case_unless_the_query_has_a_capital() {
    let r = repo(&[("a.txt", "Needle\nneedle\nNEEDLE\n")]);
    let lines = |q: &str| -> Vec<u64> {
        find(r.path(), q, "").unwrap().0.first().map(|f| f.hits.iter().map(|h| h.line).collect()).unwrap_or_default()
    };
    assert_eq!(lines("needle"), [1, 2, 3]);
    assert_eq!(lines("Needle"), [1]);
}

#[test]
fn the_query_is_literal_text_not_a_pattern() {
    let r = repo(&[("a.txt", "a.b\naxb\n(x)\n")]);
    let (found, _) = find(r.path(), "a.b", "").unwrap();
    assert_eq!(found[0].hits.iter().map(|h| h.line).collect::<Vec<_>>(), [1]);
    assert_eq!(paths(&find(r.path(), "(x", "").unwrap().0), ["a.txt"]);
}

#[test]
fn skips_ignored_files_the_git_dir_and_binary_files_but_not_hidden_ones() {
    let r = repo(&[
        (".gitignore", "dist/\n*.log\n"),
        ("dist/out.js", "needle\n"),
        ("debug.log", "needle\n"),
        ("logo.bin", "needle\0\x01\x02"),
        (".config/tool.json", "needle\n"),
        ("src/a.ts", "needle\n"),
    ]);
    fs::write(r.path().join(".git/needle-note"), "needle\n").unwrap();
    let (found, _) = find(r.path(), "needle", "").unwrap();
    assert_eq!(paths(&found), [".config/tool.json", "src/a.ts"]);
}

#[test]
fn searches_only_the_folders_and_globs_given() {
    let r = repo(&[
        (".gitignore", "node_modules/\n"),
        ("src/ui/node_modules/dep/index.ts", "needle\n"),
        ("src/ui/a.ts", "needle\n"),
        ("src/ui/b.css", "needle\n"),
        ("src/core/c.ts", "needle\n"),
        ("packages/x/src/d.ts", "needle\n"),
        ("e.ts", "needle\n"),
    ]);
    let found = |include: &str| -> Vec<String> {
        find(r.path(), "needle", include).unwrap().0.into_iter().map(|f| f.path).collect()
    };
    // a folder given here still leaves out what .gitignore leaves out below it
    assert_eq!(found("src/ui"), ["src/ui/a.ts", "src/ui/b.css"]);
    assert_eq!(found("./src/ui/"), ["src/ui/a.ts", "src/ui/b.css"]);
    assert_eq!(found("*.ts"), ["e.ts", "packages/x/src/d.ts", "src/core/c.ts", "src/ui/a.ts"]);
    assert_eq!(found("src/*.ts"), Vec::<String>::new());
    assert_eq!(found("src/**/*.ts"), ["src/core/c.ts", "src/ui/a.ts"]);
    // a name with no slash is a folder at any depth, as in .gitignore
    assert_eq!(found("src"), ["packages/x/src/d.ts", "src/core/c.ts", "src/ui/a.ts", "src/ui/b.css"]);
    assert_eq!(found("src/core, e.ts"), ["e.ts", "src/core/c.ts"]);
    assert_eq!(found("/src"), ["src/core/c.ts", "src/ui/a.ts", "src/ui/b.css"]);
    assert_eq!(found("./src"), ["src/core/c.ts", "src/ui/a.ts", "src/ui/b.css"]);
    assert_eq!(found("src/{core,ui}/*.ts"), ["src/core/c.ts", "src/ui/a.ts"]);
    assert!(matches!(find(r.path(), "needle", "src/{a"), Err(AppError::InvalidPath(_))));
    assert!(matches!(find(r.path(), "needle", "src}"), Err(AppError::InvalidPath(_))));
    assert_eq!(found("src/\\*.ts"), Vec::<String>::new());
}

#[test]
fn stops_at_the_cap_and_says_so() {
    let r = repo(&[("big.txt", &"needle\n".repeat(MAX_HITS + 50))]);
    let (found, truncated) = find(r.path(), "needle", "").unwrap();
    assert!(truncated);
    assert_eq!(found.iter().map(|f| f.hits.len()).sum::<usize>(), MAX_HITS);
}

#[test]
fn exactly_the_cap_is_not_cut() {
    let r = repo(&[("a.txt", &"needle\n".repeat(MAX_HITS - 1)), ("b.txt", "needle\n")]);
    let (found, truncated) = find(r.path(), "needle", "").unwrap();
    assert!(!truncated);
    assert_eq!(found.iter().map(|f| f.hits.len()).sum::<usize>(), MAX_HITS);
}

#[test]
fn a_search_that_is_no_longer_current_reports_nothing() {
    let files: Vec<(String, &str)> = (0..200).map(|i| (format!("f{i}.txt"), "needle\n")).collect();
    let refs: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), *t)).collect();
    let r = repo(&refs);
    let live = AtomicBool::new(false);
    let mut got = 0;
    search_impl(r.path(), "needle", "", &|| live.load(Ordering::Relaxed), |files| got += files.len()).unwrap();
    assert_eq!(got, 0);
}

#[test]
fn a_bom_does_not_shift_line_one_and_a_file_too_large_to_open_is_skipped() {
    let big = format!("needle\n{}", "x".repeat(codebaer_lib::git::MAX_BYTES as usize));
    let r = repo(&[("bom.txt", "\u{feff}a needle\n"), ("big.txt", &big)]);
    let (found, _) = find(r.path(), "needle", "").unwrap();
    assert_eq!(paths(&found), ["bom.txt"]);
    // the editor counts the BOM as a character of line 1
    assert_eq!(found[0].hits[0].col, 3);
}
