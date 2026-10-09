//! Linux fd-based no-follow filesystem primitives.
//!
//! This module owns the low-level invariant for opening directory trees
//! without following symlinks: root directories are opened with
//! `O_NOFOLLOW`, children are opened relative to their parent fd with
//! `openat`, and standard-library directory reads are anchored through
//! `/proc/self/fd/{fd}`.
//!
//! Recursive removal copies one bounded `getdents64` chunk at a time from the
//! live directory descriptor. A continuing cursor avoids rescanning removed
//! slots, and full passes restart from offset zero until one removes nothing.
//! Callers still own business error handling. This module owns the no-follow
//! filesystem primitives and bounded recursive removal needed by those callers.

#[cfg(target_os = "linux")]
use std::ffi::{CString, OsStr, OsString};
#[cfg(target_os = "linux")]
use std::fs::{self, File, OpenOptions};
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::mem::MaybeUninit;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use rustix::fs::{AtFlags, RawDir, SeekFrom, StatxFlags};

#[cfg(target_os = "linux")]
const REMOVE_RAW_DIR_BUFFER_BYTES: usize = 4 * 1024;
#[cfg(target_os = "linux")]
const REMOVE_ENTRY_CHUNK_MAX_NAMES: usize = 256;
#[cfg(target_os = "linux")]
const REMOVE_ENTRY_CHUNK_MAX_NAME_BYTES: usize = REMOVE_RAW_DIR_BUFFER_BYTES;
#[cfg(target_os = "linux")]
const REMOVE_DIRECTORY_MAX_DEPTH: usize = 256;

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    device: (u32, u32),
    inode: u64,
    mount_id: u64,
}

#[cfg(target_os = "linux")]
impl FileIdentity {
    pub(crate) fn ensure_same_mount(self, expected: Self) -> io::Result<()> {
        if self.device == expected.device && self.mount_id == expected.mount_id {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to cross a mount or filesystem boundary during cleanup",
            ))
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) struct Dir(File);

