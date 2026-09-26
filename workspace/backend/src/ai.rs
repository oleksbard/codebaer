use crate::error::AppError;
use crate::git::{self, AppState};
use crate::pty::{client::executable, daemon::login_shell};
use crate::settings::{self, AiProvider};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};

const SYSTEM: &str = "You write git commit messages. Describe the purpose of the change, not the edits. Infer the intent from the diff: what the change fixes, adds, or makes possible, and why. Simplified Technical English: short sentences, active voice, one idea per sentence, no filler. Format: line 1 is an imperative summary of the whole change, at most 50 characters. Add a body only when the summary is not enough: one blank line, then at most 2 sentences with the reason or the key consequence. Write the body as one paragraph on a single line, however long it gets; never break a sentence across lines. Never list files, functions, or individual edits. Output only the message: no quotes, no markdown, no commentary.";
const ICON_SYSTEM: &str = "You pick one icon for each command in a developer tool's command menu. Each command has a name and the shell line it runs. Pick the icon a developer recognises fastest as that command's purpose. For an action such as test, build, lint, format or deploy, pick an icon for the action, not the logo of the tool that runs it. Pick a brand logo only when the command is about that product itself, such as opening Chrome or starting Docker. Answer with ids from the given lists, exactly as written. Give two commands the same icon only when they do the same thing.";
const ICON_SCHEMA: &str = r#"{"type":"object","properties":{"icons":{"type":"array","items":{"type":"object","properties":{"n":{"type":"integer"},"icon":{"type":"string"}},"required":["n","icon"],"additionalProperties":false}}},"required":["icons"],"additionalProperties":false}"#;
/// Codex and OpenCode cannot turn their tools off; they also run read-only, in an empty folder.
const NO_TOOLS: &str = "Do not run commands, read files or change anything: everything you need is in this message.";
const TIMEOUT: Duration = Duration::from_secs(60);
/// A profile that waits for input must not hold up a check for the installed CLIs.
const SHELL_TIMEOUT: Duration = Duration::from_secs(10);
// ponytail: the summary needs the shape of the change, not a whole lockfile churn; raise if messages miss real edits
const MAX_DIFF: usize = 200 * 1024;
/// Enough of a shell line to tell what it does.
const MAX_LINE: usize = 500;
/// Enough of a failed run's stderr to hold its error; codex writes its whole run there.
const MAX_ERR: usize = 2000;

const PROVIDERS: [AiProvider; 3] = [AiProvider::Claude, AiProvider::Codex, AiProvider::Opencode];

/// The executable and what a user installs to get it.
struct Cli {
    bin: &'static str,
    product: &'static str,
}

fn cli(p: AiProvider) -> Option<Cli> {
    let (bin, product) = match p {
        AiProvider::Off => return None,
        AiProvider::Claude => ("claude", "Claude Code"),
        AiProvider::Codex => ("codex", "Codex CLI"),
        AiProvider::Opencode => ("opencode", "OpenCode"),
    };
    Some(Cli { bin, product })
}

/// An app started by LaunchServices does not get the shell's PATH, so the usual install dirs are checked too.
fn search_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    path.into_iter()
        .chain([".local/bin", ".claude/local", ".opencode/bin", ".bun/bin", ".npm-global/bin"].map(|d| home.join(d)))
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from))
        .collect()
}

/// `command -v` alone between semicolons, so the line means the same in sh, zsh, bash and fish.
fn shell_lookup(names: &[&str]) -> Vec<PathBuf> {
    let script = names.iter().map(|n| format!("command -v {n}")).collect::<Vec<_>>().join("; ");
    let mut cmd = Command::new(login_shell());
    cmd.args(["-l", "-c", &script]);
    let Ok(out) = git::run_child(cmd, None, Some(SHELL_TIMEOUT), None) else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout).lines().map(|l| PathBuf::from(l.trim())).filter(|p| p.is_absolute()).collect()
}

