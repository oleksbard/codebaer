//! Anonymous usage data for PostHog, off until the user turns it on. An event holds only counts and fixed names,
//! never a path, a name or any text from the user, and PostHog makes no person profile of it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};

use crate::settings::{self, UsageData};

/// The project's write-only `phc_` key. Set only by main's packaging builds, so no other build ever sends.
const KEY: Option<&str> = option_env!("CODEBAER_POSTHOG_KEY");
const BATCH_URL: &str = "https://eu.i.posthog.com/batch/";
const FILE: &str = "telemetry-codebaer.json";
/// The launch on which the app asks once whether to share.
const ASK_AT: u64 = 3;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// The quit waits this long at most for the last summary.
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const SUMMARY_EVERY: Duration = Duration::from_secs(60 * 60);

/// Everything the app counts. A count goes out only as a number in `usage_summary`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Counter {
    RepoOpened,
    HunkAccepted,
    HunkRejected,
    FileAccepted,
    FileRejected,
    Commit,
    AiCommitMessage,
    Push,
    TerminalShell,
    TerminalClaude,
    TerminalCodex,
    TerminalOpencode,
    TerminalOther,
}

impl Counter {
    /// `argv0` is one of the programs `term_menu` found, never a path the webview made up.
    pub fn terminal(argv0: &str) -> Self {
        match argv0 {
            "claude" => Self::TerminalClaude,
            "codex" => Self::TerminalCodex,
            "opencode" => Self::TerminalOpencode,
            _ => Self::TerminalOther,
        }
    }
}

static COUNTS: Mutex<BTreeMap<Counter, u64>> = Mutex::new(BTreeMap::new());
static LOCK: Mutex<()> = Mutex::new(());

/// What the app keeps on this machine. Only `id` is ever sent, and only while sharing is on.
#[derive(Debug, Default, PartialEq)]
struct Local {
    id: Option<String>,
    launches: u64,
    asked: bool,
}

fn read_local(path: &Path) -> Local {
    let map = settings::read_map(path).unwrap_or_default();
    Local {
        id: map.get("id").and_then(Value::as_str).map(String::from),
        launches: map.get("launches").and_then(Value::as_u64).unwrap_or_default(),
        asked: map.get("asked").and_then(Value::as_bool).unwrap_or_default(),
    }
}

fn write_local(path: &Path, keys: &[(&str, Value)]) {
    let map = keys.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect();
    if let Err(e) = settings::write_keys(path, map) {
        log::warn!("telemetry: {e:?}");
    }
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    settings::config_file(app, FILE).ok()
}

fn env_says(var: &impl Fn(&str) -> Option<String>, key: &str, values: &[&str]) -> bool {
    var(key).is_some_and(|v| values.contains(&v.trim().to_ascii_lowercase().as_str()))
}

/// `DO_NOT_TRACK` is the shared convention; CI is left out so the smoke runs never count as users.
fn blocked_by(var: impl Fn(&str) -> Option<String>) -> bool {
    let ci = var("CI").is_some_and(|v| !matches!(v.trim(), "" | "0" | "false"));
    ci || env_says(&var, "DO_NOT_TRACK", &["1", "true", "yes"])
        || env_says(&var, "CODEBAER_TELEMETRY", &["0", "off", "false", "no"])
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Logs each batch instead of sending it, in any build, so a user can see what would go out.
fn debug() -> bool {
    env_says(&env, "CODEBAER_TELEMETRY_DEBUG", &["1", "true", "yes"])
}

/// Trimmed: a secret pasted with a newline is a different key, and PostHog drops its events without an error.
fn usable(key: Option<&str>) -> Option<&str> {
    key.map(str::trim).filter(|k| !k.is_empty())
}

fn key() -> Option<&'static str> {
    usable(KEY)
}

/// Whether this build and environment can send at all; the setting decides the rest.
fn allowed() -> bool {
    static ALLOWED: OnceLock<bool> = OnceLock::new();
    *ALLOWED.get_or_init(|| (key().is_some() || debug()) && !blocked_by(env))
}

/// Reads the settings file each time, like the AI gate, so a hand edit applies at once.
fn sharing<R: Runtime>(app: &AppHandle<R>) -> bool {
    allowed() && settings::load(app).usage_data == UsageData::On
}

