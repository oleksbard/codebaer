use crate::error::AppError;
use crate::git::{self, AppState};
use crate::settings::{self, AiProvider};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, State};

const SYSTEM: &str = "You write git commit messages. Describe the purpose of the change, not the edits. Infer the intent from the diff: what the change fixes, adds, or makes possible, and why. Simplified Technical English: short sentences, active voice, one idea per sentence, no filler. Format: line 1 is an imperative summary of the whole change, at most 50 characters. Add a body only when the summary is not enough: one blank line, then at most 2 sentences with the reason or the key consequence. Write the body as one paragraph on a single line, however long it gets; never break a sentence across lines. Never list files, functions, or individual edits. Output only the message: no quotes, no markdown, no commentary.";
const ICON_SYSTEM: &str = "You pick one icon for each command in a developer tool's command menu. Each command has a name and the shell line it runs. Pick the icon a developer recognises fastest as that command's purpose. For an action such as test, build, lint, format or deploy, pick an icon for the action, not the logo of the tool that runs it. Pick a brand logo only when the command is about that product itself, such as opening Chrome or starting Docker. Answer with ids from the given lists, exactly as written. Give two commands the same icon only when they do the same thing.";
const ICON_SCHEMA: &str = r#"{"type":"object","properties":{"icons":{"type":"array","items":{"type":"object","properties":{"n":{"type":"integer"},"icon":{"type":"string"}},"required":["n","icon"],"additionalProperties":false}}},"required":["icons"],"additionalProperties":false}"#;
const TIMEOUT: Duration = Duration::from_secs(60);
// ponytail: the summary needs the shape of the change, not a whole lockfile churn; raise if messages miss real edits
const MAX_DIFF: usize = 200 * 1024;
/// Enough of a shell line to tell what it does.
const MAX_LINE: usize = 500;

/// An app started by LaunchServices does not get the shell's PATH, so the usual install dirs are checked too.
fn claude_bin() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    path_dirs
        .into_iter()
        .chain([home.join(".local/bin"), home.join(".claude/local"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()])
        .map(|d| d.join("claude"))
        .find(|p| p.is_file())
}

fn claude(args: &[&str], stdin: &[u8], cwd: &Path) -> Result<String, AppError> {
    let bin = claude_bin().ok_or_else(|| AppError::Ai("claude CLI not found. Install Claude Code, then try again.".into()))?;
    let mut cmd = Command::new(bin);
    cmd.args(["-p", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""])
        .args(args)
        .current_dir(cwd);
    let out = match git::run_child(cmd, Some(stdin), Some(TIMEOUT), None) {
        Err(AppError::Timeout) => return Err(AppError::Ai("claude took too long and was stopped".into())),
        r => r?,
    };
    if out.code != 0 {
        return Err(AppError::Ai(if out.stderr.is_empty() { format!("claude exited with code {}", out.code) } else { out.stderr }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn commit_message_impl(root: &Path, provider: AiProvider) -> Result<String, AppError> {
    match provider {
        AiProvider::Off => return Err(AppError::Ai("AI commit messages are off. Turn them on in Settings.".into())),
        AiProvider::Claude => {}
    }
    let diff = git::run(root, &["diff", "--cached", "--no-color", "--no-ext-diff"], None, Some(git::LOCAL))?.stdout;
    if diff.is_empty() {
        return Err(AppError::Ai("Nothing is staged".into()));
    }
    let diff = String::from_utf8_lossy(&diff[..diff.len().min(MAX_DIFF)]);
    let args = ["--output-format", "text", "--model", "opus", "--system-prompt", SYSTEM, "Write the commit message for this staged diff:"];
    let msg = claude(&args, diff.as_bytes(), root)?;
    if msg.is_empty() {
        return Err(AppError::Ai("claude returned an empty message".into()));
    }
    Ok(msg)
}

/// Async so the call leaves the main thread; sync commands would freeze the window while claude runs.
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

/// One entry per item, None where claude gave no answer or one that is not in the sets.
fn icon_answer(stdout: &str, count: usize, sets: &[IconSet]) -> Result<Vec<Option<String>>, AppError> {
    let reply: Value = serde_json::from_str(stdout).map_err(|e| AppError::Ai(format!("claude's answer is not JSON: {e}")))?;
    if reply["is_error"].as_bool() == Some(true) {
        let why = reply["result"].as_str().unwrap_or("claude reported an error");
        return Err(AppError::Ai(why.to_string()));
    }
    let Some(picks) = reply["structured_output"]["icons"].as_array() else {
        return Err(AppError::Ai("claude returned no icons".into()));
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
    match provider {
        AiProvider::Off => return Err(AppError::Ai("AI command icons are off. Turn them on in Settings.".into())),
        AiProvider::Claude => {}
    }
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let args = [
        "--output-format", "json", "--json-schema", ICON_SCHEMA, "--model", "sonnet", "--system-prompt", ICON_SYSTEM,
        "Pick an icon for every command.",
    ];
    // no repository: the answer depends only on the commands
    let out = claude(&args, icon_prompt(items, sets).as_bytes(), &std::env::temp_dir())?;
    icon_answer(&out, items.len(), sets)
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

    fn reply(icons: Value) -> String {
        serde_json::json!({ "is_error": false, "result": "", "structured_output": { "icons": icons } }).to_string()
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
        let out = reply(serde_json::json!([
            { "n": 0, "icon": "lucide:hammer" },
            { "n": 0, "icon": "lucide:play" },
            { "n": 1, "icon": "lucide:googlechrome" },
            { "n": 2, "icon": "simple-icons:googlechrome" },
            { "n": 9, "icon": "lucide:play" },
            { "n": "3", "icon": "lucide:play" },
        ]));
        let want = vec![Some("lucide:hammer".into()), None, Some("simple-icons:googlechrome".into()), None];
        assert_eq!(icon_answer(&out, 4, &sets()).unwrap(), want);
    }

    #[test]
    fn an_error_or_a_reply_without_icons_says_so() {
        let failed = serde_json::json!({ "is_error": true, "result": "Credit balance is too low" }).to_string();
        assert!(matches!(icon_answer(&failed, 1, &sets()), Err(AppError::Ai(ref m)) if m == "Credit balance is too low"));
        let bare = serde_json::json!({ "is_error": false, "result": "hammer" }).to_string();
        assert!(matches!(icon_answer(&bare, 1, &sets()), Err(AppError::Ai(ref m)) if m.contains("no icons")));
        assert!(matches!(icon_answer("hammer", 1, &sets()), Err(AppError::Ai(ref m)) if m.contains("not JSON")));
    }

    #[test]
    fn icons_are_not_asked_for_while_the_provider_is_off_or_for_no_commands() {
        let off = command_icons_impl(AiProvider::Off, &[item("dev", "vite")], &sets());
        assert!(matches!(off, Err(AppError::Ai(ref m)) if m.contains("off")));
        assert_eq!(command_icons_impl(AiProvider::Claude, &[], &sets()).unwrap(), Vec::<Option<String>>::new());
    }
}
