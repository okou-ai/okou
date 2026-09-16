//! Direct materialization under the same target ownership as archive extraction.

use guest_contracts::storage_files::{StorageFile, StorageFiles, decoded_mount_conflicts};
use guest_contracts::storage_manifest::Manifest;
use std::fs::{self, FileTimes, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

pub(crate) fn validate_bindings(manifest: &Manifest, groups: &[StorageFiles]) -> io::Result<()> {
    for group in groups {
        let (index, entry) = manifest
            .storages
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.mount_path == group.mount_path)
            .ok_or_else(|| io::Error::other("decoded storage mount absent"))?;
        if entry.cached
            || entry.extract_path.is_some()
            || entry.instructions_target_filename.is_some()
            || entry
                .archive_url
                .as_deref()
                .is_none_or(|url| url.is_empty() || url == "null")
        {
            return Err(io::Error::other(
                "decoded storage source is not an ordinary download",
            ));
        }
        let target = Path::new(&group.mount_path);
        for (other_index, other) in manifest.storages.iter().enumerate() {
            if other_index == index {
                continue;
            }
            if decoded_mount_conflicts(
                target,
                Path::new(&other.mount_path),
                other.instructions_target_filename.as_deref(),
                other.extract_path.as_deref().map(Path::new),
                other
                    .archive_url
                    .as_deref()
                    .is_some_and(|url| url != "null"),
            ) {
                return Err(io::Error::other("decoded storage overlaps another mount"));
            }
        }
        for other in &manifest.artifacts {
            if decoded_mount_conflicts(target, Path::new(&other.mount_path), None, None, true) {
                return Err(io::Error::other("decoded storage overlaps another mount"));
            }
        }
    }
    Ok(())
}

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