/// A login shell runs only for the names the dirs lack: it alone sees a PATH entry that only the user's profile
/// adds, the way the terminal menu finds its commands, but it is slow.
fn find_bins_in(names: &[&str], dirs: &[PathBuf], shell: impl FnOnce(&[&str]) -> Vec<PathBuf>) -> Vec<Option<PathBuf>> {
    let mut found: Vec<Option<PathBuf>> =
        names.iter().map(|n| dirs.iter().map(|d| d.join(n)).find(|p| executable(p))).collect();
    let missing: Vec<&str> = names.iter().zip(&found).filter(|(_, f)| f.is_none()).map(|(n, _)| *n).collect();
    if missing.is_empty() {
        return found;
    }
    for p in shell(&missing).into_iter().filter(|p| executable(p)) {
        let at = names.iter().position(|n| p.file_name().is_some_and(|f| f == *n));
        if let Some(slot) = at.and_then(|i| found.get_mut(i)) {
            slot.get_or_insert(p);
        }
    }
    found
}

/// Where each CLI was last found, so a run need not start a login shell again; `installed_ai_providers` looks
/// afresh and forgets a CLI that is gone.
static FOUND: Mutex<BTreeMap<&str, PathBuf>> = Mutex::new(BTreeMap::new());

fn found() -> std::sync::MutexGuard<'static, BTreeMap<&'static str, PathBuf>> {
    FOUND.lock().unwrap_or_else(|e| e.into_inner())
}

fn find_bins(names: &[&'static str]) -> Vec<Option<PathBuf>> {
    let bins = find_bins_in(names, &search_dirs(), shell_lookup);
    let mut cache = found();
    for (name, bin) in names.iter().zip(&bins) {
        match bin {
            Some(b) => cache.insert(name, b.clone()),
            None => cache.remove(name),
        };
    }
    bins
}

fn find_bin(name: &'static str) -> Option<PathBuf> {
    let known = found().get(name).filter(|p| executable(p)).cloned();
    known.or_else(|| find_bins(&[name]).pop().flatten())
}

/// An npm install is a node script that `env` looks up on the PATH, and node is usually next to it.
fn child_path(bin: &Path) -> OsString {
    let dirs: Vec<PathBuf> = bin.parent().map(Path::to_path_buf).into_iter().chain(search_dirs()).collect();
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

#[tauri::command]
pub async fn installed_ai_providers() -> Result<Vec<AiProvider>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let names = PROVIDERS.map(|p| cli(p).map_or("", |c| c.bin));
        PROVIDERS.into_iter().zip(find_bins(&names)).filter_map(|(p, bin)| bin.map(|_| p)).collect()
    })
    .await
    .map_err(|e| AppError::Ai(e.to_string()))
}

/// One question. Every CLI runs in a new empty folder: the answer depends only on the message, and no
/// project's instructions or session history should reach it or keep it.
struct Ask<'a> {
    system: &'a str,
    instruction: &'a str,
    input: &'a str,
    /// Codex and OpenCode use the model their user configured.
    claude_model: &'a str,
    /// For an answer that is one JSON object; None for text.
    schema: Option<&'a str>,
}

/// Codex and OpenCode take no system prompt, so it leads the message.
fn prompt_head(a: &Ask) -> String {
    let mut s = format!("{}\n\n{NO_TOOLS}\n\n{}", a.system, a.instruction);
    if let Some(schema) = a.schema {
        s += &format!("\nAnswer with one JSON object that matches this JSON Schema, and nothing else:\n{schema}");
    }
    s
}

fn tail(s: &str, max: usize) -> String {
    let skip = s.chars().count().saturating_sub(max);
    s.chars().skip(skip).collect()
}

