//! Bounded directory reuse for ordinary files in one sequential extraction.
//!
//! The caller excludes concurrent external destination mutation. Cached handles
//! are invalidated before every general tar operation, which can change directory
//! identities or permissions. Every newly opened component is a real directory;
//! links and existing leaves retain the checked tar extractor's semantics.

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs::{File, FileTimes, OpenOptions, Permissions};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

// Includes the root. Cache exhaustion releases parents before checked tar
// extraction, so wide/deep archives do not retain an unbounded number of FDs.
const MAX_DIRECTORY_HANDLES: usize = 64;
const DIRECTORY_FLAGS: libc::c_int =
    libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

pub(crate) struct RootedWriter<'a> {
    target: &'a Path,
    root: Option<File>,
    root_path_bytes: usize,
    parents: HashMap<PathBuf, File>,
}

impl<'a> RootedWriter<'a> {
    pub(crate) fn new(target: &'a Path) -> Self {
        Self {
            target,
            root: None,
            root_path_bytes: target.as_os_str().as_bytes().len(),
            parents: HashMap::new(),
        }
    }

    pub(crate) fn invalidate(&mut self) {
        self.parents.clear();
        // Release even the root before checked tar extraction: under FD pressure
        // it can occupy the last slot needed to create the output file.
        self.root = None;
    }

    fn parent_fd(&mut self, parent: &Path) -> io::Result<Option<RawFd>> {
        if let Some(directory) = self.parents.get(parent) {
            return Ok(Some(directory.as_raw_fd()));
        }
        let mut previous = match &self.root {
            Some(root) => root.as_raw_fd(),
            None => match OpenOptions::new()
                .read(true)
                .custom_flags(DIRECTORY_FLAGS)
                .open(self.target)
            {
                Ok(root) => self.root.insert(root).as_raw_fd(),
                Err(error) if descriptor_limit(&error) => return Ok(None),
                Err(error) => return Err(error),
            },
        };
        let mut prefix = PathBuf::new();
        for component in parent.components() {
            let Component::Normal(name) = component else {
                return Ok(None);
            };
            prefix.push(name);
            if let Some(directory) = self.parents.get(&prefix) {
                previous = directory.as_raw_fd();
                continue;
            }
            if self.parents.len() + 1 >= MAX_DIRECTORY_HANDLES {
                return Ok(None);
            }
            let Ok(name) = CString::new(name.as_bytes()) else {
                return Ok(None);
            };
            let directory = match open_at(previous, &name, DIRECTORY_FLAGS, 0) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    // SAFETY: previous is a live directory FD and name is NUL-terminated.
                    let result = unsafe { libc::mkdirat(previous, name.as_ptr(), 0o777) };
                    if result < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::AlreadyExists {
                            return Err(error);
                        }
                    }
                    open_at(previous, &name, DIRECTORY_FLAGS, 0)
                }
                result => result,
            };
            let directory = match directory {
                Ok(directory) => directory,
                // A symlink parent needs tar's containment/rejection behavior.
                Err(error)
                    if descriptor_limit(&error)
                        || matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) =>
                {
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            previous = directory.as_raw_fd();
            self.parents.insert(prefix.clone(), directory);
        }
        Ok(Some(previous))
    }

    /// Only creates fresh leaves. Before a caller uses its checked replacement
    /// or link path, it must release these handles with invalidate().
    pub(crate) fn create_new(&mut self, relative: &Path) -> io::Result<Option<File>> {
        // Descriptor-relative syscalls can exceed the full-path limit. Retain
        // the existing path-based behavior rather than accepting new spellings.
        let path_bytes = relative.as_os_str().as_bytes();
        if path_bytes.contains(&0)
            || self.root_path_bytes + 1 + path_bytes.len() >= libc::PATH_MAX as usize
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Ok(None);
        }
        let Some(name) = relative.file_name() else {
            return Ok(None);
        };
        let Ok(name) = CString::new(name.as_bytes()) else {
            return Ok(None);
        };
        let Some(parent) = relative.parent() else {
            return Ok(None);
        };
        let Some(parent) = self.parent_fd(parent)? else {
            return Ok(None);
        };
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        match open_at(parent, &name, flags, 0o666) {
            Ok(file) => Ok(Some(file)),
            // Never truncate an existing inode: tar unlinks/recreates it, which
            // also preserves other hardlinks to that inode.
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists || descriptor_limit(&error) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// False leaves payload unread: invalidate parents before checked tar unpack.
    /// Once a leaf is created, any payload or metadata failure is returned, never
    /// retried. Tar's default mode/mtime behavior is reproduced only for plain files.
    pub(super) fn try_unpack<R: Read>(
        &mut self,
        relative: &Path,
        entry: &mut tar::Entry<'_, R>,
    ) -> io::Result<bool> {
        // tar treats slash-terminated old/GNU regular entries as directories.
        // Check raw bytes before Path normalization loses the trailing slash.
        if entry.header().as_ustar().is_none() && entry.path_bytes().ends_with(b"/") {
            return Ok(false);
        }
        let (Ok(mode), Ok(mtime)) = (entry.header().mode(), entry.header().mtime()) else {
            return Ok(false);
        };
        if mtime > i64::MAX as u64 {
            return Ok(false);
        }
        // tar maps epoch-zero file times to one second for compatibility.
        let Some(modified) = UNIX_EPOCH.checked_add(Duration::from_secs(mtime.max(1))) else {
            return Ok(false);
        };
        let Some(mut file) = self.create_new(relative)? else {
            return Ok(false);
        };
        let expected = entry.size();
        if io::copy(entry, &mut file)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "failed to write entire tar file",
            ));
        }
        file.set_times(
            FileTimes::new()
                .set_accessed(modified)
                .set_modified(modified),
        )?;
        file.set_permissions(Permissions::from_mode(mode & 0o777))?;
        Ok(true)
    }
}

fn descriptor_limit(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::EMFILE | libc::ENFILE))
}

fn open_at(parent: RawFd, name: &CStr, flags: libc::c_int, mode: libc::mode_t) -> io::Result<File> {
    // SAFETY: the caller holds parent open; name is NUL-terminated and mode is
    // supplied even when flags do not request creation (then it is ignored).
    let raw = unsafe { libc::openat(parent, name.as_ptr(), flags, mode) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openat returns a new owned descriptor, transferred once.
    Ok(unsafe { File::from_raw_fd(raw) })
}
