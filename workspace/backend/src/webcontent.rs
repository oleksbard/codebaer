//! Tauri's own handler for a stopped web content process reloads at once and with no limit. When the new process
//! also fails to start, that loop holds the main thread: the window stays empty, and a second launch exits at once,
//! because the single-instance callback needs the main thread too.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, Runtime, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const DELAYS: [Duration; 3] = [Duration::from_millis(500), Duration::from_secs(1), Duration::from_secs(2)];
/// A stop this long after the one before starts the delays again, so a rare crash always gets its reloads.
const CALM: Duration = Duration::from_secs(60);

static STOPS: Mutex<Stops> = Mutex::new(Stops { count: 0, last: None });
static ASKED: AtomicBool = AtomicBool::new(false);
static RESTARTING: AtomicBool = AtomicBool::new(false);

struct Stops {
    count: usize,
    last: Option<Instant>,
}

impl Stops {
    fn next(&mut self, now: Instant) -> Option<Duration> {
        if self.last.is_some_and(|t| now.duration_since(t) > CALM) {
            self.count = 0;
        }
        self.last = Some(now);
        self.count += 1;
        DELAYS.get(self.count - 1).copied()
    }
}

/// Read by the exit handler: the restart leaves the terminal host running, as a rebuild does, and the new app
/// reattaches to its sessions.
pub fn restarting() -> bool {
    RESTARTING.load(Ordering::Relaxed)
}

/// WebKit's public API gives no reason for the stop, so the log cannot say why.
pub fn stopped<R: Runtime>(webview: &Webview<R>) {
    let next = STOPS.lock().unwrap_or_else(|e| e.into_inner()).next(Instant::now());
    if let Some(delay) = next {
        log::warn!("web content process stopped, reloading in {delay:?}");
        let webview = webview.clone();
        // the main thread runs this handler, and a wait there would block the app
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if let Err(e) = webview.reload() {
                log::error!("reload after the web content process stopped: {e}");
            }
        });
        return;
    }
    log::error!("web content process stopped again, no reloads left");
    if ASKED.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = webview.app_handle().clone();
    app.dialog()
        .message(
            "The window stopped working and did not come back after a reload. Restart CodeBär to open it again. \
             A restart keeps your terminals running.",
        )
        .title("CodeBär")
        .parent(&webview.window())
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Quit".into()))
        .show(move |restart| {
            if restart {
                RESTARTING.store(true, Ordering::Relaxed);
                app.request_restart();
            } else {
                app.exit(0);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_reloads_wait_longer_each_time_then_the_reloads_run_out() {
        let mut stops = Stops { count: 0, last: None };
        let t = Instant::now();
        let waits: Vec<_> = (0..4).map(|i| stops.next(t + Duration::from_secs(i))).collect();
        assert_eq!(waits, [Some(DELAYS[0]), Some(DELAYS[1]), Some(DELAYS[2]), None]);
    }

    #[test]
    fn a_stop_after_a_calm_minute_starts_the_delays_again() {
        let mut stops = Stops { count: 0, last: None };
        let t = Instant::now();
        for i in 0..4 {
            stops.next(t + Duration::from_secs(i));
        }
        let later = t + Duration::from_secs(4) + CALM;
        assert_eq!(stops.next(later), Some(DELAYS[0]));
    }
}
