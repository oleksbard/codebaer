use crate::ai;
use crate::error::AppError;
use crate::git::kill_group;
use crate::settings::AiProvider;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const WEEK_MINS: i64 = 7 * 24 * 60;
/// `/usage` is answered by the CLI itself: no model runs, and the run costs nothing.
const CLAUDE_ARGS: [&str; 8] =
    ["-p", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "", "--output-format", "json", "/usage"];

/// One usage window of a plan, such as the week. `resets` is the CLI's own text; `resets_at` is in Unix seconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Window {
    pub label: String,
    pub percent: f64,
    pub resets: Option<String>,
    pub resets_at: Option<i64>,
    pub weekly: bool,
}

/// `Current week (all models): 86% used · resets Oct 17 at 11pm (Europe/Berlin)`
fn claude_line(line: &str) -> Option<Window> {
    let (label, rest) = line.trim().split_once(": ")?;
    let (pct, rest) = rest.split_once("% used")?;
    let percent = pct.trim().trim_start_matches('<').parse().ok()?;
    let resets = rest.trim().trim_start_matches('·').trim().strip_prefix("resets ").map(|r| r.trim().to_string());
    let label = label.strip_prefix("Current ").unwrap_or(label);
    let mut chars = label.chars();
    let label: String = chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default();
    let weekly = label.starts_with("Week");
    Some(Window { label, percent, resets, resets_at: None, weekly })
}

fn claude_windows(stdout: &str) -> Result<Vec<Window>, AppError> {
    let reply: Value = serde_json::from_str(stdout).map_err(|e| AppError::Ai(format!("claude's answer is not JSON: {e}")))?;
    let text = reply["result"].as_str().unwrap_or_default();
    if reply["is_error"].as_bool() == Some(true) {
        return Err(AppError::Ai(if text.is_empty() { "claude reported an error".into() } else { text.to_string() }));
    }
    let windows: Vec<Window> = text.lines().filter_map(claude_line).collect();
    if windows.is_empty() {
        // e.g. an API key, which has no plan limits; the CLI's first line says which
        let why = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("claude reported no usage limits");
        return Err(AppError::Ai(why.to_string()));
    }
    Ok(windows)
}

fn window_label(mins: i64) -> String {
    match mins {
        WEEK_MINS => "Week".into(),
        1440 => "Day".into(),
        m if m % 1440 == 0 => format!("{} days", m / 1440),
        60 => "Hour".into(),
        m if m % 60 == 0 => format!("{} hours", m / 60),
        m => format!("{m} minutes"),
    }
}

fn codex_window(v: &Value) -> Option<Window> {
    let percent = v["usedPercent"].as_f64()?;
    let mins = v["windowDurationMins"].as_i64();
    Some(Window {
        label: mins.map_or_else(|| "Limit".into(), window_label),
        percent,
        resets: None,
        resets_at: v["resetsAt"].as_i64(),
        weekly: mins == Some(WEEK_MINS),
    })
}

fn codex_windows(result: &Value) -> Result<Vec<Window>, AppError> {
    let snap = &result["rateLimits"];
    let windows: Vec<Window> = ["primary", "secondary"].iter().filter_map(|k| codex_window(&snap[k])).collect();
    if windows.is_empty() {
        return Err(AppError::Ai("codex reported no usage limits".into()));
    }
    Ok(windows)
}

/// Kills the server's whole group, since an npm install runs it under node, and reaps it.
struct Reap(Child);

impl Drop for Reap {
    fn drop(&mut self) {
        kill_group(self.0.id());
        let _ = self.0.wait();
    }
}