#[cfg(target_os = "linux")]
impl Dir {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map(Self)
    }

    pub(crate) fn read_dir(&self) -> io::Result<fs::ReadDir> {
        fs::read_dir(PathBuf::from(format!(
            "/proc/self/fd/{}",
            self.0.as_raw_fd()
        )))
    }

    pub(crate) fn try_clone(&self) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    pub(crate) fn open_absolute(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory path must be absolute",
            ));
        }

        let mut current = Self::open(Path::new("/"))?;
        for component in path.components() {
            match component {
                std::path::Component::RootDir => {}
                std::path::Component::Normal(name) => {
                    current = current.open_child_dir(name)?;
                }
                std::path::Component::CurDir
                | std::path::Component::ParentDir
                | std::path::Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "directory path must contain only normal components",
                    ));
                }
            }
        }
        Ok(current)
    }

    pub(crate) fn identity(&self) -> io::Result<FileIdentity> {
        file_identity(&self.0)
    }

    pub(crate) fn open_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        open_child(
            &self.0,
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map(Self)
    }

    pub(crate) fn open_child_file(&self, name: &OsStr) -> io::Result<File> {
        open_child(
            &self.0,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    }

    pub(crate) fn create_child_file(&self, name: &OsStr) -> io::Result<File> {
        let name = child_name_c_string(name)?;
        // SAFETY: the directory fd is live, `name` is a validated NUL-terminated
        // basename, and O_CREAT supplies the explicit private file mode.
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a non-negative openat result is a newly owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(crate) fn rename_child(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
        let from = child_name_c_string(from)?;
        let to = child_name_c_string(to)?;
        // SAFETY: both names are validated basenames and the same live parent
        // descriptor anchors source and destination.
        let result = unsafe {
            libc::renameat(
                self.0.as_raw_fd(),
                from.as_ptr(),
                self.0.as_raw_fd(),
                to.as_ptr(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(crate) fn unlink_child_file(&self, name: &OsStr) -> io::Result<()> {
        unlink_child(&self.0, name, 0)
    }

    pub(crate) fn remove_children_except(
        &self,
        excluded_names: &[OsString],
        filesystem: FileIdentity,
        protected: &[FileIdentity],
    ) -> io::Result<u64> {
        let mut raw_dir_buffer = [MaybeUninit::<u8>::uninit(); REMOVE_RAW_DIR_BUFFER_BYTES];
        self.remove_children(
            excluded_names,
            filesystem,
            protected,
            0,
            &mut raw_dir_buffer,
        )
    }

    fn remove_children(
        &self,
        excluded_names: &[OsString],
        filesystem: FileIdentity,
        protected: &[FileIdentity],
        depth: usize,
        raw_dir_buffer: &mut [MaybeUninit<u8>],
    ) -> io::Result<u64> {
        let mut removed = 0u64;
        loop {
            rustix::fs::seek(&self.0, SeekFrom::Start(0))?;
            let removed_in_pass = self.remove_children_pass(
                excluded_names,
                filesystem,
                protected,
                depth,
                raw_dir_buffer,
            )?;
            if removed_in_pass == 0 {
                return Ok(removed);
            }
            removed = removed.saturating_add(removed_in_pass);
        }
    }

    fn remove_children_pass(
        &self,
        excluded_names: &[OsString],
        filesystem: FileIdentity,
        protected: &[FileIdentity],
        depth: usize,
        raw_dir_buffer: &mut [MaybeUninit<u8>],
    ) -> io::Result<u64> {
        let mut removed = 0u64;
        while let Some(names) = self.read_child_chunk(excluded_names, raw_dir_buffer)? {
            removed = removed.saturating_add(self.remove_child_chunk(
                names,
                filesystem,
                protected,
                depth,
                raw_dir_buffer,
            )?);
        }
        Ok(removed)
    }

    fn read_child_chunk(
        &self,
        excluded_names: &[OsString],
        raw_dir_buffer: &mut [MaybeUninit<u8>],
    ) -> io::Result<Option<Vec<OsString>>> {
        loop {
            let (mut names, reached_end) = {
                let mut entries = RawDir::new(&self.0, raw_dir_buffer);
                let mut names = Vec::new();
                let mut name_bytes = 0usize;
                let reached_end = loop {
                    let Some(entry) = entries.next() else {
                        break true;
                    };
                    let entry = entry?;
                    let bytes = entry.file_name().to_bytes();
                    if bytes != b"."
                        && bytes != b".."
                        && !excluded_names
                            .iter()
                            .any(|excluded| excluded.as_bytes() == bytes)
                    {
                        if names.len() >= REMOVE_ENTRY_CHUNK_MAX_NAMES {
                            return Err(entry_chunk_budget_error());
                        }
                        let mut name = OsString::from_vec(bytes.to_vec());
                        name.shrink_to_fit();
                        name_bytes = name_bytes
                            .checked_add(name.capacity())
                            .filter(|bytes| *bytes <= REMOVE_ENTRY_CHUNK_MAX_NAME_BYTES)
                            .ok_or_else(entry_chunk_budget_error)?;
                        names.push(name);
                    }
                    if entries.is_buffer_empty() {
                        break false;
                    }
                };
                (names, reached_end)
            };
            if !names.is_empty() {
                names.shrink_to_fit();
                return Ok(Some(names));
            }
            if reached_end {
                return Ok(None);
            }
        }
    }

    fn remove_child_chunk(
        &self,
        names: Vec<OsString>,
        filesystem: FileIdentity,
        protected: &[FileIdentity],
        depth: usize,
        raw_dir_buffer: &mut [MaybeUninit<u8>],
    ) -> io::Result<u64> {
        let mut removed = 0u64;
        for name in names {
            match self.open_child_dir(&name) {
                Ok(child) => {
                    let child_depth = depth
                        .checked_add(1)
                        .filter(|depth| *depth <= REMOVE_DIRECTORY_MAX_DEPTH)
                        .ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                "runtime cleanup directory depth exceeds limit",
                            )
                        })?;
                    let identity = child.identity()?;
                    identity.ensure_same_mount(filesystem)?;
                    if protected.contains(&identity) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "refusing to remove a protected runtime directory",
                        ));
                    }
                    child.remove_children(
                        &[],
                        filesystem,
                        protected,
                        child_depth,
                        raw_dir_buffer,
                    )?;
                    if unlink_child_if_present(&self.0, &name, libc::AT_REMOVEDIR)? {
                        removed = removed.saturating_add(1);
                    }
                }
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(libc::ENOTDIR) | Some(libc::ELOOP)
                    ) =>
                {
                    if unlink_child_if_present(&self.0, &name, 0)? {
                        removed = removed.saturating_add(1);
                    }
                }
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(removed)
    }
}