/// Made when sharing is on and none is there yet; dropped when sharing goes off. Sharing is read again under the
/// lock, so a summary that races a turn-off cannot write a new id after `setting_changed` dropped the old one.
fn install_id(app: &AppHandle) -> Option<String> {
    let path = file(app)?;
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !sharing(app) {
        return None;
    }
    if let Some(id) = read_local(&path).id {
        return Some(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    write_local(&path, &[("id", Value::String(id.clone()))]);
    Some(id)
}

fn event(name: &str, id: &str, mut props: Map<String, Value>) -> Value {
    props.extend([
        ("$process_person_profile".into(), json!(false)),
        ("$geoip_disable".into(), json!(true)),
        ("$lib".into(), json!("codebaer")),
        ("app_version".into(), json!(env!("CARGO_PKG_VERSION"))),
        ("os".into(), json!(std::env::consts::OS)),
        ("arch".into(), json!(std::env::consts::ARCH)),
    ]);
    json!({ "event": name, "distinct_id": id, "timestamp": jiff::Timestamp::now().to_string(), "properties": props })
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // reqwest is built without a provider, as the updater has it; whichever installs first serves both
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder().timeout(SEND_TIMEOUT).build().inspect_err(|e| log::info!("telemetry: {e}")).ok()
        })
        .as_ref()
}

/// A failure is logged at info: offline is normal, and the smoke run fails on any error in the log.
async fn post(events: Vec<Value>, timeout: Duration) {
    if events.is_empty() {
        return;
    }
    let Some(key) = key().filter(|_| !debug()) else {
        log::info!("telemetry: would send {}", Value::Array(events));
        return;
    };
    let Some(client) = client() else { return };
    let body = json!({ "api_key": key, "batch": events });
    let sent = client.post(BATCH_URL).timeout(timeout).json(&body).send().await;
    if let Err(e) = sent.and_then(reqwest::Response::error_for_status) {
        log::info!("telemetry: {e}");
    }
}

fn send(event: Value) {
    tauri::async_runtime::spawn(post(vec![event], SEND_TIMEOUT));
}

fn summary(app: &AppHandle) -> Option<Value> {
    let counts = std::mem::take(&mut *COUNTS.lock().unwrap_or_else(|e| e.into_inner()));
    if counts.is_empty() || !sharing(app) {
        return None;
    }
    let props = counts.into_iter().filter_map(|(c, n)| Some((serde_json::to_value(c).ok()?.as_str()?.to_string(), json!(n))));
    Some(event("usage_summary", &install_id(app)?, props.collect()))
}

pub fn count<R: Runtime>(app: &AppHandle<R>, counter: Counter) {
    if sharing(app) {
        *COUNTS.lock().unwrap_or_else(|e| e.into_inner()).entry(counter).or_default() += 1;
    }
}

/// Run once from setup: counts the launch until the user has been asked, says the app opened, and starts the
/// hourly summary.
pub fn launched(app: &AppHandle) {
    let off = settings::load(app).usage_data == UsageData::Off;
    if let Some(path) = file(app) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let local = read_local(&path);
        // sharing turned off by a hand edit of the settings file, which `setting_changed` never saw
        if off && local.id.is_some() {
            write_local(&path, &[("id", Value::Null)]);
        }
        if allowed() && !local.asked {
            write_local(&path, &[("launches", json!(local.launches.saturating_add(1)))]);
        }
    }
    if !allowed() {
        return;
    }
    if sharing(app) {
        if let Some(id) = install_id(app) {
            send(event("app_opened", &id, Map::new()));
        }
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SUMMARY_EVERY);
        if let Some(e) = summary(&app) {
            tauri::async_runtime::block_on(post(vec![e], SEND_TIMEOUT));
        }
    });
}

/// Blocks the quit for `EXIT_TIMEOUT` at most. A second call finds the counts already taken and sends nothing.
pub fn exiting(app: &AppHandle) {
    if let Some(e) = summary(app) {
        tauri::async_runtime::block_on(post(vec![e], EXIT_TIMEOUT));
    }
}

/// Called after the settings file took a new value. A change made in Settings is an answer too, so the launch
/// question never comes after it.
pub fn setting_changed(app: &AppHandle, before: UsageData, after: UsageData) {
    if before == after {
        return;
    }
    if let Some(path) = file(app) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        write_local(&path, &[("asked", json!(true))]);
    }
    if after == UsageData::On {
        if let Some(id) = install_id(app) {
            send(event("usage_data_enabled", &id, Map::new()));
        }
        return;
    }
    COUNTS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    if let Some(path) = file(app) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        write_local(&path, &[("id", Value::Null)]);
    }
}

#[tauri::command]
pub fn telemetry_available() -> bool {
    allowed()
}

fn prompt_due(local: &Local, usage: UsageData) -> bool {
    usage == UsageData::Off && !local.asked && local.launches >= ASK_AT
}

