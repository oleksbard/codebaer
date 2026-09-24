use crate::error::AppError;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    #[default]
    Off,
    Claude,
}

/// The ids of the frontend's `THEMES` in `src/ui/theme.ts`; a theme added there needs its variant here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    #[default]
    Codebaer,
    GithubDark,
    GithubLight,
    OneDark,
    OneLight,
    Dracula,
    CatppuccinMocha,
    CatppuccinLatte,
    TokyoNight,
    TokyoNightDay,
    SolarizedDark,
    SolarizedLight,
    Nord,
    GruvboxDark,
    GruvboxLight,
    AyuMirage,
    AyuLight,
    RosePine,
    RosePineDawn,
}

/// Keyed by the option key, which is also the shape of the file. Deserialize is strict and serves the
/// command argument only; the file goes through `from_file`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "general.headless-ai-provider")]
    pub headless_ai_provider: AiProvider,
    #[serde(rename = "appearance.theme")]
    pub theme: Theme,
}

/// A hand-edited file can hold anything, so each option falls back alone. Only a string is taken:
/// serde also reads an enum from `{"claude": null}`.
fn choice<T: DeserializeOwned + Default>(map: &Map<String, Value>, key: &str) -> T {
    match map.get(key) {
        Some(v @ Value::String(_)) => serde_json::from_value(v.clone()).unwrap_or_default(),
        _ => T::default(),
    }
}

fn from_file(map: &Map<String, Value>) -> Settings {
    Settings {
        headless_ai_provider: choice(map, "general.headless-ai-provider"),
        theme: choice(map, "appearance.theme"),
    }
}

fn store(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings-codebaer.json"))
        .map_err(|e| AppError::Io(e.to_string()))
}

/// A missing or blank file is an empty one.
fn read_map(path: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(e.to_string()),
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn read_at(path: &Path) -> Settings {
    match read_map(path) {
        Ok(m) => from_file(&m),
        Err(e) => {
            log::warn!("settings: {}: {e}", path.display());
            Settings::default()
        }
    }
}

/// The rename would turn a symlinked file, e.g. one from a dotfiles repo, into a plain copy. A chain whose
/// last target does not exist yet cannot be canonicalized, so it is followed by hand; a loop is cut short
/// and then refused by the read.
fn target(path: &Path) -> PathBuf {
    if let Ok(p) = std::fs::canonicalize(path) {
        return p;
    }
    let mut p = path.to_path_buf();
    for _ in 0..32 {
        let Ok(t) = std::fs::read_link(&p) else { break };
        p = p.parent().map_or_else(|| t.clone(), |d| d.join(&t));
    }
    p
}

/// Keys this build does not know are kept. A file that is there but cannot be parsed is left alone:
/// replacing it would drop every option in it.
fn write_at(path: &Path, s: &Settings) -> Result<(), AppError> {
    let path = target(path);
    let mut map = read_map(&path)
        .map_err(|e| AppError::Io(format!("{} cannot be read: {e}. Fix or delete it, then try again.", path.display())))?;
    if let Value::Object(known) = serde_json::to_value(s).map_err(|e| AppError::Io(e.to_string()))? {
        map.extend(known);
    }
    let json = serde_json::to_string_pretty(&map).map_err(|e| AppError::Io(e.to_string()))? + "\n";
    let named = |e: std::io::Error| AppError::Io(format!("{}: {e}", path.display()));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(named)?;
    }
    // a torn write would read back as invalid JSON, which silently resets every option
    // the whole name plus .tmp: a linked target need not end in .json, and `cfg.json.tmp` could be someone's
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, &path)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        named(e)
    })
}

/// Read on every call, so the AI gate follows a hand edit to the file at once.
pub fn load(app: &AppHandle) -> Settings {
    store(app).map(|f| read_at(&f)).unwrap_or_default()
}

#[tauri::command(async)]
pub fn settings_get(app: AppHandle) -> Settings {
    load(&app)
}

