use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAX: usize = 10;
const RECENTS: &str = "recents.json";
const FAVORITES: &str = "favorites.json";

// ponytail: one global lock for files touched once per repo-open or star click; per-path locking would buy nothing
static LOCK: Mutex<()> = Mutex::new(());

pub struct Entry {
    pub path: String,
    pub favorite: bool,
}

fn store(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

/// Most recent first, no duplicates, nothing that has stopped being a directory. The cap leaves favorites out,
/// so a favorite opened long ago still keeps its place in the order.
fn normalize(list: Vec<String>, favorites: &HashSet<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut others = 0;
    list.into_iter()
        .filter(|p| seen.insert(p.clone()))
        .filter(|p| Path::new(p).is_dir())
        .filter(|p| {
            if favorites.contains(p) {
                return true;
            }
            others += 1;
            others <= MAX
        })
        .collect()
}

/// Favorites first, each group most recent first.
fn ordered(list: Vec<String>, favorites: &HashSet<String>) -> Vec<Entry> {
    let (mut rows, rest): (Vec<_>, Vec<_>) = normalize(list, favorites)
        .into_iter()
        .map(|path| Entry { favorite: favorites.contains(&path), path })
        .partition(|e| e.favorite);
    rows.extend(rest);
    rows
}

fn read(app: &AppHandle, name: &str) -> Vec<String> {
    let Some(f) = store(app, name) else { return Vec::new() };
    serde_json::from_str(&std::fs::read_to_string(f).unwrap_or_default()).unwrap_or_default()
}

fn write(app: &AppHandle, name: &str, list: &[String]) {
    let Some(f) = store(app, name) else { return };
    if let Some(dir) = f.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            log::warn!("{name}: {e}");
            return;
        }
    }
    // a torn write reads back as invalid JSON, which read() cannot tell from an empty list
    let tmp = f.with_extension("json.tmp");
    if let Err(e) = serde_json::to_string(list)
        .map_err(|e| e.to_string())
        .and_then(|j| std::fs::write(&tmp, j).map_err(|e| e.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &f).map_err(|e| e.to_string()))
    {
        let _ = std::fs::remove_file(&tmp);
        log::warn!("{name}: {e}");
    }
}

fn favorites(app: &AppHandle) -> HashSet<String> {
    read(app, FAVORITES).into_iter().collect()
}

pub fn load(app: &AppHandle) -> Vec<Entry> {
    ordered(read(app, RECENTS), &favorites(app))
}

pub fn push(app: &AppHandle, path: &str) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = read(app, RECENTS);
    list.insert(0, path.to_string());
    write(app, RECENTS, &normalize(list, &favorites(app)));
}

/// Clears the recents but keeps the favorites.
pub fn clear(app: &AppHandle) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let favorites = favorites(app);
    let kept: Vec<String> = read(app, RECENTS).into_iter().filter(|p| favorites.contains(p)).collect();
    write(app, RECENTS, &kept);
}

/// Only a repo already in the recents can become a favorite, so the webview cannot add a folder the user never
/// opened.
fn toggled(mut favorites: Vec<String>, recents: &[String], path: &str, favorite: bool) -> Vec<String> {
    favorites.retain(|p| p != path);
    if favorite && recents.iter().any(|p| p == path) {
        favorites.push(path.to_string());
    }
    favorites
}

pub fn set_favorite(app: &AppHandle, path: &str, favorite: bool) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let list = toggled(read(app, FAVORITES), &read(app, RECENTS), path, favorite);
    write(app, FAVORITES, &list);
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

    fn none() -> HashSet<String> {
        HashSet::new()
    }

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
        let got = normalize(vec![p[2].clone(), p[0].clone(), p[2].clone(), p[1].clone()], &none());
        assert_eq!(got, vec![p[2].clone(), p[0].clone(), p[1].clone()]);
    }

    #[test]
    fn drops_paths_that_are_gone() {
        let (root, p) = dirs(2);
        std::fs::remove_dir(&p[0]).unwrap();
        assert_eq!(normalize(p.clone(), &none()), vec![p[1].clone()]);
        assert!(normalize(vec![root.path().join("never").to_string_lossy().to_string()], &none()).is_empty());
    }

    #[test]
    fn caps_at_max() {
        let (_root, p) = dirs(MAX + 4);
        let got = normalize(p.clone(), &none());
        assert_eq!(got.len(), MAX);
        assert_eq!(got[0], p[0]);
    }

    #[test]
    fn a_repeat_open_moves_to_the_front() {
        let (_root, p) = dirs(3);
        let existing = vec![p[0].clone(), p[1].clone(), p[2].clone()];
        let mut with_push = existing.clone();
        with_push.insert(0, p[2].clone());
        assert_eq!(normalize(with_push, &none()), vec![p[2].clone(), p[0].clone(), p[1].clone()]);
    }

    #[test]
    fn favorites_stay_past_the_cap() {
        let (_root, p) = dirs(MAX + 3);
        let favorites = HashSet::from([p[MAX + 2].clone()]);
        let got = normalize(p.clone(), &favorites);
        assert_eq!(got.len(), MAX + 1);
        assert_eq!(got[..MAX], p[..MAX]);
        assert_eq!(got[MAX], p[MAX + 2]);
    }

    #[test]
    fn favorites_come_first_and_each_group_keeps_its_order() {
        let (_root, p) = dirs(4);
        let favorites = HashSet::from([p[1].clone(), p[3].clone()]);
        let got: Vec<(String, bool)> =
            ordered(p.clone(), &favorites).into_iter().map(|e| (e.path, e.favorite)).collect();
        assert_eq!(got, vec![
            (p[1].clone(), true),
            (p[3].clone(), true),
            (p[0].clone(), false),
            (p[2].clone(), false),
        ]);
    }

    #[test]
    fn a_favorite_that_is_gone_is_not_listed() {
        let (_root, p) = dirs(2);
        std::fs::remove_dir(&p[0]).unwrap();
        let got = ordered(p.clone(), &HashSet::from([p[0].clone()]));
        assert_eq!(got.into_iter().map(|e| e.path).collect::<Vec<_>>(), vec![p[1].clone()]);
    }

    #[test]
    fn only_a_recent_repo_becomes_a_favorite() {
        let recents = ["/a".to_string(), "/b".to_string()];
        let favs = toggled(vec!["/a".to_string()], &recents, "/b", true);
        assert_eq!(favs, ["/a", "/b"]);
        assert_eq!(toggled(favs.clone(), &recents, "/b", true), ["/a", "/b"]);
        assert_eq!(toggled(favs.clone(), &recents, "/elsewhere", true), ["/a", "/b"]);
        assert_eq!(toggled(favs, &recents, "/a", false), ["/b"]);
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
