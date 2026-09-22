#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // before Tauri initialises: this process may be the detached pty host rather than the app
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--pty-host") {
        match args.get(2) {
            Some(sock) => codebaer_lib::pty::daemon::run(std::path::Path::new(sock)),
            None => std::process::exit(2),
        }
    }
    codebaer_lib::run_app()
}