/// True from the third launch on, while sharing is off and the user has not answered.
#[tauri::command(async)]
pub fn telemetry_prompt(app: AppHandle) -> bool {
    let Some(path) = file(&app).filter(|_| allowed()) else { return false };
    prompt_due(&read_local(&path), settings::load(&app).usage_data)
}

/// The prompt never comes back. A refusal goes out once, under an id made for it alone and then forgotten, so it
/// cannot be joined to anything else.
#[tauri::command(async)]
pub fn telemetry_answered(app: AppHandle, share: bool) {
    if let Some(path) = file(&app) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        write_local(&path, &[("asked", json!(true))]);
    }
    if !share && allowed() {
        send(event("usage_data_declined", &uuid::Uuid::new_v4().to_string(), Map::new()));
    }
}

#[tauri::command(async)]
pub fn telemetry_count(app: AppHandle, counter: Counter) {
    count(&app, counter);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_string())
    }

    #[test]
    fn an_opt_out_variable_or_ci_blocks_sending() {
        for pairs in [
            &[("DO_NOT_TRACK", "1")][..],
            &[("DO_NOT_TRACK", "true")],
            &[("CODEBAER_TELEMETRY", "0")],
            &[("CODEBAER_TELEMETRY", "off")],
            &[("CI", "true")],
            &[("CI", "1")],
        ] {
            assert!(blocked_by(vars(pairs)), "{pairs:?}");
        }
    }

    #[test]
    fn other_values_leave_sending_to_the_setting() {
        for pairs in [
            &[][..],
            &[("DO_NOT_TRACK", "0")],
            &[("DO_NOT_TRACK", "")],
            &[("CODEBAER_TELEMETRY", "1")],
            &[("CI", "false")],
            &[("CI", "")],
        ] {
            assert!(!blocked_by(vars(pairs)), "{pairs:?}");
        }
    }

    #[test]
    fn the_key_is_trimmed_and_a_blank_one_is_none() {
        assert_eq!(usable(Some("phc_abc\n")), Some("phc_abc"));
        assert_eq!(usable(Some(" phc_abc ")), Some("phc_abc"));
        assert_eq!(usable(Some(" \n")), None);
        assert_eq!(usable(None), None);
    }

    #[test]
    fn an_event_carries_no_person_profile_and_no_location() {
        let e = event("app_opened", "id-1", Map::new());
        assert_eq!(e["event"], "app_opened");
        assert_eq!(e["distinct_id"], "id-1");
        assert_eq!(e["properties"]["$process_person_profile"], false);
        assert_eq!(e["properties"]["$geoip_disable"], true);
        assert_eq!(e["properties"]["app_version"], env!("CARGO_PKG_VERSION"));
        let keys: Vec<&String> = e["properties"].as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 6, "{keys:?}");
    }

    #[test]
    fn a_counter_has_a_fixed_snake_case_name() {
        assert_eq!(serde_json::to_value(Counter::AiCommitMessage).unwrap(), "ai_commit_message");
        assert_eq!(serde_json::from_value::<Counter>(json!("hunk_accepted")).unwrap(), Counter::HunkAccepted);
        assert!(serde_json::from_value::<Counter>(json!("/Users/me/repo")).is_err());
    }

    #[test]
    fn only_the_known_agents_are_named() {
        assert_eq!(Counter::terminal("claude"), Counter::TerminalClaude);
        assert_eq!(Counter::terminal("opencode"), Counter::TerminalOpencode);
        for other in ["node", "python3", "deno", "/opt/homebrew/bin/claude"] {
            assert_eq!(Counter::terminal(other), Counter::TerminalOther, "{other}");
        }
    }

    #[test]
    fn the_question_comes_from_the_third_launch_until_it_is_answered() {
        let at = |launches, asked| Local { id: None, launches, asked };
        assert!(!prompt_due(&at(2, false), UsageData::Off));
        assert!(prompt_due(&at(3, false), UsageData::Off));
        assert!(prompt_due(&at(9, false), UsageData::Off));
        assert!(!prompt_due(&at(3, true), UsageData::Off));
        assert!(!prompt_due(&at(3, false), UsageData::On));
    }

    #[test]
    fn the_local_file_falls_back_per_key() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(FILE);
        assert_eq!(read_local(&f), Local::default());
        std::fs::write(&f, r#"{"id": 7, "launches": "3", "asked": true}"#).unwrap();
        assert_eq!(read_local(&f), Local { id: None, launches: 0, asked: true });
        write_local(&f, &[("id", json!("abc")), ("launches", json!(4))]);
        assert_eq!(read_local(&f), Local { id: Some("abc".into()), launches: 4, asked: true });
        write_local(&f, &[("id", Value::Null)]);
        assert_eq!(read_local(&f).id, None);
    }
}