#[tauri::command(async)]
pub fn settings_set(app: AppHandle, settings: Settings) -> Result<(), AppError> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_at(&store(&app)?, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(body: &str) -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("settings-codebaer.json");
        std::fs::write(&f, body).unwrap();
        (d, f)
    }

    const CLAUDE: Settings = Settings { headless_ai_provider: AiProvider::Claude, theme: Theme::Codebaer };

    #[test]
    fn a_missing_file_reads_as_the_defaults() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_at(&d.path().join("settings-codebaer.json")), Settings::default());
        assert_eq!(Settings::default().headless_ai_provider, AiProvider::Off);
    }

    #[test]
    fn invalid_json_reads_as_the_defaults() {
        let (_d, f) = file("{\"general.headless-ai-provider\": \"claude\"");
        assert_eq!(read_at(&f), Settings::default());
    }

    #[test]
    fn a_json_value_that_is_not_an_object_reads_as_the_defaults() {
        let (_d, f) = file("[\"claude\"]");
        assert_eq!(read_at(&f), Settings::default());
    }

    #[test]
    fn a_valid_value_is_read() {
        let (_d, f) = file(r#"{"general.headless-ai-provider": "claude"}"#);
        assert_eq!(read_at(&f), CLAUDE);
    }

    #[test]
    fn a_valid_theme_is_read() {
        let (_d, f) = file(r#"{"appearance.theme": "catppuccin-latte"}"#);
        assert_eq!(read_at(&f), Settings { theme: Theme::CatppuccinLatte, ..Settings::default() });
        assert_eq!(Settings::default().theme, Theme::Codebaer);
    }

    #[test]
    fn an_invalid_theme_falls_back_alone() {
        for v in [r#""solarised""#, r#""Nord""#, "1", "null", r#"{"nord": null}"#] {
            let (_d, f) = file(&format!(r#"{{"general.headless-ai-provider": "claude", "appearance.theme": {v}}}"#));
            assert_eq!(read_at(&f), CLAUDE, "value {v}");
        }
    }

    #[test]
    fn a_blank_file_reads_as_the_defaults_and_takes_a_write() {
        for body in ["", "  \n"] {
            let (_d, f) = file(body);
            assert_eq!(read_at(&f), Settings::default());
            write_at(&f, &CLAUDE).unwrap();
            assert_eq!(read_at(&f), CLAUDE);
        }
    }

    #[test]
    fn an_invalid_value_falls_back_to_its_default() {
        for v in [r#""CLAUDE""#, r#""gpt""#, "1", "null", "{}", r#"{"claude": null}"#, r#"["claude"]"#] {
            let (_d, f) = file(&format!(r#"{{"general.headless-ai-provider": {v}}}"#));
            assert_eq!(read_at(&f), Settings::default(), "value {v}");
        }
    }

    #[test]
    fn the_file_uses_the_option_key_and_lowercase_values() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("settings-codebaer.json");
        write_at(&f, &CLAUDE).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(on_disk, serde_json::json!({ "general.headless-ai-provider": "claude", "appearance.theme": "codebaer" }));
        let rose = Settings { theme: Theme::RosePineDawn, ..CLAUDE };
        write_at(&f, &rose).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(on_disk["appearance.theme"], "rose-pine-dawn");
    }

    #[test]
    fn a_write_creates_the_directory_and_reads_back() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("nested/dir/settings-codebaer.json");
        write_at(&f, &CLAUDE).unwrap();
        assert_eq!(read_at(&f), CLAUDE);
        assert!(!f.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_write_keeps_keys_it_does_not_know() {
        let (_d, f) = file(r#"{"general.future": [1, 2], "general.headless-ai-provider": "off"}"#);
        write_at(&f, &CLAUDE).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let want = serde_json::json!({
            "general.future": [1, 2], "general.headless-ai-provider": "claude", "appearance.theme": "codebaer",
        });
        assert_eq!(on_disk, want);
    }

    #[test]
    fn a_write_over_a_file_it_cannot_parse_is_refused_and_leaves_it() {
        for body in ["{\"general.future\": 1,}", "[]"] {
            let (_d, f) = file(body);
            let err = write_at(&f, &CLAUDE).unwrap_err();
            assert!(matches!(err, AppError::Io(ref m) if m.contains("Fix or delete it")), "{err:?}");
            assert_eq!(std::fs::read_to_string(&f).unwrap(), body);
        }
    }

    #[test]
    fn a_failed_write_names_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("settings-codebaer.json");
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let res = write_at(&f, &CLAUDE);
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(res, Err(AppError::Io(ref m)) if m.contains(&*f.to_string_lossy())), "{res:?}");
    }

    #[test]
    fn a_failed_rename_removes_the_tmp_file() {
        let (_d, f) = file("{}");
        let flags = |how: &str| assert!(std::process::Command::new("chflags").arg(how).arg(&f).status().unwrap().success());
        // an immutable file can be read but not renamed over, so the failure lands after the tmp write
        flags("uchg");
        let res = write_at(&f, &CLAUDE);
        flags("nouchg");
        assert!(matches!(res, Err(AppError::Io(_))), "{res:?}");
        assert!(!f.with_file_name("settings-codebaer.json.tmp").exists());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{}");
    }

    #[test]
    fn a_chain_of_links_to_a_missing_file_keeps_every_link() {
        let d = tempfile::tempdir().unwrap();
        let link = d.path().join("settings-codebaer.json");
        std::os::unix::fs::symlink("b.json", &link).unwrap();
        std::os::unix::fs::symlink("sub/c.json", d.path().join("b.json")).unwrap();
        write_at(&link, &CLAUDE).unwrap();
        for l in [&link, &d.path().join("b.json")] {
            assert!(std::fs::symlink_metadata(l).unwrap().file_type().is_symlink(), "{}", l.display());
        }
        assert_eq!(read_at(&d.path().join("sub/c.json")), CLAUDE);
    }

    #[test]
    fn the_tmp_file_cannot_clobber_a_file_named_like_the_target() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("cfg.yaml"), "{}").unwrap();
        std::fs::write(d.path().join("cfg.json.tmp"), "USER DATA").unwrap();
        let link = d.path().join("settings-codebaer.json");
        std::os::unix::fs::symlink("cfg.yaml", &link).unwrap();
        write_at(&link, &CLAUDE).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("cfg.json.tmp")).unwrap(), "USER DATA");
        assert_eq!(read_at(&link), CLAUDE);
    }

    #[test]
    fn a_dangling_symlink_stays_a_symlink() {
        let d = tempfile::tempdir().unwrap();
        let link = d.path().join("settings-codebaer.json");
        std::os::unix::fs::symlink("dotfiles/settings.json", &link).unwrap();
        write_at(&link, &CLAUDE).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(read_at(&d.path().join("dotfiles/settings.json")), CLAUDE);
    }

    #[test]
    fn a_symlinked_file_stays_a_symlink() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("dotfiles/settings.json");
        std::fs::create_dir(d.path().join("dotfiles")).unwrap();
        std::fs::write(&target, "{}").unwrap();
        let link = d.path().join("settings-codebaer.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write_at(&link, &CLAUDE).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(read_at(&target), CLAUDE);
    }

    /// The command argument comes from this app's own frontend, so a bad one is a bug to surface, not to store.
    #[test]
    fn the_command_argument_is_strict() {
        use serde_json::json;
        let with = |ai: &str, theme: &str| json!({ "general.headless-ai-provider": ai, "appearance.theme": theme });
        assert!(serde_json::from_value::<Settings>(with("gpt", "codebaer")).is_err());
        assert!(serde_json::from_value::<Settings>(with("claude", "solarised")).is_err());
        assert!(serde_json::from_value::<Settings>(json!({ "general.headless-ai-provider": "claude" })).is_err());
        assert!(serde_json::from_value::<Settings>(json!({})).is_err());
        assert_eq!(serde_json::from_value::<Settings>(with("claude", "codebaer")).unwrap(), CLAUDE);
    }
}
