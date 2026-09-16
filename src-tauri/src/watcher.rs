use crate::error::AppError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;

pub struct Handle {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn relevant(path: &Path, git_dir: &Path, common: &Path) -> bool {
    for dir in [git_dir, common] {
        if let Ok(rest) = path.strip_prefix(dir) {
            let s = rest.to_string_lossy();
            return !(s == "objects"
                || s.starts_with("objects/")
                || s == "lfs"
                || s.starts_with("lfs/")
                || s == "index.lock");
        }
    }
    true
}

/// Directories to watch: root, plus the git dir and common dir when they lie
/// outside root, each at most once and never nested under another.
pub fn watch_roots(root: &Path, git_dir: &Path, common: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    for cand in [common, git_dir] {
        if !dirs.iter().any(|w| cand.starts_with(w)) {
            dirs.push(cand.to_path_buf());
        }
    }
    dirs
}

pub fn start(app: &tauri::AppHandle, root: &Path, git_dir: &Path, common: &Path) -> Result<Handle, AppError> {
    let (tx, rx) = channel::<()>();
    let (gd, cd) = (git_dir.to_path_buf(), common.to_path_buf());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let hit = match res {
            Ok(ev) => ev.need_rescan() || ev.paths.iter().any(|p| relevant(p, &gd, &cd)),
            Err(_) => true,
        };
        if hit {
            let _ = tx.send(());
        }
    })
    .map_err(|e| AppError::Io(e.to_string()))?;
    for d in watch_roots(root, git_dir, common) {
        watcher.watch(&d, RecursiveMode::Recursive).map_err(|e| AppError::Io(e.to_string()))?;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        while !stop2.load(Ordering::Relaxed) {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(()) => {
                    let deadline = Instant::now() + Duration::from_millis(250);
                    while rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_ok() {}
                    let _ = app.emit("repo-changed", ());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(Handle { _watcher: watcher, stop })
}

#[cfg(test)]
mod tests {
    use super::{relevant, watch_roots};
    use std::path::{Path, PathBuf};

    #[test]
    fn watch_roots_covers_the_three_layouts() {
        // ordinary repo: git_dir and common both under root
        assert_eq!(
            watch_roots(Path::new("/r"), Path::new("/r/.git"), Path::new("/r/.git")),
            vec![PathBuf::from("/r")]
        );
        // separate git dir: outside root, git_dir == common, watched once
        assert_eq!(
            watch_roots(Path::new("/r"), Path::new("/g/.git"), Path::new("/g/.git")),
            vec![PathBuf::from("/r"), PathBuf::from("/g/.git")]
        );
        // linked worktree: git_dir nested under common, common covers it
        assert_eq!(
            watch_roots(
                Path::new("/wt"),
                Path::new("/main/.git/worktrees/wt"),
                Path::new("/main/.git")
            ),
            vec![PathBuf::from("/wt"), PathBuf::from("/main/.git")]
        );
    }

    #[test]
    fn filters_noise_under_the_git_dir_only() {
        let gd = Path::new("/r/.git");
        assert!(relevant(Path::new("/r/src/a.ts"), gd, gd));
        assert!(relevant(Path::new("/r/.git/index"), gd, gd));
        assert!(relevant(Path::new("/r/.git/HEAD"), gd, gd));
        assert!(relevant(Path::new("/r/.git/refs/heads/main"), gd, gd));
        assert!(!relevant(Path::new("/r/.git/index.lock"), gd, gd));
        assert!(!relevant(Path::new("/r/.git/objects/ab/cdef"), gd, gd));
        assert!(!relevant(Path::new("/r/.git/objects"), gd, gd));
        assert!(!relevant(Path::new("/r/.git/lfs/tmp/x"), gd, gd));
        assert!(relevant(Path::new("/r/.git/objects-foo"), gd, gd));
        let wt_gd = Path::new("/main/.git/worktrees/wt");
        let cd = Path::new("/main/.git");
        assert!(relevant(Path::new("/main/.git/worktrees/wt/index"), wt_gd, cd));
        assert!(!relevant(Path::new("/main/.git/objects/x"), wt_gd, cd));
    }
}