/// `codex app-server` speaks JSON-RPC without the `jsonrpc` field, one message per line. The request waits for the
/// initialize answer, which the server needs first.
fn codex_rate_limits(mut cmd: Command, timeout: Duration) -> Result<Value, AppError> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    let mut child = Reap(cmd.spawn()?);
    let mut stdin = child.0.stdin.take().ok_or_else(|| AppError::Ai("codex app-server has no stdin".into()))?;
    let stdout = child.0.stdout.take().ok_or_else(|| AppError::Ai("codex app-server has no stdout".into()))?;
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let gone = || AppError::Ai("codex app-server stopped before it answered".into());
    let mut send = |msg: Value| writeln!(stdin, "{msg}").map_err(|_| gone());
    let deadline = Instant::now() + timeout;
    // a message with a method is the server's own request or notification, whatever its id
    let answer = |id: i64| loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(v) if v.get("method").is_none() && v["id"].as_i64() == Some(id) => {
                return match v.get("error") {
                    Some(e) => Err(AppError::Ai(e["message"].as_str().unwrap_or("codex reported an error").to_string())),
                    None => Ok(v["result"].clone()),
                };
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => return Err(AppError::Ai("codex took too long and was stopped".into())),
            Err(RecvTimeoutError::Disconnected) => return Err(gone()),
        }
    };
    let client = json!({ "name": "codebaer", "title": "CodeBär", "version": env!("CARGO_PKG_VERSION") });
    send(json!({ "id": 1, "method": "initialize", "params": { "clientInfo": client, "capabilities": null } }))?;
    answer(1)?;
    send(json!({ "method": "initialized" }))?;
    send(json!({ "id": 2, "method": "account/rateLimits/read" }))?;
    answer(2)
}

/// None when the CLI is not installed, or has no plan limits.
fn limits(provider: AiProvider) -> Result<Option<Vec<Window>>, AppError> {
    if !matches!(provider, AiProvider::Claude | AiProvider::Codex) {
        return Ok(None);
    }
    let Some(c) = ai::cli(provider) else { return Ok(None) };
    let Some(bin) = ai::find_bin(c.bin) else { return Ok(None) };
    // an empty folder, like `ai::ask`: no project's settings or trust prompt reaches the CLI
    let dir = tempfile::tempdir()?;
    if provider == AiProvider::Claude {
        let out = ai::run(&bin, c.bin, &CLAUDE_ARGS, b"", dir.path())?;
        return claude_windows(&out).map(Some);
    }
    let mut cmd = Command::new(&bin);
    cmd.arg("app-server").current_dir(dir.path()).env("PATH", ai::child_path(&bin));
    codex_windows(&codex_rate_limits(cmd, TIMEOUT)?).map(Some)
}

