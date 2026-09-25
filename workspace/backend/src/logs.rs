use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Long enough for a bug reported a couple of weeks after it happened, short enough that the
/// folder never needs thinking about.
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// The pty host is a second process, started before Tauri and with no AppHandle to ask where
/// the log directory is.
pub const DIR_ENV: &str = "CODEBAER_LOG_DIR";

/// One file per UTC day, appended to by the app and the pty host alike. UTC because that is
/// what env_logger stamps the lines with, and a file whose name disagrees with its contents is
/// worse than one that is a couple of hours off the wall clock.
struct Daily {
    dir: PathBuf,
}

impl Write for Daily {
    // ponytail: reopened per record, which is what makes the day rollover and the sweep need no
    // state at all. A held handle if anything ever logs at volume.
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // stderr as well, so `tauri dev` still shows it in the terminal it was started from
        let _ = std::io::stderr().write_all(buf);
        let day = jiff::Timestamp::now().strftime("%Y-%m-%d");
        let path = self.dir.join(format!("{day}.log"));
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stderr().flush()
    }
}

/// Installs the file logger for the calling process. Every process does this for itself, and
/// each one sweeps, so the retention holds however the app was started. `who` separates the app's
/// lines from the pty host's, which outlives it and goes on writing to the same file.
pub fn init(dir: &Path, who: &str) {
    let _ = fs::create_dir_all(dir);
    sweep(dir, SystemTime::now());
    let sink = Daily { dir: dir.to_path_buf() };
    // env_logger's own default keeps `error` only, which would drop every warning the app
    // already writes and had nowhere to put. RUST_LOG still overrides this.
    let env = env_logger::Env::default().default_filter_or("info");
    let _ = env_logger::Builder::from_env(env).target(env_logger::Target::Pipe(Box::new(sink))).try_init();
    // also what tells a reader where one run ends and the next begins
    log::info!("{who} {} starting, pid {}", env!("CARGO_PKG_VERSION"), std::process::id());
}

fn sweep(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().is_none_or(|x| x != "log") {
            continue;
        }
        let aged = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > RETENTION);
        if aged {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_lands_in_a_file_the_sweep_can_date() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = Daily { dir: dir.path().to_path_buf() };
        sink.write_all(b"the line that was lost\n").unwrap();

        let written: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.path()).collect();
        let [path] = written.as_slice() else { panic!("expected exactly one log file, got {written:?}") };
        assert_eq!(path.extension().unwrap(), "log");
        assert_eq!(fs::read_to_string(path).unwrap(), "the line that was lost\n");
        // the name is what a person scanning the folder reads, and what dates the retention
        assert_eq!(path.file_stem().unwrap().to_str().unwrap().len(), "2026-09-22".len());
    }

    #[test]
    fn sweep_drops_only_logs_past_the_retention() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let write = |name: &str, age: Duration| {
            let path = dir.path().join(name);
            let f = fs::File::create(&path).unwrap();
            f.set_modified(now - age).unwrap();
            path
        };
        let stale = write("2026-01-01.log", RETENTION + Duration::from_secs(60));
        let fresh = write("2026-09-22.log", RETENTION - Duration::from_secs(60));
        // the directory is the app's own, but nothing here may delete what it did not write
        let other = write("notes.txt", RETENTION * 2);

        sweep(dir.path(), now);

        assert!(!stale.exists(), "a log past the retention should be gone");
        assert!(fresh.exists(), "a log inside the retention should survive");
        assert!(other.exists(), "only .log files are ours to remove");
    }
}
