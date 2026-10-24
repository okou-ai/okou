//! Direct materialization under the same target ownership as archive extraction.

use guest_contracts::storage_files::StorageFile;
use std::fs::{self, File, FileTimes, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

pub(crate) fn materialize(files: &[StorageFile], target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let mut rooted = crate::archive::rooted::RootedWriter::new(target);
    for entry in files {
        #[cfg(target_os = "linux")]
        let file = match rooted.create_new(Path::new(&entry.path)) {
            Ok(Some(file)) => Some(file),
            Ok(None) => {
                // No leaf was opened. Release handles before the checked path
                // owns link/replacement semantics, errors and FD pressure.
                rooted.invalidate();
                checked_create(target, &entry.path)?
            }
            Err(error) => {
                rooted.invalidate();
                // Preserve the checked path's skipped-ancestor outcome, but
                // never replay an unexpected creation failure: it may already
                // have changed the destination even without returning a File.
                if checked_path(target, &entry.path).is_none() {
                    continue;
                }
                return Err(error);
            }
        };
        #[cfg(not(target_os = "linux"))]
        let file = checked_create(target, &entry.path)?;
        let Some(mut file) = file else {
            continue;
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

fn checked_path(target: &Path, relative: &str) -> Option<PathBuf> {
    let path = target.join(relative);
    if !crate::archive::ancestors_within_target(&path, target) {
        // Archive extraction also skips entries with escaping parents.
        guest_telemetry::log_warn!(
            crate::LOG_TAG,
            "Skipping decoded entry with escaping parent: {}",
            relative
        );
        return None;
    }
    Some(path)
}

fn checked_create(target: &Path, relative: &str) -> io::Result<Option<File>> {
    let Some(path) = checked_path(target, relative) else {
        return Ok(None);
    };
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
    match open() {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            open().map(Some)
        }
        result => result.map(Some),
    }
}
