use crate::error::AppError;
use crate::git::{self, AppState};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::State;

const SYSTEM: &str = "You write git commit messages. Describe the purpose of the change, not the edits. Infer the intent from the diff: what the change fixes, adds, or makes possible, and why. Simplified Technical English: short sentences, active voice, one idea per sentence, no filler. Format: line 1 is an imperative summary of the whole change, at most 50 characters. Add a body only when the summary is not enough: one blank line, then at most 2 sentences with the reason or the key consequence. Write the body as one paragraph on a single line, however long it gets; never break a sentence across lines. Never list files, functions, or individual edits. Output only the message: no quotes, no markdown, no commentary.";
const TIMEOUT: Duration = Duration::from_secs(60);
// ponytail: the summary needs the shape of the change, not a whole lockfile churn; raise if messages miss real edits
const MAX_DIFF: usize = 200 * 1024;

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

pub fn commit_message_impl(root: &Path) -> Result<String, AppError> {
    let diff = git::run(root, &["diff", "--cached", "--no-color", "--no-ext-diff"], None, Some(git::LOCAL))?.stdout;
    if diff.is_empty() {
        return Err(AppError::Ai("Nothing is staged".into()));
    }
    let bin = claude_bin().ok_or_else(|| AppError::Ai("claude CLI not found. Install Claude Code, then try again.".into()))?;
    let mut cmd = Command::new(bin);
    cmd.args([
        "-p", "--output-format", "text", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
        "--model", "opus", "--system-prompt", SYSTEM, "Write the commit message for this staged diff:",
    ])
    .current_dir(root);
    let diff = String::from_utf8_lossy(&diff[..diff.len().min(MAX_DIFF)]);
    let out = match git::run_child(cmd, Some(diff.as_bytes()), Some(TIMEOUT), None) {
        Err(AppError::Timeout) => return Err(AppError::Ai("claude took too long and was stopped".into())),
        r => r?,
    };
    if out.code != 0 {
        return Err(AppError::Ai(if out.stderr.is_empty() { format!("claude exited with code {}", out.code) } else { out.stderr }));
    }
    let msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if msg.is_empty() {
        return Err(AppError::Ai("claude returned an empty message".into()));
    }
    Ok(msg)
}

/// Async so the call leaves the main thread; sync commands would freeze the window while claude runs.
#[tauri::command]
pub async fn ai_commit_message(state: State<'_, AppState>) -> Result<String, AppError> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || commit_message_impl(&root))
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?
}
