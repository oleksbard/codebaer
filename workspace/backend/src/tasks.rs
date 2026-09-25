use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::git::AppState;
use crate::pty::client::request_spawn;
use crate::pty::daemon::quote;
use crate::pty::proto::SpawnKind;
use crate::settings::{self, CustomCommand};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Script {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scripts {
    pub runner: &'static str,
    /// Sorted by name: serde_json keeps no key order without its `preserve_order` feature.
    pub scripts: Vec<Script>,
}

/// What the webview asks to run: a saved command, which must still be in the file as sent, or a
/// script, which must still be in package.json.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "t")]
pub enum Task {
    Custom(CustomCommand),
    Script { name: String },
}

const RUNNERS: [&str; 4] = ["pnpm", "yarn", "bun", "npm"];
const LOCKFILES: [(&str, &str); 5] = [
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
    ("package-lock.json", "npm"),
];

/// `packageManager` is what corepack would run, so it outranks a lockfile left behind by another one.
fn runner(root: &Path, pkg: &Map<String, Value>) -> &'static str {
    let declared = pkg.get("packageManager").and_then(Value::as_str).and_then(|pm| pm.split('@').next());
    if let Some(r) = RUNNERS.into_iter().find(|r| Some(*r) == declared) {
        return r;
    }
    LOCKFILES.iter().find(|(lock, _)| root.join(lock).is_file()).map_or("npm", |(_, r)| r)
}

/// None for a repository with no package.json, or one without scripts.
fn scripts_at(root: &Path) -> Result<Option<Scripts>, AppError> {
    let text = match std::fs::read_to_string(root.join("package.json")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::Io(format!("package.json: {e}"))),
    };
    let pkg: Map<String, Value> =
        serde_json::from_str(&text).map_err(|e| AppError::Io(format!("package.json: {e}")))?;
    let scripts: Vec<Script> = match pkg.get("scripts") {
        Some(Value::Object(s)) => s
            .iter()
            .filter_map(|(k, v)| Some(Script { name: k.clone(), command: v.as_str()?.to_string() }))
            .collect(),
        _ => Vec::new(),
    };
    Ok((!scripts.is_empty()).then(|| Scripts { runner: runner(root, &pkg), scripts }))
}

/// The shell line and the session title for `task`, read from the file and package.json as they are
/// now: the menu the webview picked from may be older than either.
fn plan(task: &Task, root: &Path, saved: &[CustomCommand]) -> Result<(String, String), AppError> {
    match task {
        Task::Custom(c) => {
            let here = c.repo.as_deref().is_none_or(|r| Path::new(r) == root);
            if !here || !saved.contains(c) {
                return Err(AppError::Io(format!("{} is no longer saved for this repository", c.command)));
            }
            let title = if c.name.trim().is_empty() { &c.command } else { &c.name };
            Ok((c.command.clone(), title.trim().to_string()))
        }
        Task::Script { name } => {
            let scripts = scripts_at(root)?;
            let Some(s) = scripts.filter(|s| s.scripts.iter().any(|x| &x.name == name)) else {
                return Err(AppError::Io(format!("package.json has no script named {name}")));
            };
            let line = format!("{} run {}", s.runner, quote(name));
            Ok((line, format!("{} {name}", s.runner)))
        }
    }
}

#[tauri::command(async)]
pub fn package_scripts(git: State<'_, AppState>) -> Result<Option<Scripts>, AppError> {
    scripts_at(&git.root()?)
}

