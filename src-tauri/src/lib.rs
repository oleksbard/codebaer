pub mod ai;
pub mod error;
pub mod eol;
pub mod git;
pub mod logs;
pub mod pty;
pub mod recents;
pub mod settings;
pub mod status;
pub mod watcher;

pub use error::AppError;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

#[tauri::command(async)]
fn git_version() -> Result<String, error::AppError> {
    let out = std::process::Command::new("git")
        .arg("--version")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GIT_SSH_COMMAND")
        .output()?;
    if !out.status.success() {
        return Err(error::AppError::Git(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// LaunchServices may inject its own argv entries, so the repo path is the last argument that is a directory.
fn repo_arg(args: &[String]) -> Option<String> {
    args.iter().rev().find(|a| std::path::Path::new(a).is_dir()).cloned()
}

/// The webview has no other way to leave a trace: a throw inside a Tauri channel callback is
/// invisible without devtools open at the time, and takes the channel with it.
#[tauri::command]
fn log_error(message: String) {
    log::error!("webview: {message}");
}

#[tauri::command]
fn initial_repo() -> Option<String> {
    repo_arg(&std::env::args().skip(1).collect::<Vec<_>>())
}

/// One recent repo, named and shortened the way the header names the open one.
#[derive(serde::Serialize)]
pub struct Recent {
    path: String,
    name: String,
    label: String,
}

impl Recent {
    fn new(path: String) -> Self {
        let dir = std::path::Path::new(&path);
        let name = git::repo_title(dir)
            .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
        let label = recents::label(&path);
        Recent { path, name, label }
    }

    /// A menu-bar item carries one string, so the header's two columns join into it.
    fn menu_label(&self) -> String {
        format!("{} - {}", self.name, self.label)
    }
}

/// The open repo is the top of the recents list, and reopening it is a no-op, so it is left out
/// of both the File menu and the in-app switcher.
fn recent_rows(app: &AppHandle) -> Vec<Recent> {
    let open = app.state::<git::AppState>().root().ok();
    recents::load(app)
        .into_iter()
        .filter(|p| open.as_deref() != Some(std::path::Path::new(p)))
        .map(Recent::new)
        .collect()
}

#[tauri::command(async)]
fn recent_repos(app: AppHandle) -> Vec<Recent> {
    recent_rows(&app)
}

fn recent_menu(app: &AppHandle) -> Option<Submenu<Wry>> {
    app.menu()?.get("file")?.as_submenu()?.get("file.recent")?.as_submenu().cloned()
}

/// Replaces the submenu's items in place, so the instance already in the menu bar stays put.
fn fill_recent(app: &AppHandle, menu: &Submenu<Wry>) -> tauri::Result<()> {
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    let rows = recent_rows(app);
    menu.set_enabled(!rows.is_empty())?;
    for r in &rows {
        let id = format!("recent:{}", r.path);
        menu.append(&MenuItem::with_id(app, id, r.menu_label(), true, None::<&str>)?)?;
    }
    if !rows.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "recent.clear", "Clear Menu", true, None::<&str>)?)?;
    }
    Ok(())
}

/// AppKit rejects menu mutation off the main thread, and `open_repo` is an async command.
pub fn refresh_recent_menu(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(m) = recent_menu(&handle) {
            if let Err(e) = fill_recent(&handle, &m) {
                log::warn!("recent menu: {e}");
            }
        }
    });
}

pub fn run_app() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(p) = repo_arg(argv.get(1..).unwrap_or(&[])) {
                let _ = app.emit("open-repo", p);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // the plugin saves is_visible(), which macOS reports false for a minimized window;
                // with VISIBLE on, quitting while minimized would keep the next launch hidden
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .manage(git::AppState::new())
        .manage(pty::client::PtyState::new())
        .setup(|app| {
            // after the path resolver is managed, which is the only way to ask where the logs go
            if let Ok(dir) = app.path().app_log_dir() {
                logs::init(&dir, "app");
            }
            // config windows are built and their saved state restored before setup runs
            if let Some(w) = app.get_webview_window("main") {
                w.show()?;
                w.set_focus()?;
            }
            // the menu builder runs before the path resolver is managed, so Open Recent
            // is built empty there and only gets its items once app_config_dir resolves
            if let Some(m) = recent_menu(app.handle()) {
                fill_recent(app.handle(), &m)?;
            }
            Ok(())
        })
        .enable_macos_default_menu(false)
        .menu(|app| {
            let app_menu = Submenu::with_items(app, "CodeBär", true, &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "app.settings", "Settings\u{2026}", true, Some("CmdOrCtrl+,"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;
            // macOS delivers Cut/Copy/Paste/Select All/Undo to the webview only through these
            // menu items' key equivalents; without an Edit menu the shortcuts are dead in every input
            let edit = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            let recent = Submenu::with_id(app, "file.recent", "Open Recent", false)?;
            let file = Submenu::with_id_and_items(app, "file", "File", true, &[
                &MenuItem::with_id(app, "file.open", "Open Folder\u{2026}", true, Some("CmdOrCtrl+O"))?,
                &recent,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "file.orphans", "Terminals and Orphans\u{2026}", true, None::<&str>)?,
            ])?;
            let window = Submenu::with_items(app, "Window", true, &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ])?;
            Menu::with_items(app, &[&app_menu, &file, &edit, &window])
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "file.open" {
                let _ = app.emit("menu-open-folder", ());
            } else if id == "file.orphans" {
                let _ = app.emit("menu-orphans", ());
            } else if id == "app.settings" {
                let _ = app.emit("menu-settings", ());
            } else if id == "recent.clear" {
                recents::clear(app);
                refresh_recent_menu(app);
            } else if let Some(path) = id.strip_prefix("recent:") {
                // not "open-repo": that one also carries an external launch, which outranks an open overlay
                let _ = app.emit("menu-open-recent", path.to_string());
            }
        })
        .invoke_handler(tauri::generate_handler![git_version, initial_repo, log_error, recent_repos, git::open_repo, git::status, git::read_file, git::write_file, git::read_blob, git::blame, git::stage_content, git::stage_path, git::unstage_path, git::revert_path, git::stage_all, git::unstage_all, git::discard_preview, git::discard_all, git::commit, git::branches, git::switch_branch, git::create_branch, git::stash_push, git::stash_pop, git::list_files, git::list_dir, git::push, git::pull, git::fetch, git::cancel, ai::ai_commit_message, settings::settings_get, settings::settings_set, pty::client::term_menu, pty::client::term_subscribe, pty::client::term_spawn, pty::client::term_input, pty::client::term_input_bytes, pty::client::term_resize, pty::client::term_kill, pty::client::term_close, pty::client::term_check_cwd, pty::client::term_relist, pty::orphans::term_orphans, pty::orphans::term_restore, pty::orphans::term_kill_orphan])
        .build(tauri::generate_context!())
        .expect("error while running CodeBär")
        .run(|app, event| {
            // both variants: closing the last window gives ExitRequested, but Cmd-Q and the
            // Quit menu item go through applicationWillTerminate, which tauri maps to Exit.
            // A rebuild SIGKILLs us and reaches neither, which is how the host tells them apart.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                pty::client::shutdown(app);
            }
        });
}
