//! Scoped permission changes for existing, fixture-owned directories.

use std::fs::{File, OpenOptions, Permissions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// Restores a directory's original permissions before its temporary tree is removed.
///
/// Acquire this owner before restricting access, and keep it alive through the
/// last permission-sensitive observation. Call [`Self::restore`] to check normal
/// completion; dropping it also makes a best-effort, non-panicking restoration
/// during unwinding. It cannot clean up after process abort or termination.
///
/// Restoration uses the captured directory descriptor, so renaming or replacing
/// the path cannot redirect the chmod. It does not change ownership or repair
/// permissions elsewhere in the tree.
#[must_use = "retain the guard until permission-sensitive observations are complete"]
pub struct DirectoryPermissions {
    directory: File,
    original: Option<Permissions>,
}

impl DirectoryPermissions {
    /// Captures an existing real directory's permissions, then applies `mode`.
    pub fn set(path: &Path, mode: u32) -> io::Result<Self> {
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)?;
        let original = directory.metadata()?.permissions();
        let guard = Self {
            directory,
            original: Some(original),
        };
        guard
            .directory
            .set_permissions(Permissions::from_mode(mode))?;
        Ok(guard)
    }

    /// Restores the original permissions, reporting any error to the test.
    pub fn restore(mut self) -> io::Result<()> {
        self.restore_permissions()
    }

    fn restore_permissions(&mut self) -> io::Result<()> {
        if let Some(original) = &self.original {
            self.directory.set_permissions(original.clone())?;
            self.original = None;
        }
        Ok(())
    }
}

impl Drop for DirectoryPermissions {
    fn drop(&mut self) {
        let _ = self.restore_permissions();
    }
}