#[tauri::command]
pub async fn usage_limits(provider: AiProvider) -> Result<Option<Vec<Window>>, AppError> {
    tauri::async_runtime::spawn_blocking(move || limits(provider)).await.map_err(|e| AppError::Ai(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const USAGE: &str = "You are currently using your subscription to power your Claude Code usage\n\n\
        Current session: 14% used · resets Oct 17 at 11:20pm (Europe/Berlin)\n\
        Current week (all models): 86% used · resets Oct 17 at 11pm (Europe/Berlin)\n\
        Current week (Fable): 0% used · resets Oct 17 at 11pm (Europe/Berlin)\n\n\
        What's contributing to your limits usage?\n  72% of your usage came from subagent-heavy sessions";

    fn report(result: &str, is_error: bool) -> String {
        json!({ "type": "result", "is_error": is_error, "result": result }).to_string()
    }

    fn window(label: &str, percent: f64, resets: Option<&str>, resets_at: Option<i64>, weekly: bool) -> Window {
        Window { label: label.into(), percent, resets: resets.map(String::from), resets_at, weekly }
    }

    #[test]
    fn claude_s_usage_report_yields_each_window_and_skips_the_breakdown() {
        let got = claude_windows(&report(USAGE, false)).unwrap();
        assert_eq!(got, vec![
            window("Session", 14.0, Some("Oct 17 at 11:20pm (Europe/Berlin)"), None, false),
            window("Week (all models)", 86.0, Some("Oct 17 at 11pm (Europe/Berlin)"), None, true),
            window("Week (Fable)", 0.0, Some("Oct 17 at 11pm (Europe/Berlin)"), None, true),
        ]);
    }

    #[test]
    fn a_claude_window_without_a_reset_or_under_one_percent_is_still_read() {
        assert_eq!(claude_line("Current week (all models): <1% used"), Some(window("Week (all models)", 1.0, None, None, true)));
        assert_eq!(claude_line("Last 7d · 1645 requests · 22 sessions"), None);
    }

    #[test]
    fn a_claude_report_without_windows_or_with_an_error_gives_its_first_line() {
        let api = "You are using an API key\n\nNo plan limits apply";
        assert!(matches!(claude_windows(&report(api, false)), Err(AppError::Ai(m)) if m == "You are using an API key"));
        assert!(matches!(claude_windows(&report("Not logged in", true)), Err(AppError::Ai(m)) if m == "Not logged in"));
        assert!(matches!(claude_windows("oops"), Err(AppError::Ai(m)) if m.starts_with("claude's answer is not JSON")));
    }

    #[test]
    fn codex_s_windows_are_named_by_their_length() {
        let result = json!({ "rateLimits": {
            "primary": { "usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 1_760_000_000 },
            "secondary": { "usedPercent": 40, "windowDurationMins": WEEK_MINS, "resetsAt": 1_760_500_000 },
        }});
        assert_eq!(codex_windows(&result).unwrap(), vec![
            window("5 hours", 12.5, None, Some(1_760_000_000), false),
            window("Week", 40.0, None, Some(1_760_500_000), true),
        ]);
        assert_eq!(window_label(1440), "Day");
        assert_eq!(window_label(2880), "2 days");
        assert_eq!(window_label(90), "90 minutes");
        let none = json!({ "rateLimits": { "primary": null, "secondary": null } });
        assert!(matches!(codex_windows(&none), Err(AppError::Ai(_))));
    }

    fn server(script: &str) -> (tempfile::TempDir, Command) {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("app-server.sh");
        std::fs::write(&f, script).unwrap();
        let mut cmd = Command::new("sh");
        cmd.arg(&f);
        (d, cmd)
    }

    #[test]
    fn the_rate_limits_are_asked_after_the_initialize_answer_and_notifications_are_skipped() {
        let (_d, cmd) = server(
            r#"read init; case "$init" in *'"initialize"'*) ;; *) exit 1;; esac
echo '{"id":1,"result":{"userAgent":"codex"}}'
read note; read req; case "$req" in *'account/rateLimits/read'*) ;; *) exit 1;; esac
echo '{"method":"account/rateLimits/updated","params":{}}'
echo '{"id":2,"method":"item/tool/requestUserInput","params":{}}'
echo '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":3}}}}'
read never"#,
        );
        let got = codex_rate_limits(cmd, Duration::from_secs(10)).unwrap();
        assert_eq!(got["rateLimits"]["primary"]["usedPercent"], 3);
    }

    #[test]
    fn a_codex_error_a_silent_server_and_an_early_exit_each_say_why() {
        let (_d, cmd) = server(
            r#"read init; echo '{"id":1,"result":{}}'; read note; read req
echo '{"id":2,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}'"#,
        );
        let err = codex_rate_limits(cmd, Duration::from_secs(10)).unwrap_err();
        assert!(matches!(err, AppError::Ai(m) if m == "codex account authentication required to read rate limits"));
        let (_d, cmd) = server("read init; sleep 30");
        let err = codex_rate_limits(cmd, Duration::from_millis(300)).unwrap_err();
        assert!(matches!(err, AppError::Ai(m) if m.contains("too long")));
        let (_d, cmd) = server("exit 0");
        let err = codex_rate_limits(cmd, Duration::from_secs(10)).unwrap_err();
        assert!(matches!(err, AppError::Ai(m) if m.contains("stopped before")));
    }
}
