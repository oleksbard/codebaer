use std::path::Path;

/// Shells worth offering. `sh` and `csh` are left out deliberately: on macOS they are bash in
/// POSIX mode and a link to tcsh, so listing them would be two names for a shell already shown.
const CANDIDATES: [&str; 10] =
    ["zsh", "bash", "fish", "nu", "pwsh", "elvish", "xonsh", "dash", "tcsh", "ksh"];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Shell {
    pub path: String,
    pub name: String,
}

/// Files, environment and arguments that put our prompt hooks into a shell without the user
/// editing a dotfile. `files` are written into the session's private directory by the caller.
#[derive(Debug, Clone, PartialEq)]
pub struct Injection {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub files: Vec<(String, String)>,
}

/// Each of our zsh startup files re-asserts ZDOTDIR, because the user's own file is free to
/// change it and zsh resolves it afresh for every one of the four.
const ZSHENV: &str = r#"__cb_user=${CODEBAER_ZDOTDIR:-$HOME}
[ -f "$__cb_user/.zshenv" ] && source "$__cb_user/.zshenv"
# .zshenv is where ZDOTDIR is normally set, so whatever it left behind is the real one and
# every later file has to follow it: overwriting blind loses the whole XDG zsh layout
if [ -n "$ZDOTDIR" ] && [ "$ZDOTDIR" != @DIR@ ]; then
  CODEBAER_ZDOTDIR=$ZDOTDIR
  export CODEBAER_ZDOTDIR
fi
ZDOTDIR=@DIR@
"#;

const ZPROFILE: &str = r#"__cb_user=${CODEBAER_ZDOTDIR:-$HOME}
[ -f "$__cb_user/.zprofile" ] && source "$__cb_user/.zprofile"
ZDOTDIR=@DIR@
"#;

const ZSHRC: &str = r#"__cb_user=${CODEBAER_ZDOTDIR:-$HOME}
[ -f "$__cb_user/.zshrc" ] && source "$__cb_user/.zshrc"
ZDOTDIR=@DIR@
__cb_osc() { printf '\033]133;%s\007' "$1" }
__cb_preexec() { __cb_osc "C;${1//[$'\033\a\n\r']/}" }
__cb_precmd() {
  local st=$?
  [[ -n $__cb_ran ]] && __cb_osc "D;$st"
  __cb_ran=1
  __cb_osc "A"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __cb_precmd
add-zsh-hook preexec __cb_preexec
"#;

/// Last of the four, so this is where ZDOTDIR is handed back to whatever the user had.
const ZLOGIN: &str = r#"__cb_user=${CODEBAER_ZDOTDIR:-$HOME}
[ -f "$__cb_user/.zlogin" ] && source "$__cb_user/.zlogin"
if [ -n "$CODEBAER_ZDOTDIR" ]; then ZDOTDIR=$CODEBAER_ZDOTDIR; else unset ZDOTDIR; fi
"#;

/// A login bash reads its profile files and ignores --rcfile, so this file has to do both
/// jobs: reproduce the login sourcing order, then install the hooks.
const BASHRC: &str = r#"[ -f /etc/profile ] && . /etc/profile
__cb_profiled=
for __cb_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$__cb_f" ]; then . "$__cb_f"; __cb_profiled=1; break; fi
done
# only stand in when no profile file ran: nearly every .bash_profile sources .bashrc itself,
# and sourcing it twice re-runs whatever PATH prepends live there
if [ -z "$__cb_profiled" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
__cb_osc() { printf '\033]133;%s\007' "$1"; }
__cb_status() { __cb_st=$?; }
__cb_preexec() {
  [ -n "$__cb_in" ] && return
  case "$BASH_COMMAND" in __cb_*) return;; esac
  __cb_in=1
  __cb_osc "C;${BASH_COMMAND//[$'\033\a\n\r']/}"
}
__cb_precmd() {
  [ -n "$__cb_in" ] && [ -z "$__cb_first" ] && __cb_osc "D;$__cb_st"
  __cb_first=
  __cb_in=
  __cb_osc "A"
}
# both set before the first prompt: __cb_in so the user's own PROMPT_COMMAND entries are
# already guarded the very first time they run, __cb_first so that guard does not also
# produce an exit report for a command nobody ran
__cb_in=1
__cb_first=1
PROMPT_COMMAND="__cb_status${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __cb_precmd"
trap '__cb_preexec' DEBUG
"#;

/// Single quotes, so a TMPDIR containing a space cannot turn an assignment into a command.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn login_args(path: &str) -> Vec<String> {
    match basename(path) {
        "pwsh" => vec!["-Login".into(), "-NoLogo".into()],
        // neither has a working login mode; both load their config on a pty regardless
        "nu" | "elvish" => Vec::new(),
        _ => vec!["-l".into()],
    }
}

