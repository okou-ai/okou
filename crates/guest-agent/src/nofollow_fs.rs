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
//! Optional reclamation can stop cooperatively between filesystem operations;
//! it retains immediate-child progress on error and leaves unfinished directories
//! linked. Mandatory cleanup retains its complete-or-error behavior.
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
use std::os::fd::AsRawFd;
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
pub(crate) struct RemovalOutcome {
    pub(crate) removed_entries: u64,
    pub(crate) error: Option<io::Error>,
}

#[cfg(target_os = "linux")]
struct RemovalPolicy<'a> {
    filesystem: FileIdentity,
    protected: &'a [FileIdentity],
}

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

    pub(crate) fn available_capacity(&self) -> io::Result<(u64, u64)> {
        let stats = rustix::fs::fstatvfs(&self.0)?;
        Ok((
            stats.f_bavail.saturating_mul(stats.f_frsize),
            stats.f_favail,
        ))
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

    pub(crate) fn create_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        let child = child_name_c_string(name)?;
        match rustix::fs::mkdirat(&self.0, child.as_c_str(), rustix::fs::Mode::RWXU) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => self.open_child_dir(name),
            Err(error) => Err(error.into()),
        }
    }

    /// Create a fresh regular file without following or truncating an existing leaf.
    pub(crate) fn create_child_file(&self, name: &OsStr) -> io::Result<File> {
        use rustix::fs::{Mode, OFlags, openat};

        let name = child_name_c_string(name)?;
        openat(
            &self.0,
            name.as_c_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map(File::from)
        .map_err(Into::into)
    }

    pub(crate) fn unlink_child_file(&self, name: &OsStr) -> io::Result<()> {
        unlink_child(&self.0, name, AtFlags::empty())
    }

    pub(crate) fn remove_children_except(
        &self,
        excluded_names: &[OsString],
        filesystem: FileIdentity,
        protected: &[FileIdentity],
    ) -> io::Result<u64> {
        let outcome =
            self.remove_children_except_while(excluded_names, filesystem, protected, &mut || {
                Ok(true)
            });
        match outcome.error {
            Some(error) => Err(error),
            None => Ok(outcome.removed_entries),
        }
    }

    /// Stop cooperatively without unlinking an unfinished directory. Progress
    /// counts immediate children even if a later entry or stop check fails.
    pub(crate) fn remove_children_except_while(
        &self,
        excluded_names: &[OsString],
        filesystem: FileIdentity,
        protected: &[FileIdentity],
        keep_going: &mut impl FnMut() -> io::Result<bool>,
    ) -> RemovalOutcome {
        let mut raw_dir_buffer = [MaybeUninit::<u8>::uninit(); REMOVE_RAW_DIR_BUFFER_BYTES];
        let mut removed_entries = 0;
        let policy = RemovalPolicy {
            filesystem,
            protected,
        };
        let mut stopped = false;
        let mut continue_removal = || {
            if stopped {
                return Ok(false);
            }
            let proceed = keep_going()?;
            stopped = !proceed;
            Ok(proceed)
        };
        let result = self.remove_children(
            excluded_names,
            &policy,
            0,
            &mut raw_dir_buffer,
            &mut removed_entries,
            &mut continue_removal,
        );
        RemovalOutcome {
            removed_entries,
            error: result.err(),
        }
    }

    fn remove_children(
        &self,
        excluded_names: &[OsString],
        policy: &RemovalPolicy<'_>,
        depth: usize,
        raw_dir_buffer: &mut [MaybeUninit<u8>],
        removed: &mut u64,
        keep_going: &mut impl FnMut() -> io::Result<bool>,
    ) -> io::Result<()> {
        loop {
            if !keep_going()? {
                return Ok(());
            }
            rustix::fs::seek(&self.0, SeekFrom::Start(0))?;
            let before = *removed;
            self.remove_children_pass(
                excluded_names,
                policy,
                depth,
                raw_dir_buffer,
                removed,
                keep_going,
            )?;
            if *removed == before {
                return Ok(());
            }
        }
    }

    fn remove_children_pass(
        &self,
        excluded_names: &[OsString],
        policy: &RemovalPolicy<'_>,
        depth: usize,
        raw_dir_buffer: &mut [MaybeUninit<u8>],
        removed: &mut u64,
        keep_going: &mut impl FnMut() -> io::Result<bool>,
    ) -> io::Result<()> {
        while let Some(names) = self.read_child_chunk(excluded_names, raw_dir_buffer, keep_going)? {
            self.remove_child_chunk(names, policy, depth, raw_dir_buffer, removed, keep_going)?;
        }
        Ok(())
    }

    fn read_child_chunk(
        &self,
        excluded_names: &[OsString],
        raw_dir_buffer: &mut [MaybeUninit<u8>],
        keep_going: &mut impl FnMut() -> io::Result<bool>,
    ) -> io::Result<Option<Vec<OsString>>> {
        loop {
            if !keep_going()? {
                return Ok(None);
            }
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
        policy: &RemovalPolicy<'_>,
        depth: usize,
        raw_dir_buffer: &mut [MaybeUninit<u8>],
        removed: &mut u64,
        keep_going: &mut impl FnMut() -> io::Result<bool>,
    ) -> io::Result<()> {
        for name in names {
            if !keep_going()? {
                return Ok(());
            }
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
                    identity.ensure_same_mount(policy.filesystem)?;
                    if policy.protected.contains(&identity) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "refusing to remove a protected runtime directory",
                        ));
                    }
                    let mut removed_children = 0;
                    child.remove_children(
                        &[],
                        policy,
                        child_depth,
                        raw_dir_buffer,
                        &mut removed_children,
                        keep_going,
                    )?;
                    if !keep_going()? {
                        return Ok(());
                    }
                    if unlink_child_if_present(&self.0, &name, AtFlags::REMOVEDIR)? {
                        *removed = removed.saturating_add(1);
                    }
                }
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(libc::ENOTDIR) | Some(libc::ELOOP)
                    ) =>
                {
                    if !keep_going()? {
                        return Ok(());
                    }
                    if unlink_child_if_present(&self.0, &name, AtFlags::empty())? {
                        *removed = removed.saturating_add(1);
                    }
                }
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
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
    let fd = nix::fcntl::openat(
        parent,
        name.as_c_str(),
        nix::fcntl::OFlag::from_bits_retain(flags),
        nix::sys::stat::Mode::empty(),
    )?;
    Ok(File::from(fd))
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
fn unlink_child(parent: &File, name: &OsStr, flags: AtFlags) -> io::Result<()> {
    let name = child_name_c_string(name)?;
    rustix::fs::unlinkat(parent, name.as_c_str(), flags).map_err(Into::into)
}

#[cfg(target_os = "linux")]
fn unlink_child_if_present(parent: &File, name: &OsStr, flags: AtFlags) -> io::Result<bool> {
    match unlink_child(parent, name, flags) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
