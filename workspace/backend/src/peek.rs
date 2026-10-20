//! Reads for the hover card over a path in a terminal when the path is outside the open repository, which the
//! repository's own reads refuse, and opening the card's file in another app. Terminal output names these paths, so
//! an agent or a repository picks them: the reads take only regular files, and nothing opened can run. Also
//! showing a repository path in the file manager.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use crate::eol::Eol;
use crate::error::AppError;
use crate::git::{text_from_bytes, AppState, FileText, MAX_BYTES, MAX_IMAGE_BYTES};
use crate::sys;
use tauri::State;

const MAX_LINKS: usize = 40;

/// Opened in the app the system picks for their type, which shows them; every other file opens as text.
const DOCUMENTS: &[&str] =
    &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff", "heic", "heif", "pdf"];

/// `path` with its links resolved one folder at a time; None when it is not there, or when a step of it is in a
/// folder whose first read makes the system ask the user for access. Each step is checked before it is looked up,
/// since resolving a link inside such a folder is already a read of it.
fn walk(path: &Path) -> Result<Option<PathBuf>, AppError> {
    let parts = |p: &Path| -> Vec<OsString> {
        p.components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_os_string()),
                Component::ParentDir => Some("..".into()),
                _ => None,
            })
            .collect()
    };
    let mut todo: VecDeque<OsString> = parts(path).into();
    let mut at = PathBuf::from("/");
    let mut links = 0;
    while let Some(part) = todo.pop_front() {
        if part == ".." {
            at.pop();
            continue;
        }
        let next = at.join(&part);
        if sys::asks_access(&next) {
            return Ok(None);
        }
        let md = match std::fs::symlink_metadata(&next) {
            Ok(md) => md,
            // a path that goes on through a file names nothing
            Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => {
                return Ok(None)
            }
            Err(e) => return Err(e.into()),
        };
        if !md.file_type().is_symlink() {
            at = next;
            continue;
        }
        links += 1;
        if links > MAX_LINKS {
            return Ok(None);
        }
        let target = std::fs::read_link(&next)?;
        if target.is_absolute() {
            at = PathBuf::from("/");
        }
        for p in parts(&target).into_iter().rev() {
            todo.push_front(p);
        }
    }
    Ok(Some(at))
}

/// One open, which the checks then read from: a link or a FIFO swapped in after `walk` is refused rather than
/// followed or waited on.
fn open_regular(full: &Path) -> Result<Option<(File, Metadata)>, AppError> {
    let f = match File::options().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_NOCTTY).open(full) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ELOOP) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let md = f.metadata()?;
    Ok(md.is_file().then_some((f, md)))
}

/// The regular file an absolute `path` names; None when there is none to show.
fn file(path: &str) -> Result<Option<(PathBuf, File, Metadata)>, AppError> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(AppError::InvalidPath(format!("not absolute: {path:?}")));
    }
    let Some(full) = walk(p)? else { return Ok(None) };
    Ok(open_regular(&full)?.map(|(f, md)| (full, f, md)))
}

fn read_all(f: File, max: u64, len: u64) -> Result<Vec<u8>, AppError> {
    if len > max {
        return Err(AppError::TooLarge);
    }
    let mut bytes = Vec::new();
    f.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AppError::TooLarge);
    }
    Ok(bytes)
}

/// Changes when the file does; None when there is no file to show.
#[tauri::command(async)]
pub fn peek_stamp(path: String) -> Result<Option<String>, AppError> {
    Ok(file(&path)?.map(|(_, _, md)| format!("{}:{}:{}.{}", md.ino(), md.len(), md.mtime(), md.mtime_nsec())))
}

#[tauri::command(async)]
pub fn peek_text(path: String) -> Result<FileText, AppError> {
    match file(&path)? {
        Some((_, f, md)) => text_from_bytes(read_all(f, MAX_BYTES, md.len())?),
        None => Ok(FileText { text: String::new(), eol: Eol::Lf, exists: false }),
    }
}

/// Empty when there is no file, as `read_image` answers.
#[tauri::command(async)]
pub fn peek_image(path: String) -> Result<tauri::ipc::Response, AppError> {
    let bytes = match file(&path)? {
        Some((_, f, md)) => read_all(f, MAX_IMAGE_BYTES, md.len())?,
        None => Vec::new(),
    };
    Ok(tauri::ipc::Response::new(bytes))
}

