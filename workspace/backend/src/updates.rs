use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::AppError;

/// Set only by main's packaging builds, so a local `tauri build` never replaces itself with a release. macOS only
/// for now: the Linux packages need a password to install, and plugin 2.12's check sets SSL_CERT_FILE for the
/// whole process there, which every git and shell this app starts afterwards would inherit.
const BUILT_TO_UPDATE: bool =
    cfg!(target_os = "macos") && matches!(option_env!("CODEBAER_UPDATES"), Some(v) if !v.is_empty());

/// reqwest has no timeout of its own, and a check that never ends holds the slot every later check waits on.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// For the whole download, about 9 MB.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Read by the exit handler: a restart into an update whose terminal host speaks this one's protocol leaves the
/// host running, as a rebuild does, and the new app reattaches to its sessions.
static KEEP_TERMINALS: AtomicBool = AtomicBool::new(false);

pub fn enabled() -> bool {
    BUILT_TO_UPDATE
}

pub fn keeps_terminals() -> bool {
    KEEP_TERMINALS.load(Ordering::Relaxed)
}

/// The newer release a check found, until the restart that installs it. Async, so a second check waits for the
/// first one's answer, and an install for the check.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Available {
    version: String,
    /// The release's page, for its notes.
    page: Option<String>,
    keeps_terminals: bool,
}

fn available(update: &Update) -> Available {
    Available {
        version: update.version.clone(),
        page: release_page(update.download_url.as_str()),
        keeps_terminals: keeps(&update.raw_json),
    }
}

/// Only a manifest that names this protocol can carry the sessions over; one that names none may be older than
/// the field.
fn keeps(manifest: &Value) -> bool {
    manifest.get("proto").and_then(Value::as_u64) == Some(u64::from(crate::pty::proto::PROTO))
}

/// A GitHub download, `.../releases/download/<tag>/<file>`, sits under the page `.../releases/tag/<tag>`.
fn release_page(download: &str) -> Option<String> {
    let (dir, _) = download.rsplit_once('/')?;
    let (base, tag) = dir.rsplit_once("/releases/download/")?;
    (!tag.is_empty() && !tag.contains('/')).then(|| format!("{base}/releases/tag/{tag}"))
}

/// A release that went out without this platform's files is no update for it.
fn found(checked: tauri_plugin_updater::Result<Option<Update>>) -> Result<Option<Update>, AppError> {
    match checked {
        Err(tauri_plugin_updater::Error::TargetsNotFound(_)) => Ok(None),
        other => other.map_err(failed),
    }
}

fn failed(e: tauri_plugin_updater::Error) -> AppError {
    AppError::Io(e.to_string())
}

#[tauri::command]
pub fn update_enabled() -> bool {
    enabled()
}

/// None when this is the newest version. Reads the manifest only: the download waits for the restart.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<Available>, AppError> {
    if !enabled() {
        return Ok(None);
    }
    let mut slot = state.0.lock().await;
    if let Some(update) = slot.as_ref() {
        return Ok(Some(available(update)));
    }
    let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(failed)?;
    let Some(update) = found(updater.check().await)? else { return Ok(None) };
    log::info!("update: {} is out", update.version);
    let out = available(&update);
    *slot = Some(update);
    Ok(Some(out))
}

/// Downloads and verifies the update, puts it in place of this app and starts it. The frontend has already asked
/// about everything the restart drops. The update stays in the slot until it is installed, so a failure can be
/// retried.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), AppError> {
    let mut slot = state.0.lock().await;
    let mut update = slot.clone().ok_or_else(|| AppError::Io("no update has been found".into()))?;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let bytes = update.download(|_, _| {}, || {}).await.map_err(failed)?;
    let version = update.version.clone();
    let keep = keeps(&update.raw_json);
    // off the async workers: the install waits on the main thread for an admin password when it cannot write the
    // app's folder itself
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
        .map_err(failed)?;
    log::info!("update: installed {version}, restarting");
    // the app runs on for a moment after the restart request, and a second call in it must not install again
    *slot = None;
    KEEP_TERMINALS.store(keep, Ordering::Relaxed);
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_download_names_its_release_page() {
        let url = "https://github.com/oleksbard/codebaer/releases/download/v0.6.0/codebaer-macos-arm64.tar.gz";
        assert_eq!(release_page(url).as_deref(), Some("https://github.com/oleksbard/codebaer/releases/tag/v0.6.0"));
    }

    #[test]
    fn a_download_from_elsewhere_has_no_page() {
        for url in [
            "https://example.com/codebaer-macos-arm64.tar.gz",
            "https://github.com/o/r/releases/download/codebaer.tar.gz",
            "https://github.com/o/r/releases/download//codebaer.tar.gz",
        ] {
            assert_eq!(release_page(url), None, "{url}");
        }
    }

    #[test]
    fn only_a_manifest_naming_this_protocol_keeps_the_terminals() {
        let proto = crate::pty::proto::PROTO;
        assert!(keeps(&json!({ "version": "9.0.0", "proto": proto })));
        for manifest in [
            json!({ "version": "9.0.0", "proto": proto + 1 }),
            json!({ "version": "9.0.0" }),
            json!({ "version": "9.0.0", "proto": proto.to_string() }),
            json!({ "version": "9.0.0", "proto": null }),
        ] {
            assert!(!keeps(&manifest), "{manifest}");
        }
    }

    #[test]
    fn a_release_without_this_platform_is_no_update() {
        let missing = Err(tauri_plugin_updater::Error::TargetsNotFound(vec!["darwin-aarch64".into()]));
        assert!(matches!(found(missing), Ok(None)));
        assert!(matches!(found(Ok(None)), Ok(None)));
        let offline = Err(tauri_plugin_updater::Error::Network("offline".into()));
        assert!(matches!(found(offline), Err(AppError::Io(detail)) if detail.contains("offline")));
    }
}
