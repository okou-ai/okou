//! Direct materialization under the same target ownership as archive extraction.

use guest_contracts::storage_files::StorageFile;
use std::fs::{self, FileTimes, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

pub(crate) fn materialize(files: &[StorageFile], target: &Path) -> io::Result<()> {
    for entry in files {
        let path = target.join(&entry.path);
        if !crate::archive::ancestors_within_target(&path, target) {
            // Archive extraction also skips entries with escaping parents.
            guest_telemetry::log_warn!(
                crate::LOG_TAG,
                "Skipping decoded entry with escaping parent: {}",
                entry.path
            );
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Like tar::Entry::unpack_in, replace the inode instead of truncating an
        // existing hardlink that could point outside this mount.
        let open = || {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&path)
        };
        let mut file = match open() {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                open()?
            }
            result => result?,
        };
        file.write_all(&entry.content)?;
        file.set_permissions(Permissions::from_mode(entry.mode))?;
        // tar normalizes epoch-zero timestamps to one second.
        let modified = UNIX_EPOCH
            .checked_add(Duration::from_secs(entry.mtime.max(1)))
            .ok_or_else(|| io::Error::other("decoded storage timestamp out of range"))?;
        file.set_times(
            FileTimes::new()
                .set_accessed(modified)
                .set_modified(modified),
        )?;
    }
    Ok(())
}
