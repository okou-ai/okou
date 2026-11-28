use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
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

    pub(super) fn open_child(&self, name: &OsStr) -> io::Result<Self> {
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
        let fd = nix::fcntl::openat(
            &self.0,
            name.as_c_str(),
            nix::fcntl::OFlag::from_bits_retain(flags),
            nix::sys::stat::Mode::empty(),
        )?;
        Ok(Self(File::from(fd)))
    }

    pub(super) fn read_dir(&self) -> io::Result<fs::ReadDir> {
        fs::read_dir(self.proc_path())
    }

    #[cfg(target_os = "linux")]
    pub(super) fn read_ext_directory<'a>(
        &'a self,
        entry_budget: usize,
        buffer: &'a mut [std::mem::MaybeUninit<u8>],
    ) -> Option<rustix::fs::RawDir<'a, &'a File>> {
        use rustix::fs::{Access, AtFlags, RawDir, accessat, fstatfs};

        if fstatfs(&self.0).ok()?.f_type != libc::EXT4_SUPER_MAGIC {
            return None;
        }
        // Even a bounded listing can read cold index blocks from a sparse
        // parent. Use individual lookups when the directory exceeds the
        // maximum footprint of the listing's entry budget.
        let byte_budget =
            u64::try_from(entry_budget.saturating_mul(size_of::<libc::dirent64>())).ok()?;
        if self.metadata().ok()?.len() > byte_budget {
            return None;
        }
        // A readable directory can still deny lookups of its children.
        accessat(&self.0, c".", Access::EXEC_OK, AtFlags::EACCESS).ok()?;
        Some(RawDir::new(&self.0, buffer))
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
        rustix::fs::renameat_with(
            &self.0,
            name.as_c_str(),
            &destination.0,
            destination_name.as_c_str(),
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(Into::into)
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
