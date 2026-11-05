use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

/// An owned directory opened without following any symlink components.
pub(super) struct CleanupDirectory(File);

impl CleanupDirectory {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        let anchor = if path.is_absolute() {
            Path::new("/")
        } else {
            Path::new(".")
        };
        let mut current = Self::open_anchor(anchor)?;

        for component in path.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::ParentDir => {
                    current = current.open_child(OsStr::new(".."))?;
                }
                Component::Normal(name) => {
                    current = current.open_child(name)?;
                }
                Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "cleanup path contains an unsupported prefix",
                    ));
                }
            }
        }

        Ok(current)
    }

    pub(super) fn open_parent(path: &Path) -> io::Result<(Self, OsString)> {
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "cleanup path has no removable basename",
            )
        })?;
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        Ok((Self::open(parent)?, name.to_os_string()))
    }

    fn open_anchor(path: &Path) -> io::Result<Self> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map(Self)
    }

    fn open_child(&self, name: &OsStr) -> io::Result<Self> {
        let bytes = name.as_bytes();
        if bytes.is_empty() || bytes.contains(&b'/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cleanup path component must be a non-empty basename",
            ));
        }
        let name =
            CString::new(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: the parent fd is owned by this live `CleanupDirectory`,
        // `name` is a validated NUL-terminated basename, and these flags do
        // not require a mode argument.
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful `openat` returns a new owned file descriptor.
        Ok(Self(unsafe { File::from_raw_fd(fd) }))
    }

    pub(super) fn read_dir(&self) -> io::Result<fs::ReadDir> {
        fs::read_dir(self.proc_path())
    }

    /// Keep this directory alive until all operations on the returned path finish.
    pub(super) fn proc_path(&self) -> PathBuf {
        PathBuf::from("/proc/self/fd").join(self.0.as_raw_fd().to_string())
    }

    pub(super) fn metadata(&self) -> io::Result<fs::Metadata> {
        self.0.metadata()
    }

    #[cfg(target_os = "linux")]
    pub(super) fn rename_child_to(
        &self,
        name: &OsStr,
        destination: &Self,
        destination_name: &OsStr,
    ) -> io::Result<()> {
        let basename = |name: &OsStr| {
            if name.as_bytes().is_empty() || name.as_bytes().contains(&b'/') {
                return Err(io::Error::other("rename requires a non-empty basename"));
            }
            CString::new(name.as_bytes()).map_err(io::Error::other)
        };
        let name = basename(name)?;
        let destination_name = basename(destination_name)?;
        // SAFETY: both parents own live directory descriptors and both names
        // are validated NUL-terminated basenames. NOREPLACE never overwrites
        // another runtime child, including after a destination-name race.
        let result = unsafe {
            libc::renameat2(
                self.0.as_raw_fd(),
                name.as_ptr(),
                destination.0.as_raw_fd(),
                destination_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn rename_child_to(
        &self,
        _name: &OsStr,
        _destination: &Self,
        _destination_name: &OsStr,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "deferred input cleanup requires Linux renameat2",
        ))
    }
}
