use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAX: usize = 10;

// ponytail: one global lock for a file touched once per repo-open; per-path locking would buy nothing
static LOCK: Mutex<()> = Mutex::new(());

fn store(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recents.json"))
}

/// Most recent first, no duplicates, nothing that has stopped being a directory, capped.
fn normalize(list: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    list.into_iter()
        .filter(|p| seen.insert(p.clone()))
        .filter(|p| Path::new(p).is_dir())
        .take(MAX)
        .collect()
}

fn read(app: &AppHandle) -> Vec<String> {
    let Some(f) = store(app) else { return Vec::new() };
    serde_json::from_str(&std::fs::read_to_string(f).unwrap_or_default()).unwrap_or_default()
}

fn write(app: &AppHandle, list: &[String]) {
    let Some(f) = store(app) else { return };
    if let Some(dir) = f.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            log::warn!("recents: {e}");
            return;
        }
    }
    // a torn write reads back as invalid JSON, which load() cannot tell from "no recents yet"
    let tmp = f.with_extension("json.tmp");
    if let Err(e) = serde_json::to_string(list)
        .map_err(|e| e.to_string())
        .and_then(|j| std::fs::write(&tmp, j).map_err(|e| e.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &f).map_err(|e| e.to_string()))
    {
        let _ = std::fs::remove_file(&tmp);
        log::warn!("recents: {e}");
    }
}

pub fn load(app: &AppHandle) -> Vec<String> {
    normalize(read(app))
}

pub fn push(app: &AppHandle, path: &str) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = read(app);
    list.insert(0, path.to_string());
    write(app, &normalize(list));
}

pub fn clear(app: &AppHandle) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write(app, &[]);
}

/// `Path::strip_prefix` is component-aware, so `/Users/ab` under `/Users/a` stays untouched.
pub fn label(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return path.to_string();
    }
    match Path::new(path).strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(n: usize) -> (tempfile::TempDir, Vec<String>) {
        let root = tempfile::tempdir().unwrap();
        let paths = (0..n)
            .map(|i| {
                let p = root.path().join(format!("r{i}"));
                std::fs::create_dir(&p).unwrap();
                p.to_string_lossy().to_string()
            })
            .collect();
        (root, paths)
    }

    #[test]
    fn keeps_order_and_drops_duplicates() {
        let (_root, p) = dirs(3);
        let got = normalize(vec![p[2].clone(), p[0].clone(), p[2].clone(), p[1].clone()]);
        assert_eq!(got, vec![p[2].clone(), p[0].clone(), p[1].clone()]);
    }

    #[test]
    fn drops_paths_that_are_gone() {
        let (root, p) = dirs(2);
        std::fs::remove_dir(&p[0]).unwrap();
        assert_eq!(normalize(p.clone()), vec![p[1].clone()]);
        assert!(normalize(vec![root.path().join("never").to_string_lossy().to_string()]).is_empty());
    }

    #[test]
    fn caps_at_max() {
        let (_root, p) = dirs(MAX + 4);
        let got = normalize(p.clone());
        assert_eq!(got.len(), MAX);
        assert_eq!(got[0], p[0]);
    }

    #[test]
    fn a_repeat_open_moves_to_the_front() {
        let (_root, p) = dirs(3);
        let existing = vec![p[0].clone(), p[1].clone(), p[2].clone()];
        let mut with_push = existing.clone();
        with_push.insert(0, p[2].clone());
        assert_eq!(normalize(with_push), vec![p[2].clone(), p[0].clone(), p[1].clone()]);
    }

    #[test]
    fn labels_shorten_only_a_real_home_prefix() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(label(&format!("{home}/projects/app")), "~/projects/app");
        assert_eq!(label(&home), "~");
        assert_eq!(label(&format!("{home}x/projects")), format!("{home}x/projects"));
        assert_eq!(label("/opt/src"), "/opt/src");
    }
}
