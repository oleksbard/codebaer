pub mod error;
pub mod eol;
pub mod git;
pub mod status;
pub mod watcher;

pub use error::AppError;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[tauri::command]
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
        .manage(git::AppState::new())
        .enable_macos_default_menu(false)
        .menu(|app| {
            let app_menu = Submenu::with_items(app, "CodeBär", true, &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;
            let window = Submenu::with_items(app, "Window", true, &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ])?;
            Menu::with_items(app, &[&app_menu, &window])
        })
        .invoke_handler(tauri::generate_handler![git_version, initial_repo, git::open_repo, git::status, git::read_file, git::write_file, git::read_blob, git::stage_content, git::stage_path, git::unstage_path, git::revert_path, git::stage_all, git::unstage_all, git::discard_preview, git::discard_all, git::commit, git::branches, git::switch_branch, git::stash_push, git::stash_pop, git::list_files, git::push, git::pull, git::cancel])
        .run(tauri::generate_context!())
        .expect("error while running CodeBär");
}
