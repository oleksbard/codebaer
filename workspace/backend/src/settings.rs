use crate::error::AppError;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
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

/// The ids of the frontend's `THEMES` in `workspace/ui/src/ui/theme.ts`; a theme added there needs its variant here.
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

/// A command saved in Settings. `repo` is the canonical root of the one repository it belongs to, the
/// form `open_repo` reports, or None for every repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomCommand {
    pub name: String,
    pub command: String,
    pub repo: Option<String>,
    /// Only the webview acts on it: it opens no output dialog for the run and closes the session once it ends.
    pub hide_terminal: bool,
    /// An icon id such as `lucide:hammer` that the user picked; None leaves the icon to the AI.
    pub icon: Option<String>,
}

/// Written by `commands_set` alone; `Settings` does not know it, so a settings save keeps it.
const COMMANDS: &str = "commands.custom";

/// Each entry falls back alone, like an option: one that is not an object with a command in it is
/// dropped, a `name` that is not a string reads as blank, a `hide_terminal` that is not a bool as false, and an
/// `icon` that is not a string as none.
/// A `repo` that is neither a string nor null drops the entry too, since reading it as missing would offer
/// the command in every repository.
fn commands_from(map: &Map<String, Value>) -> Vec<CustomCommand> {
    let Some(Value::Array(items)) = map.get(COMMANDS) else { return Vec::new() };
    items
        .iter()
        .filter_map(|v| {
            let o = v.as_object()?;
            let text = |k: &str| o.get(k).and_then(Value::as_str).map(String::from);
            let command = text("command").filter(|c| !c.trim().is_empty())?;
            let repo = match o.get("repo") {
                None | Some(Value::Null) => None,
                Some(Value::String(r)) => Some(r.clone()),
                Some(_) => return None,
            };
            let hide_terminal = o.get("hide_terminal").and_then(Value::as_bool).unwrap_or_default();
            let icon = text("icon");
            Some(CustomCommand { name: text("name").unwrap_or_default(), command, repo, hide_terminal, icon })
        })
        .collect()
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

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, AppError> {
    app.path().app_config_dir().map(|d| d.join(name)).map_err(|e| AppError::Io(e.to_string()))
}

fn store(app: &AppHandle) -> Result<PathBuf, AppError> {
    config_file(app, "settings-codebaer.json")
}

/// The AI's icon picks, keyed by the command's name and line joined by a newline. A cache, not a setting:
/// without the file every command is simply asked about again.
fn icons_store(app: &AppHandle) -> Result<PathBuf, AppError> {
    config_file(app, "icons-codebaer.json")
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

fn read_with<T: Default>(path: &Path, from: impl FnOnce(&Map<String, Value>) -> T) -> T {
    match read_map(path) {
        Ok(m) => from(&m),
        Err(e) => {
            log::warn!("settings: {}: {e}", path.display());
            T::default()
        }
    }
}

fn read_at(path: &Path) -> Settings {
    read_with(path, from_file)
}

fn commands_at(path: &Path) -> Vec<CustomCommand> {
    read_with(path, commands_from)
}

fn icons_at(path: &Path) -> BTreeMap<String, String> {
    read_with(path, |m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
}

fn write_icons_at(path: &Path, picks: BTreeMap<String, String>) -> Result<(), AppError> {
    write_keys(path, picks.into_iter().map(|(k, v)| (k, Value::String(v))).collect())
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

fn write_at(path: &Path, s: &Settings) -> Result<(), AppError> {
    match serde_json::to_value(s).map_err(|e| AppError::Io(e.to_string()))? {
        Value::Object(known) => write_keys(path, known),
        _ => Err(AppError::Io("settings did not serialize to an object".into())),
    }
}

fn write_commands_at(path: &Path, commands: &[CustomCommand]) -> Result<(), AppError> {
    if commands.iter().any(|c| c.command.trim().is_empty()) {
        return Err(AppError::Io("a saved command cannot be empty".into()));
    }
    let list = serde_json::to_value(commands).map_err(|e| AppError::Io(e.to_string()))?;
    write_keys(path, Map::from_iter([(COMMANDS.to_string(), list)]))
}

/// Every key but `known` is kept, whether this build knows it or not. A file that is there but cannot
/// be parsed is left alone: replacing it would drop every option in it.
fn write_keys(path: &Path, known: Map<String, Value>) -> Result<(), AppError> {
    let path = target(path);
    let mut map = read_map(&path)
        .map_err(|e| AppError::Io(format!("{} cannot be read: {e}. Fix or delete it, then try again.", path.display())))?;
    map.extend(known);
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

/// Read on every call, like `load`, so a run checks what the file says now.
pub fn load_commands(app: &AppHandle) -> Vec<CustomCommand> {
    store(app).map(|f| commands_at(&f)).unwrap_or_default()
}

#[tauri::command(async)]
pub fn commands_get(app: AppHandle) -> Vec<CustomCommand> {
    load_commands(&app)
}

/// The whole list, every repository's included: the Settings pane edits them all.
#[tauri::command(async)]
pub fn commands_set(app: AppHandle, commands: Vec<CustomCommand>) -> Result<(), AppError> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_commands_at(&store(&app)?, &commands)
}

#[tauri::command(async)]
pub fn command_icons_get(app: AppHandle) -> BTreeMap<String, String> {
    icons_store(&app).map(|f| icons_at(&f)).unwrap_or_default()
}

/// Adds `picks` to the ones already in the file.
#[tauri::command(async)]
pub fn command_icons_set(app: AppHandle, picks: BTreeMap<String, String>) -> Result<(), AppError> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_icons_at(&icons_store(&app)?, picks)
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

    fn saved(name: &str, command: &str, repo: Option<&str>) -> CustomCommand {
        let repo = repo.map(String::from);
        CustomCommand { name: name.into(), command: command.into(), repo, hide_terminal: false, icon: None }
    }

    #[test]
    fn commands_round_trip_and_leave_the_options_alone() {
        let (_d, f) = file(r#"{"general.headless-ai-provider": "claude", "general.future": 1}"#);
        let hidden = CustomCommand { hide_terminal: true, ..saved("", "make", None) };
        let list = vec![saved("Test", "pnpm test", Some("/r")), hidden];
        write_commands_at(&f, &list).unwrap();
        assert_eq!(commands_at(&f), list);
        assert_eq!(read_at(&f), CLAUDE);
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(on_disk["general.future"], 1);
        let want = serde_json::json!({ "name": "", "command": "make", "repo": null, "hide_terminal": true, "icon": null });
        assert_eq!(on_disk["commands.custom"][1], want);
    }

    #[test]
    fn a_settings_save_keeps_the_commands() {
        let (_d, f) = file("{}");
        write_commands_at(&f, &[saved("Lint", "pnpm lint", None)]).unwrap();
        write_at(&f, &CLAUDE).unwrap();
        assert_eq!(commands_at(&f), vec![saved("Lint", "pnpm lint", None)]);
    }

    #[test]
    fn a_bad_command_entry_is_dropped_alone() {
        let body = r#"{"commands.custom": [
            {"name": "ok", "command": "make", "repo": "/r"},
            {"name": "blank", "command": "  "},
            {"command": 1},
            "make",
            {"name": 7, "command": "ls", "repo": null},
            {"command": "pwd", "hide_terminal": "yes"},
            {"command": "rm -rf build", "repo": ["/r"]},
            {"command": "cargo fmt", "hide_terminal": true},
            {"command": "cargo test", "icon": "lucide:flask-conical"},
            {"command": "cargo run", "icon": 3}
        ]}"#;
        let (_d, f) = file(body);
        let want = vec![
            saved("ok", "make", Some("/r")),
            saved("", "ls", None),
            saved("", "pwd", None),
            CustomCommand { hide_terminal: true, ..saved("", "cargo fmt", None) },
            CustomCommand { icon: Some("lucide:flask-conical".into()), ..saved("", "cargo test", None) },
            saved("", "cargo run", None),
        ];
        assert_eq!(commands_at(&f), want);
    }

    #[test]
    fn a_blank_command_is_refused_and_leaves_the_file() {
        let (_d, f) = file("{}");
        let res = write_commands_at(&f, &[saved("Lint", "pnpm lint", None), saved("Nothing", " ", None)]);
        assert!(matches!(res, Err(AppError::Io(ref m)) if m.contains("empty")), "{res:?}");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{}");
    }

    #[test]
    fn commands_that_are_not_a_list_read_as_none() {
        for v in ["null", "{}", r#""make""#] {
            let (_d, f) = file(&format!(r#"{{"commands.custom": {v}}}"#));
            assert_eq!(commands_at(&f), Vec::new(), "value {v}");
        }
    }

    #[test]
    fn icon_picks_add_to_the_file_and_drop_a_value_that_is_not_text() {
        let (_d, f) = file(r#"{"dev\nvite": "lucide:play", "bad": 1, "odd": null}"#);
        let want = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(icons_at(&f), want(&[("dev\nvite", "lucide:play")]));
        write_icons_at(&f, want(&[("test\nvitest run", "lucide:flask-conical")])).unwrap();
        assert_eq!(icons_at(&f), want(&[("dev\nvite", "lucide:play"), ("test\nvitest run", "lucide:flask-conical")]));
        let d = tempfile::tempdir().unwrap();
        assert_eq!(icons_at(&d.path().join("icons-codebaer.json")), BTreeMap::new());
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