#[cfg(target_os = "linux")]
fn entry_chunk_budget_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "runtime cleanup directory-entry chunk exceeds limit",
    )
}

#[cfg(target_os = "linux")]
pub(crate) fn file_identity(file: &File) -> io::Result<FileIdentity> {
    let mask = StatxFlags::INO | StatxFlags::MNT_ID;
    let stat = rustix::fs::statx(file, c"", AtFlags::EMPTY_PATH, mask)?;
    if !StatxFlags::from_bits_retain(stat.stx_mask).contains(mask) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem identity is unavailable",
        ));
    }
    Ok(FileIdentity {
        device: (stat.stx_dev_major, stat.stx_dev_minor),
        inode: stat.stx_ino,
        mount_id: stat.stx_mnt_id,
    })
}

#[cfg(target_os = "linux")]
fn open_child(parent: &File, name: &OsStr, flags: i32) -> io::Result<File> {
    let name = child_name_c_string(name)?;
    // SAFETY: `parent.as_raw_fd()` is an open directory fd owned by `Dir`,
    // `name` is a NUL-terminated child basename produced by `CString`, and
    // the flags do not request a mode argument.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a non-negative `openat` result is a newly owned fd. Converting
    // it into `File` transfers close responsibility to Rust.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn child_name_c_string(name: &OsStr) -> io::Result<CString> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "child name must be a non-empty basename",
        ));
    }
    CString::new(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
}

#[cfg(target_os = "linux")]
fn unlink_child(parent: &File, name: &OsStr, flags: i32) -> io::Result<()> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "child name must be a non-empty basename",
        ));
    }
    let name = CString::new(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    // SAFETY: the parent is a live directory descriptor, `name` is a
    // NUL-terminated basename, and `flags` is either zero or AT_REMOVEDIR.
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn unlink_child_if_present(parent: &File, name: &OsStr, flags: i32) -> io::Result<bool> {
    match unlink_child(parent, name, flags) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn open_rejects_symlinked_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        fs::create_dir(&real).unwrap();
        symlink(&real, &link).unwrap();

        assert!(Dir::open(&link).is_err());
    }

    #[test]
    fn open_child_dir_rejects_symlinked_child() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("root");
        let outside = dir.path().join("outside");
        fs::create_dir(&root_path).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root_path.join("linked")).unwrap();

        let root = Dir::open(&root_path).unwrap();

        assert!(root.open_child_dir(OsStr::new("linked")).is_err());
    }

    #[test]
    fn open_child_file_rejects_symlinked_child() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("root");
        let outside = dir.path().join("outside.txt");
        fs::create_dir(&root_path).unwrap();
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, root_path.join("linked.txt")).unwrap();

        let root = Dir::open(&root_path).unwrap();

        assert!(root.open_child_file(OsStr::new("linked.txt")).is_err());
    }

    #[test]
    fn open_child_rejects_nul_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = Dir::open(dir.path()).unwrap();

        let err = root
            .open_child_file(OsStr::from_bytes(b"bad\0name"))
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn open_child_rejects_invalid_child_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = Dir::open(dir.path()).unwrap();

        for name in [b"".as_slice(), b".", b"..", b"nested/file"] {
            let err = root.open_child_file(OsStr::from_bytes(name)).unwrap_err();

            assert_eq!(
                err.kind(),
                io::ErrorKind::InvalidInput,
                "name {name:?} should be rejected"
            );
        }
    }
}