/// Runs in the repository root, like a terminal; the reply is the spawn's `req`, as for `term_spawn`.
#[tauri::command(async)]
pub fn task_run(app: AppHandle, git: State<'_, AppState>, task: Task, cols: u16, rows: u16) -> Result<u32, AppError> {
    let root = git.root()?;
    let (line, title) = plan(&task, &root, &settings::load_commands(&app))?;
    request_spawn(&app, SpawnKind::Task { line, title }, root.to_string_lossy().into_owned(), cols, rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (name, body) in files {
            std::fs::write(d.path().join(name), body).unwrap();
        }
        d
    }

    fn saved(command: &str, repo: Option<&str>) -> CustomCommand {
        let repo = repo.map(String::from);
        CustomCommand { name: "Test".into(), command: command.into(), repo, hide_terminal: false }
    }

    #[test]
    fn lists_the_scripts_sorted_with_the_declared_runner() {
        let d = repo(&[
            ("package.json", r#"{"packageManager": "pnpm@9.1.0", "scripts": {"test": "vitest", "build": "vite build"}}"#),
            ("package-lock.json", "{}"),
        ]);
        let s = scripts_at(d.path()).unwrap().unwrap();
        let names: Vec<&str> = s.scripts.iter().map(|x| x.name.as_str()).collect();
        assert_eq!((s.runner, names), ("pnpm", vec!["build", "test"]));
        assert_eq!(s.scripts[0].command, "vite build");
    }

    #[test]
    fn a_lockfile_names_the_runner_when_package_json_does_not() {
        for (lock, want) in [("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("pnpm-lock.yaml", "pnpm")] {
            let d = repo(&[("package.json", r#"{"scripts": {"dev": "vite"}}"#), (lock, "")]);
            assert_eq!(scripts_at(d.path()).unwrap().unwrap().runner, want, "{lock}");
        }
        let d = repo(&[("package.json", r#"{"packageManager": "deno@2", "scripts": {"dev": "vite"}}"#)]);
        assert_eq!(scripts_at(d.path()).unwrap().unwrap().runner, "npm");
    }

    #[test]
    fn no_package_json_or_no_scripts_is_none() {
        assert_eq!(scripts_at(repo(&[]).path()).unwrap(), None);
        for body in [r#"{"name": "x"}"#, r#"{"scripts": {}}"#, r#"{"scripts": ["dev"]}"#, r#"{"scripts": {"dev": 1}}"#] {
            assert_eq!(scripts_at(repo(&[("package.json", body)]).path()).unwrap(), None, "{body}");
        }
    }

    #[test]
    fn a_package_json_that_does_not_parse_says_so() {
        let d = repo(&[("package.json", "{\"scripts\": ")]);
        assert!(matches!(scripts_at(d.path()), Err(AppError::Io(ref m)) if m.starts_with("package.json:")));
    }

    #[test]
    fn a_script_runs_through_its_runner_with_the_name_quoted() {
        let d = repo(&[
            ("package.json", r#"{"scripts": {"test:unit": "vitest", "it's": "x", "a\\b": "y"}}"#),
            ("yarn.lock", ""),
        ]);
        let run = |name: &str| plan(&Task::Script { name: name.into() }, d.path(), &[]);
        assert_eq!(run("test:unit").unwrap(), ("yarn run 'test:unit'".into(), "yarn test:unit".into()));
        assert_eq!(run("it's").unwrap().0, r"yarn run 'it'\''s'");
        assert_eq!(run(r"a\b").unwrap().0, r"yarn run 'a\b'");
        assert!(run("deploy").is_err());
    }

    #[test]
    fn a_saved_command_runs_only_as_saved_and_only_where_it_belongs() {
        let root = Path::new("/r/app");
        let list = [saved("pnpm test", Some("/r/app")), saved("make", None), saved("ls", Some("/r/other"))];
        let run = |c: CustomCommand| plan(&Task::Custom(c), root, &list);
        assert_eq!(run(saved("pnpm test", Some("/r/app"))).unwrap(), ("pnpm test".into(), "Test".into()));
        assert_eq!(run(saved("make", None)).unwrap().0, "make");
        assert!(run(saved("ls", Some("/r/other"))).is_err(), "another repository's command");
        assert!(run(saved("rm -rf ~", None)).is_err(), "not in the file");
        assert!(run(saved("pnpm test", None)).is_err(), "saved for one repository, sent as global");
        let hidden = CustomCommand { hide_terminal: true, ..saved("make", None) };
        assert!(run(hidden).is_err(), "saved to show its terminal");
    }

    #[test]
    fn an_unnamed_command_is_titled_by_its_line() {
        let c = CustomCommand { name: " ".into(), ..saved("cargo test", None) };
        let got = plan(&Task::Custom(c.clone()), Path::new("/r"), &[c]).unwrap();
        assert_eq!(got.1, "cargo test");
    }

    #[test]
    fn the_task_argument_reads_the_frontend_shape() {
        let custom =
            serde_json::json!({ "t": "Custom", "name": "a", "command": "b", "repo": null, "hide_terminal": true });
        let t: Task = serde_json::from_value(custom).unwrap();
        let want = CustomCommand { name: "a".into(), command: "b".into(), repo: None, hide_terminal: true };
        assert_eq!(t, Task::Custom(want));
        let unset = serde_json::json!({ "t": "Custom", "name": "a", "command": "b", "repo": null });
        assert!(serde_json::from_value::<Task>(unset).is_err(), "the webview always sends hide_terminal");
        let t: Task = serde_json::from_value(serde_json::json!({ "t": "Script", "name": "dev" })).unwrap();
        assert_eq!(t, Task::Script { name: "dev".into() });
    }
}