fn is_document(full: &Path) -> bool {
    full.extension().is_some_and(|e| DOCUMENTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
}

/// Opens the file the card shows: `path` is absolute outside the repository and relative to it inside, as the card
/// has it. An image or a PDF opens in the app the system picks for it, anything else in the text editor: the app
/// picked for a script or an installer would run it.
#[tauri::command(async)]
pub fn open_file(state: State<AppState>, path: String) -> Result<(), AppError> {
    let full = if Path::new(&path).is_absolute() {
        file(&path)?.map(|(full, _, _)| full).ok_or(AppError::Special)?
    } else {
        let full = crate::git::resolve(&state.root()?, &path)?;
        open_regular(&full)?.ok_or(AppError::Special)?;
        full
    };
    sys::open_file(&full, !is_document(&full))
}

/// Shows a file or a folder of the repository in the file manager; `path` is relative to the repository.
#[tauri::command(async)]
pub fn reveal_path(state: State<AppState>, path: String) -> Result<(), AppError> {
    sys::reveal(&revealed(&state.root()?, &path)?)
}

/// `resolve` answers `Special` for a folder or a link only after it has checked every folder above it, and the file
/// manager shows the entry itself, not where a link leads.
fn revealed(root: &Path, path: &str) -> Result<PathBuf, AppError> {
    match crate::git::resolve(root, path) {
        Err(AppError::Special) => Ok(root.canonicalize()?.join(path)),
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveals_a_file_a_folder_or_a_link_in_the_repository_and_nothing_outside_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join("src/a.ts"), "").unwrap();
        std::os::unix::fs::symlink("src/a.ts", root.join("link")).unwrap();
        std::os::unix::fs::symlink("..", root.join("up")).unwrap();
        let real = root.canonicalize().unwrap();

        assert_eq!(revealed(&root, "src/a.ts").unwrap(), real.join("src/a.ts"));
        assert_eq!(revealed(&root, "src").unwrap(), real.join("src"));
        assert_eq!(revealed(&root, "link").unwrap(), real.join("link"));
        assert_eq!(revealed(&root, "up").unwrap(), real.join("up"));
        for bad in ["../repo", ".git", "up/x", "/etc"] {
            assert!(matches!(revealed(&root, bad), Err(AppError::InvalidPath(_))), "{bad}");
        }
    }

    #[test]
    fn reads_a_file_through_a_linked_folder_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("a.txt"), "one\r\ntwo\n").unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink("../real/a.txt", real.join("up.txt")).unwrap();
        let via = |name: &str| dir.path().join(name).to_string_lossy().into_owned();

        assert!(peek_stamp(via("link/a.txt")).unwrap().is_some());
        let t = peek_text(via("link/a.txt")).unwrap();
        assert_eq!((t.text.as_str(), t.exists), ("one\ntwo\n", true));
        assert!(peek_text(via("link/up.txt")).unwrap().exists);
        assert_eq!(peek_stamp(via("real")).unwrap(), None);
        assert_eq!(peek_stamp(via("missing.txt")).unwrap(), None);
        assert_eq!(peek_stamp(via("real/a.txt/b")).unwrap(), None);
        assert!(!peek_text(via("missing.txt")).unwrap().exists);
        assert!(matches!(peek_stamp("rel/a.txt".into()), Err(AppError::InvalidPath(_))));
    }

    #[test]
    fn a_fifo_or_a_link_loop_is_not_a_file_and_never_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe.txt");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        std::os::unix::fs::symlink("b.txt", dir.path().join("a.txt")).unwrap();
        std::os::unix::fs::symlink("a.txt", dir.path().join("b.txt")).unwrap();

        assert!(!peek_text(fifo.to_string_lossy().into_owned()).unwrap().exists);
        assert_eq!(peek_stamp(dir.path().join("a.txt").to_string_lossy().into_owned()).unwrap(), None);
        // a FIFO opened without O_NONBLOCK would wait here for a writer
        assert!(open_regular(&fifo).unwrap().is_none());
    }

    #[test]
    fn only_images_and_pdfs_open_in_their_own_app() {
        for doc in ["a.png", "b.JPG", "c.pdf", "d.heic"] {
            assert!(is_document(Path::new(doc)), "{doc}");
        }
        for text in ["a.py", "b.command", "c.terminal", "d.sh", "e.exe", "f.desktop", "g.html", "Makefile", "h.png.app"] {
            assert!(!is_document(Path::new(text)), "{text}");
        }
    }
}