pub fn detect(pw_shell: &str, etc_shells: &str, dirs: &[&Path], exists: &dyn Fn(&Path) -> bool) -> Vec<Shell> {
    let mut out: Vec<Shell> = Vec::new();
    let mut add = |path: &str| {
        let name = basename(path);
        if !CANDIDATES.contains(&name) || out.iter().any(|s| s.path == path) || !exists(Path::new(path)) {
            return;
        }
        out.push(Shell { path: path.to_string(), name: name.to_string() });
    };
    // the user's own login shell leads the menu whether or not chsh ever registered it
    add(pw_shell);
    for line in etc_shells.lines() {
        let line = line.trim();
        if !line.is_empty() && !line.starts_with('#') {
            add(line);
        }
    }
    // the only way nu, pwsh, elvish and xonsh are ever found: they never register in /etc/shells
    for dir in dirs {
        for name in CANDIDATES {
            add(&dir.join(name).to_string_lossy());
        }
    }
    out
}

pub fn injection(path: &str, dir: &Path, orig_zdotdir: Option<&str>) -> Option<Injection> {
    let dir_s = dir.to_string_lossy().into_owned();
    match basename(path) {
        "zsh" => Some(Injection {
            args: vec!["-l".into()],
            env: vec![
                ("ZDOTDIR".into(), dir_s.clone()),
                ("CODEBAER_ZDOTDIR".into(), orig_zdotdir.unwrap_or_default().to_string()),
            ],
            files: [(".zshenv", ZSHENV), (".zprofile", ZPROFILE), (".zshrc", ZSHRC), (".zlogin", ZLOGIN)]
                .into_iter()
                .map(|(n, body)| (n.to_string(), body.replace("@DIR@", &sh_quote(&dir_s))))
                .collect(),
        }),
        "bash" => Some(Injection {
            args: vec!["--rcfile".into(), dir.join("rc.bash").to_string_lossy().into_owned(), "-i".into()],
            env: Vec::new(),
            files: vec![("rc.bash".to_string(), BASHRC.to_string())],
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn present(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |p: &Path| set.iter().any(|q| q == p)
    }

    #[test]
    fn every_shell_gets_its_own_login_invocation() {
        assert_eq!(login_args("/bin/zsh"), vec!["-l"]);
        assert_eq!(login_args("/bin/bash"), vec!["-l"]);
        assert_eq!(login_args("/bin/tcsh"), vec!["-l"]);
        assert_eq!(login_args("/opt/homebrew/bin/fish"), vec!["-l"]);
        // pwsh grew -Login for unix in 7.2; the banner is noise in a small pane
        assert_eq!(login_args("/opt/homebrew/bin/pwsh"), vec!["-Login", "-NoLogo"]);
        // nu has no working login concept and loads its config on a pty anyway
        assert_eq!(login_args("/opt/homebrew/bin/nu"), Vec::<String>::new());
    }

    #[test]
    fn the_login_shell_comes_first_even_when_etc_shells_omits_it() {
        let got = detect(
            "/opt/homebrew/bin/fish",
            "/bin/bash\n/bin/zsh\n",
            &[],
            &present(&["/opt/homebrew/bin/fish", "/bin/bash", "/bin/zsh"]),
        );
        assert_eq!(got[0].path, "/opt/homebrew/bin/fish");
        assert_eq!(got[0].name, "fish");
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn finds_a_shell_that_only_exists_on_the_path() {
        let got = detect("/bin/zsh", "/bin/zsh\n", &[Path::new("/opt/homebrew/bin")], &present(&["/bin/zsh", "/opt/homebrew/bin/nu"]));
        assert!(got.iter().any(|s| s.name == "nu"), "{got:?}");
    }

    #[test]
    fn skips_a_listed_shell_that_is_not_installed() {
        let got = detect("/bin/zsh", "/bin/zsh\n/bin/fish\n", &[], &present(&["/bin/zsh"]));
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn lists_a_shell_once_when_both_sources_name_it() {
        let got = detect("/bin/zsh", "/bin/zsh\n", &[Path::new("/bin")], &present(&["/bin/zsh"]));
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn ignores_comments_blanks_and_non_shells_in_etc_shells() {
        let got = detect("/bin/zsh", "# a comment\n\n/usr/bin/false\n/bin/zsh\n", &[], &present(&["/bin/zsh", "/usr/bin/false"]));
        assert_eq!(got, vec![Shell { path: "/bin/zsh".into(), name: "zsh".into() }]);
    }

    #[test]
    fn zsh_injection_redirects_zdotdir_and_keeps_the_users_own_files() {
        let inj = injection("/bin/zsh", Path::new("/tmp/s1"), Some("/home/me/cfg")).unwrap();
        assert_eq!(inj.args, vec!["-l"]);
        assert!(inj.env.contains(&("ZDOTDIR".into(), "/tmp/s1".into())));
        assert!(inj.env.contains(&("CODEBAER_ZDOTDIR".into(), "/home/me/cfg".into())));
        let names: Vec<&str> = inj.files.iter().map(|(n, _)| n.as_str()).collect();
        // zsh resolves ZDOTDIR for every startup file, so skipping one would silently drop
        // the user's PATH setup, which is where claude lives
        assert_eq!(names, vec![".zshenv", ".zprofile", ".zshrc", ".zlogin"]);
        let rc = &inj.files.iter().find(|(n, _)| n == ".zshrc").unwrap().1;
        assert!(rc.contains("add-zsh-hook precmd"), "{rc}");
        assert!(rc.contains("add-zsh-hook preexec"), "{rc}");
        assert!(rc.contains(r"printf '\033]133;%s\007'"), "{rc}");
        assert!(rc.contains(r#"__cb_osc "A""#), "the prompt mark must actually be emitted: {rc}");
        assert!(rc.contains(".zshrc"), "the user's own rc must still be sourced");
    }

    #[test]
    fn bash_injection_uses_an_rcfile_and_never_clobbers_prompt_command() {
        let inj = injection("/bin/bash", Path::new("/tmp/s2"), None).unwrap();
        assert_eq!(inj.args, vec!["--rcfile", "/tmp/s2/rc.bash", "-i"]);
        // -l would make bash read its own profile files and ignore --rcfile entirely
        assert!(!inj.args.contains(&"-l".to_string()));
        let rc = &inj.files[0].1;
        assert!(rc.contains("${PROMPT_COMMAND:+; $PROMPT_COMMAND}"), "the user's own must survive: {rc}");
        assert!(rc.contains("trap '__cb_preexec' DEBUG"), "{rc}");
        assert!(rc.contains("/etc/profile"), "a login bash would have read this; the rcfile must");
        assert!(rc.contains(".bashrc"), "{rc}");
    }

    #[test]
    fn bash_emits_our_prompt_hook_last_so_a_users_prompt_command_is_not_taken_for_the_command() {
        let rc = &injection("/bin/bash", Path::new("/tmp/s"), None).unwrap().files[0].1;
        let line = rc.lines().find(|l| l.starts_with("PROMPT_COMMAND=")).unwrap();
        // __cb_status first so it reads the real $?, the user's own in the middle, and the
        // emitter last so the one-shot DEBUG guard is still held while the user's run: with
        // the emitter first, `history -a` gets reported as the command on every prompt
        assert!(line.starts_with(r#"PROMPT_COMMAND="__cb_status"#), "{line}");
        assert!(line.ends_with(r#"; __cb_precmd""#), "{line}");
        assert!(line.contains("${PROMPT_COMMAND:+; $PROMPT_COMMAND}"), "{line}");
        let trap = rc.find("trap '__cb_preexec' DEBUG").unwrap();
        let assign = rc.find("PROMPT_COMMAND=").unwrap();
        assert!(trap > assign, "the trap must go in last or it reports its own setup line");
    }

    #[test]
    fn bash_does_not_source_bashrc_a_second_time() {
        let rc = &injection("/bin/bash", Path::new("/tmp/s"), None).unwrap().files[0].1;
        // nearly every .bash_profile sources .bashrc itself, and doing it twice re-runs
        // whatever PATH prepends and shopt toggles live there
        assert!(rc.contains("__cb_profiled"), "{rc}");
    }

    #[test]
    fn zsh_honours_a_zdotdir_that_the_users_own_zshenv_sets() {
        let inj = injection("/bin/zsh", Path::new("/tmp/s1"), None).unwrap();
        let env = &inj.files.iter().find(|(n, _)| n == ".zshenv").unwrap().1;
        // the XDG layout sets ZDOTDIR from ~/.zshenv. Overwriting it without reading it back
        // sends .zprofile, .zshrc and .zlogin to $HOME, silently losing the user's whole config
        assert!(env.contains("CODEBAER_ZDOTDIR=$ZDOTDIR"), "{env}");
    }

    #[test]
    fn the_injected_zdotdir_survives_a_path_with_a_space() {
        let inj = injection("/bin/zsh", Path::new("/tmp/a b"), None).unwrap();
        for (name, body) in &inj.files {
            assert!(!body.contains("ZDOTDIR=/tmp/a b"), "{name} assigns an unquoted path: {body}");
        }
    }

    #[test]
    fn shells_without_a_hook_script_get_no_injection() {
        assert_eq!(injection("/bin/dash", Path::new("/tmp/s3"), None), None);
        assert_eq!(injection("/bin/tcsh", Path::new("/tmp/s3"), None), None);
        assert_eq!(injection("/opt/homebrew/bin/nu", Path::new("/tmp/s3"), None), None);
    }
}
