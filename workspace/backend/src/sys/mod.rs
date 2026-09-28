//! What macOS and Linux answer differently: kernel queries, the process listing, and the system paths and tools a
//! macOS default gets wrong on Linux. Each platform's file has the same names.

use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
pub use macos::*;

/// In every session's environment, which is how its processes are found again once no host knows them.
pub const TAG: &str = "CODEBAER_SESSION=";

/// One process from a listing of the whole machine.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub uid: u32,
    /// `??` for none.
    pub tty: String,
    pub command: String,
    /// From its environment, which another account's process does not let us read.
    pub session: Option<u32>,
    /// Caught partway through exit, which `unstick` repairs. Only macOS has that state.
    pub exiting: bool,
}

/// Spawnable again: once a package upgrade replaces the binary of a running app, Linux reports it as
/// `<path> (deleted)`, and the path without the suffix is the new one.
pub fn current_exe() -> std::io::Result<PathBuf> {
    std::env::current_exe().map(strip_deleted)
}

fn strip_deleted(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(s) => PathBuf::from(s),
        None => p,
    }
}

/// For a script that is executed, not just read: some Linux systems mount /tmp noexec.
pub fn exec_temp_dir() -> PathBuf {
    runtime_dir().unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    struct Reap(Child);
    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn until<T>(f: impl Fn() -> Option<T>) -> Option<T> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(v) = f() {
                return Some(v);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn reads_the_folder_a_live_process_is_in() {
        let here = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(cwd_of(std::process::id() as i32).as_deref(), here.to_str());
    }

    #[test]
    fn has_no_folder_for_a_pid_that_is_not_running() {
        assert_eq!(cwd_of(-1), None);
        assert_eq!(cwd_of(0x7fff_fff0), None);
    }

    #[test]
    fn names_the_process_at_the_far_end_of_a_socket() {
        use std::os::fd::AsRawFd;
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_pid(a.as_raw_fd()), Some(std::process::id() as i32));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        assert!(unix_sockets(std::process::id() as i32, &path.to_string_lossy()).is_some_and(|n| n >= 1));
    }

    /// The child of the listing test: macOS hides a platform binary's environment, but not this test binary's.
    #[test]
    #[ignore = "started by lists_a_process_with_its_family_account_and_session"]
    fn stays_alive() {
        std::thread::sleep(Duration::from_secs(10));
    }

    #[test]
    fn lists_a_process_with_its_family_account_and_session() {
        let args = ["--ignored", "--exact", "sys::tests::stays_alive", "--quiet"];
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(args).env("CODEBAER_SESSION", "42").stdout(std::process::Stdio::null());
        let child = Reap(cmd.spawn().unwrap());
        let pid = child.0.id() as i32;
        let me = std::process::id() as i32;
        let tail = args.join(" ");
        // until it has exec'd: before that it carries this process's command line
        let found = until(|| processes().unwrap().into_iter().find(|p| p.pid == pid && p.command.ends_with(&tail)));
        let p = found.expect("the child is not in the listing");
        assert_eq!((p.ppid, p.uid, p.session, p.exiting), (me, unsafe { libc::getuid() }, Some(42), false));
        assert!(command_lines().unwrap().iter().any(|l| l.ends_with(&tail)));
    }

    #[test]
    fn a_replaced_binary_is_spawned_from_its_path() {
        assert_eq!(strip_deleted(PathBuf::from("/usr/bin/codebaer (deleted)")), PathBuf::from("/usr/bin/codebaer"));
        assert_eq!(strip_deleted(PathBuf::from("/usr/bin/codebaer")), PathBuf::from("/usr/bin/codebaer"));
    }
}