fn run(bin: &Path, name: &str, args: &[&str], stdin: &[u8], cwd: &Path) -> Result<String, AppError> {
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(cwd).env("PATH", child_path(bin));
    let out = match git::run_child(cmd, Some(stdin), Some(TIMEOUT), None) {
        Err(AppError::Timeout) => return Err(AppError::Ai(format!("{name} took too long and was stopped"))),
        r => r?,
    };
    if out.code != 0 {
        let why = if out.stderr.is_empty() { format!("{name} exited with code {}", out.code) } else { tail(&out.stderr, MAX_ERR) };
        return Err(AppError::Ai(why));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Claude reports on the whole run, with a schema answer inside.
fn claude_structured(stdout: &str) -> Result<String, AppError> {
    let reply: Value = serde_json::from_str(stdout).map_err(|e| AppError::Ai(format!("claude's answer is not JSON: {e}")))?;
    if reply["is_error"].as_bool() == Some(true) {
        let why = reply["result"].as_str().unwrap_or("claude reported an error");
        return Err(AppError::Ai(why.to_string()));
    }
    match &reply["structured_output"] {
        v @ Value::Object(_) => Ok(v.to_string()),
        _ => Err(AppError::Ai("claude returned no structured answer".into())),
    }
}

/// `--format json` prints one event per line. The answer is the text of the last message, after any step the
/// agent narrated; an error event stands in for an empty answer.
fn opencode_text(stdout: &str) -> Result<String, AppError> {
    let events: Vec<Value> = stdout.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let mut parts: Vec<(Option<&str>, &str)> = Vec::new();
    let mut error = None;
    for ev in &events {
        match ev["type"].as_str() {
            Some("text") => {
                if let Some(t) = ev["part"]["text"].as_str() {
                    parts.push((ev["part"]["messageID"].as_str(), t));
                }
            }
            Some("error") => {
                let e = &ev["error"];
                let why = [&e["data"]["message"], &e["message"], &e["name"]].into_iter().find_map(Value::as_str);
                error = Some(why.map_or_else(|| e.to_string(), String::from));
            }
            _ => {}
        }
    }
    let last = parts.last().map(|p| p.0);
    let text = parts.iter().filter(|p| Some(p.0) == last).map(|p| p.1).collect::<Vec<_>>().join("\n");
    match (text.trim(), error) {
        ("", Some(why)) => Err(AppError::Ai(why)),
        (t, _) => Ok(t.to_string()),
    }
}

/// The provider's answer: text, or with a schema, the JSON object's text.
fn ask(provider: AiProvider, a: &Ask) -> Result<String, AppError> {
    let Some(c) = cli(provider) else { return Err(AppError::Ai("The headless AI provider is off.".into())) };
    let bin = find_bin(c.bin).ok_or_else(|| AppError::Ai(format!("{} CLI not found. Install {}, then try again.", c.bin, c.product)))?;
    let dir = tempfile::tempdir()?;
    match provider {
        AiProvider::Off => unreachable!("cli() has no Off"),
        AiProvider::Claude => {
            let mut args = vec!["-p", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""];
            args.extend(["--model", a.claude_model, "--system-prompt", a.system]);
            match a.schema {
                None => args.extend(["--output-format", "text"]),
                Some(s) => args.extend(["--output-format", "json", "--json-schema", s]),
            }
            args.push(a.instruction);
            let out = run(&bin, c.bin, &args, a.input.as_bytes(), dir.path())?;
            if a.schema.is_some() { claude_structured(&out) } else { Ok(out) }
        }
        AiProvider::Codex => {
            // exec never asks for approval; `-` reads the whole prompt from stdin, and only the answer reaches stdout
            let args = [
                "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never",
                "-c", "model_reasoning_effort=\"low\"", "-",
            ];
            let prompt = format!("{}\n\n{}", prompt_head(a), a.input);
            run(&bin, c.bin, &args, prompt.as_bytes(), dir.path())
        }
        AiProvider::Opencode => {
            // the plan agent may not edit, and a run without --auto turns down every permission it asks for;
            // stdin is added after the message
            let head = prompt_head(a);
            let out = run(&bin, c.bin, &["run", "--format", "json", "--agent", "plan", &head], a.input.as_bytes(), dir.path())?;
            opencode_text(&out)
        }
    }
}

/// The first object in a reply that may wrap it in a code fence or in sentences, braces in them included.
fn json_object(text: &str) -> Option<Value> {
    text.match_indices('{').find_map(|(at, _)| {
        let first = serde_json::Deserializer::from_str(&text[at..]).into_iter::<Value>().next()?;
        first.ok().filter(Value::is_object)
    })
}

pub fn commit_message_impl(root: &Path, provider: AiProvider) -> Result<String, AppError> {
    let Some(c) = cli(provider) else {
        return Err(AppError::Ai("AI commit messages are off. Turn them on in Settings.".into()));
    };
    let diff = git::run(root, &["diff", "--cached", "--no-color", "--no-ext-diff"], None, Some(git::LOCAL))?.stdout;
    if diff.is_empty() {
        return Err(AppError::Ai("Nothing is staged".into()));
    }
    let diff = String::from_utf8_lossy(&diff[..diff.len().min(MAX_DIFF)]);
    let a = Ask {
        system: SYSTEM,
        instruction: "Write the commit message for this staged diff:",
        input: &diff,
        claude_model: "opus",
        schema: None,
    };
    let msg = ask(provider, &a)?;
    if msg.is_empty() {
        return Err(AppError::Ai(format!("{} returned an empty message", c.bin)));
    }
    Ok(msg)
}

/// Async so the call leaves the main thread; sync commands would freeze the window while the CLI runs.
#[tauri::command]
pub async fn ai_commit_message(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppError> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || commit_message_impl(&root, settings::load(&app).headless_ai_provider))
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?
}

#[derive(Debug, Clone, Deserialize)]
pub struct IconItem {
    pub name: String,
    pub command: String,
}

/// The webview holds the icon sets, so it sends the names to choose from; an answer is `<prefix>:<name>`.
#[derive(Debug, Clone, Deserialize)]
pub struct IconSet {
    pub prefix: String,
    pub title: String,
    pub names: Vec<String>,
}

fn icon_prompt(items: &[IconItem], sets: &[IconSet]) -> String {
    let mut s = String::from("Commands, one JSON object per line; answer each by its n:\n");
    for (n, it) in items.iter().enumerate() {
        let command: String = it.command.chars().take(MAX_LINE).collect();
        s += &serde_json::json!({ "n": n, "name": it.name, "command": command }).to_string();
        s.push('\n');
    }
    for set in sets {
        s += &format!("\n{}, answer as {}:<name>:\n", set.title, set.prefix);
        s += &set.names.join("\n");
        s.push('\n');
    }
    s
}

/// One entry per item, None where the AI gave no answer or one that is not in the sets.
fn icon_answer(reply: &Value, count: usize, sets: &[IconSet], name: &str) -> Result<Vec<Option<String>>, AppError> {
    let Some(picks) = reply["icons"].as_array() else {
        return Err(AppError::Ai(format!("{name} returned no icons")));
    };
    let known: HashSet<String> =
        sets.iter().flat_map(|s| s.names.iter().map(move |n| format!("{}:{n}", s.prefix))).collect();
    let mut out = vec![None; count];
    for p in picks {
        let (Some(n), Some(icon)) = (p["n"].as_u64(), p["icon"].as_str()) else { continue };
        let Some(slot) = usize::try_from(n).ok().and_then(|n| out.get_mut(n)) else { continue };
        if slot.is_none() && known.contains(icon) {
            *slot = Some(icon.to_string());
        }
    }
    Ok(out)
}

pub fn command_icons_impl(provider: AiProvider, items: &[IconItem], sets: &[IconSet]) -> Result<Vec<Option<String>>, AppError> {
    let Some(c) = cli(provider) else {
        return Err(AppError::Ai("AI command icons are off. Turn them on in Settings.".into()));
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let input = icon_prompt(items, sets);
    let a = Ask {
        system: ICON_SYSTEM,
        instruction: "Pick an icon for every command.",
        input: &input,
        claude_model: "sonnet",
        schema: Some(ICON_SCHEMA),
    };
    let out = ask(provider, &a)?;
    let reply = json_object(&out).ok_or_else(|| AppError::Ai(format!("{}'s answer is not JSON", c.bin)))?;
    icon_answer(&reply, items.len(), sets, c.bin)
}

#[tauri::command]
pub async fn ai_command_icons(app: AppHandle, items: Vec<IconItem>, sets: Vec<IconSet>) -> Result<Vec<Option<String>>, AppError> {
    tauri::async_runtime::spawn_blocking(move || command_icons_impl(settings::load(&app).headless_ai_provider, &items, &sets))
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sets() -> Vec<IconSet> {
        let set = |prefix: &str, title: &str, names: &[&str]| IconSet {
            prefix: prefix.into(),
            title: title.into(),
            names: names.iter().map(|n| n.to_string()).collect(),
        };
        vec![set("lucide", "Lucide", &["hammer", "play"]), set("simple-icons", "Simple Icons", &["googlechrome"])]
    }

    fn item(name: &str, command: &str) -> IconItem {
        IconItem { name: name.into(), command: command.into() }
    }

    #[test]
    fn the_prompt_numbers_the_commands_and_lists_every_set_with_its_prefix() {
        let long = "x".repeat(MAX_LINE + 50);
        let p = icon_prompt(&[item("build", "vite build"), item("", &long)], &sets());
        assert!(p.contains(r#"{"command":"vite build","n":0,"name":"build"}"#), "{p}");
        assert!(p.contains(&format!(r#"{{"command":"{}","n":1,"name":""}}"#, "x".repeat(MAX_LINE))), "{p}");
        assert!(p.contains("\nLucide, answer as lucide:<name>:\nhammer\nplay\n"), "{p}");
        assert!(p.contains("\nSimple Icons, answer as simple-icons:<name>:\ngooglechrome\n"), "{p}");
    }

    #[test]
    fn an_answer_keeps_only_known_ids_in_range_and_the_first_for_each_command() {
        let reply = serde_json::json!({ "icons": [
            { "n": 0, "icon": "lucide:hammer" },
            { "n": 0, "icon": "lucide:play" },
            { "n": 1, "icon": "lucide:googlechrome" },
            { "n": 2, "icon": "simple-icons:googlechrome" },
            { "n": 9, "icon": "lucide:play" },
            { "n": "3", "icon": "lucide:play" },
        ]});
        let want = vec![Some("lucide:hammer".into()), None, Some("simple-icons:googlechrome".into()), None];
        assert_eq!(icon_answer(&reply, 4, &sets(), "codex").unwrap(), want);
        let bare = serde_json::json!({ "picks": [] });
        assert!(matches!(icon_answer(&bare, 1, &sets(), "codex"), Err(AppError::Ai(ref m)) if m == "codex returned no icons"));
    }

    #[test]
    fn claude_s_report_yields_the_structured_answer_or_its_error() {
        let ok = serde_json::json!({ "is_error": false, "result": "", "structured_output": { "icons": [] } }).to_string();
        assert_eq!(claude_structured(&ok).unwrap(), r#"{"icons":[]}"#);
        let failed = serde_json::json!({ "is_error": true, "result": "Credit balance is too low" }).to_string();
        assert!(matches!(claude_structured(&failed), Err(AppError::Ai(ref m)) if m == "Credit balance is too low"));
        let bare = serde_json::json!({ "is_error": false, "result": "hammer" }).to_string();
        assert!(matches!(claude_structured(&bare), Err(AppError::Ai(ref m)) if m.contains("no structured answer")));
        assert!(matches!(claude_structured("hammer"), Err(AppError::Ai(ref m)) if m.contains("not JSON")));
    }

    #[test]
    fn the_json_object_is_found_inside_a_fence_or_a_sentence() {
        let want = serde_json::json!({ "icons": [{ "n": 0, "icon": "lucide:play" }] });
        for text in [
            r#"{"icons":[{"n":0,"icon":"lucide:play"}]}"#,
            "```json\n{\"icons\":[{\"n\":0,\"icon\":\"lucide:play\"}]}\n```",
            "Here you go: {\"icons\": [{\"n\": 0, \"icon\": \"lucide:play\"}]} Done.",
        ] {
            assert_eq!(json_object(text), Some(want.clone()), "{text}");
        }
        let braces = "Use {n} as the index: {\"icons\": [{\"n\": 0, \"icon\": \"lucide:play\"}]} (done :})";
        assert_eq!(json_object(braces), Some(want.clone()));
        for text in ["hammer", "[1, 2]", "} {", "{not json}"] {
            assert_eq!(json_object(text), None, "{text}");
        }
    }

    #[test]
    fn opencode_s_answer_is_the_text_of_its_last_message() {
        let ev = |v: Value| v.to_string();
        let out = [
            ev(serde_json::json!({ "type": "step_start", "part": {} })),
            ev(serde_json::json!({ "type": "text", "part": { "messageID": "m1", "text": "Let me look." } })),
            ev(serde_json::json!({ "type": "tool_use", "part": { "messageID": "m1" } })),
            "not json".to_string(),
            ev(serde_json::json!({ "type": "text", "part": { "messageID": "m2", "text": "Fix the cart total" } })),
            ev(serde_json::json!({ "type": "text", "part": { "messageID": "m2", "text": "Discounts were counted twice." } })),
        ]
        .join("\n");
        assert_eq!(opencode_text(&out).unwrap(), "Fix the cart total\nDiscounts were counted twice.");
        assert_eq!(opencode_text("").unwrap(), "");
    }

    #[test]
    fn an_opencode_error_event_stands_in_for_an_empty_answer() {
        let err = |e: Value| serde_json::json!({ "type": "error", "error": e }).to_string();
        let auth = err(serde_json::json!({ "name": "ProviderAuthError", "data": { "message": "No API key" } }));
        assert!(matches!(opencode_text(&auth), Err(AppError::Ai(ref m)) if m == "No API key"));
        assert!(matches!(opencode_text(&err(serde_json::json!({ "name": "Unknown" }))), Err(AppError::Ai(ref m)) if m == "Unknown"));
        let text = serde_json::json!({ "type": "text", "part": { "text": "Add login" } }).to_string();
        assert_eq!(opencode_text(&format!("{auth}\n{text}")).unwrap(), "Add login");
    }

    #[test]
    fn the_message_for_a_cli_without_a_system_prompt_leads_with_it() {
        let a = Ask { system: "SYS", instruction: "Do it:", input: "diff", claude_model: "opus", schema: None };
        assert_eq!(prompt_head(&a), format!("SYS\n\n{NO_TOOLS}\n\nDo it:"));
        let a = Ask { schema: Some(r#"{"type":"object"}"#), ..a };
        assert!(prompt_head(&a).ends_with("Do it:\nAnswer with one JSON object that matches this JSON Schema, and nothing else:\n{\"type\":\"object\"}"));
    }

    #[test]
    fn a_cli_is_found_in_the_dirs_else_by_the_login_shell_asked_only_for_the_rest() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let make = |dir: &Path, name: &str, mode: u32| {
            std::fs::create_dir_all(dir).unwrap();
            let p = dir.join(name);
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            p
        };
        let bin = d.path().join("bin");
        let codex = make(&bin, "codex", 0o755);
        make(&bin, "opencode", 0o644);
        let nvm = make(&d.path().join("nvm"), "opencode", 0o755);
        let asked = std::cell::RefCell::new(Vec::new());
        let shell = |names: &[&str]| {
            asked.borrow_mut().extend(names.iter().map(|n| n.to_string()));
            vec![PathBuf::from("/nowhere/claude"), nvm.clone(), codex.with_file_name("elsewhere")]
        };
        let found = find_bins_in(&["claude", "codex", "opencode"], &[d.path().join("missing"), bin], shell);
        assert_eq!(found, vec![None, Some(codex), Some(nvm)]);
        assert_eq!(*asked.borrow(), ["claude", "opencode"]);
        let never = |_: &[&str]| -> Vec<PathBuf> { panic!("every name was in the dirs") };
        assert_eq!(find_bins_in(&[], &[], never), Vec::<Option<PathBuf>>::new());
    }

    #[test]
    fn a_cli_runs_with_its_own_dir_first_on_the_path() {
        let path = child_path(Path::new("/Users/me/.nvm/versions/node/v22/bin/codex"));
        let first = std::env::split_paths(&path).next();
        assert_eq!(first, Some(PathBuf::from("/Users/me/.nvm/versions/node/v22/bin")));
    }

    #[test]
    fn a_long_error_keeps_its_end() {
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("ab", 3), "ab");
    }

    #[test]
    fn nothing_is_asked_while_the_provider_is_off_or_for_no_commands() {
        let off = command_icons_impl(AiProvider::Off, &[item("dev", "vite")], &sets());
        assert!(matches!(off, Err(AppError::Ai(ref m)) if m.contains("off")));
        let off = commit_message_impl(Path::new("/nowhere"), AiProvider::Off);
        assert!(matches!(off, Err(AppError::Ai(ref m)) if m.contains("off")));
        for p in PROVIDERS {
            assert_eq!(command_icons_impl(p, &[], &sets()).unwrap(), Vec::<Option<String>>::new());
        }
    }
}
