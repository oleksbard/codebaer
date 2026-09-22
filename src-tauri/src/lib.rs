pub mod ai;
pub mod error;
pub mod eol;
pub mod git;
pub mod pty;
pub mod recents;
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

#[tauri::command]
fn initial_repo() -> Option<String> {
    repo_arg(&std::env::args().skip(1).collect::<Vec<_>>())
}

fn recent_menu(app: &AppHandle) -> Option<Submenu<Wry>> {
    app.menu()?.get("file")?.as_submenu()?.get("file.recent")?.as_submenu().cloned()
}

/// Replaces the submenu's items in place, so the instance already in the menu bar stays put.
fn fill_recent(app: &AppHandle, menu: &Submenu<Wry>) -> tauri::Result<()> {
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    let paths = recents::load(app);
    menu.set_enabled(!paths.is_empty())?;
    for p in &paths {
        menu.append(&MenuItem::with_id(app, format!("recent:{p}"), recents::label(p), true, None::<&str>)?)?;
    }
    if !paths.is_empty() {
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
    env_logger::init();
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
            } else if id == "recent.clear" {
                recents::clear(app);
                refresh_recent_menu(app);
            } else if let Some(path) = id.strip_prefix("recent:") {
                // not "open-repo": that one also carries an external launch, which outranks an open overlay
                let _ = app.emit("menu-open-recent", path.to_string());
            }
        })
        .invoke_handler(tauri::generate_handler![git_version, initial_repo, git::open_repo, git::status, git::read_file, git::write_file, git::read_blob, git::blame, git::stage_content, git::stage_path, git::unstage_path, git::revert_path, git::stage_all, git::unstage_all, git::discard_preview, git::discard_all, git::commit, git::branches, git::switch_branch, git::create_branch, git::stash_push, git::stash_pop, git::list_files, git::push, git::pull, git::fetch, git::cancel, ai::ai_commit_message, pty::client::term_menu, pty::client::term_subscribe, pty::client::term_spawn, pty::client::term_input, pty::client::term_input_bytes, pty::client::term_resize, pty::client::term_kill, pty::client::term_close])
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
