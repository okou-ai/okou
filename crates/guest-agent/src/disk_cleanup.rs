//! Reclaim fixed disposable paths during bootstrap or reuse preparation.
//!
//! This helper never initializes the ordinary agent runtime or writes a file in
//! home. It retains cleanup roots and persistent state outside the disposable
//! paths. Rootfs recovery treats `/tmp` contents as disposable
//! after verifying sole-workload containment. Deletion can be partial on error;
//! it is not transactional. All candidates share a two-second cooperative
//! deletion budget; sufficient capacity or budget exhaustion is a normal stop.
//! Individual candidate failures do not discard the measured remaining capacity.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use guest_contracts::disk_cleanup::{
    DiskCleanupFilesystem, DiskCleanupReport, has_recovery_reserve,
};

use crate::nofollow_fs::Dir;

const DELETION_BUDGET: Duration = Duration::from_secs(2);
const CAPACITY_PROBE_INTERVAL: usize = 64;

// uv's supported symlink link mode installs packages backed by its cache.
// Retain that cache because deleting it can break an installed environment.
const HOME_CLEANUP_PATHS: &[&[&str]] = &[
    &[".npm", "_cacache"],
    &[".npm", "_logs"],
    &[".cache", "pip"],
];
const ROOTFS_CLEANUP_PATHS: &[&[&str]] = &[
    &["var", "cache", "apt", "archives"],
    &["root", ".npm", "_cacache"],
    &["root", ".npm", "_logs"],
    &["root", ".cache", "pip"],
    &["tmp"],
];

/// Reclaim allowlisted disposable contents on one selected filesystem.
///
/// # Errors
/// Fails when process containment, the selected root's identity or current
/// capacity cannot be verified. Unsafe or unavailable individual candidates are
/// skipped without following their targets or crossing mount boundaries.
pub fn recover(filesystem: DiskCleanupFilesystem) -> io::Result<DiskCleanupReport> {
    crate::reuse_preparation::verify_process_containment()?;
    let path = filesystem_root(filesystem);
    let root = Dir::open_absolute(&path)?;
    let identity = root.identity()?;
    let (available_bytes_before, available_inodes_before) = root.available_capacity()?;
    let deadline = Instant::now() + DELETION_BUDGET;
    let cleanup_paths = match filesystem {
        DiskCleanupFilesystem::Home => HOME_CLEANUP_PATHS,
        DiskCleanupFilesystem::Rootfs => ROOTFS_CLEANUP_PATHS,
    };

    let mut removed_entries = 0u64;
    for components in cleanup_paths {
        let (bytes, inodes) = root.available_capacity()?;
        if Instant::now() >= deadline || has_recovery_reserve(bytes, inodes) {
            break;
        }
        // Optional candidates are inspected only when still needed. An unsafe
        // candidate never widens deletion or prevents another safe candidate.
        let directory = match open_cleanup_dir(&root, components) {
            Ok(Some(directory)) => directory,
            Ok(None) => continue,
            Err(error) => {
                eprintln!(
                    "skip disk cleanup candidate {}: {error}",
                    components.join("/")
                );
                continue;
            }
        };
        let excluded = if *components == ["var", "cache", "apt", "archives"] {
            vec![OsString::from("lock")]
        } else {
            Vec::new()
        };
        let mut until_probe = 0;
        let outcome = directory.remove_children_except_while(&excluded, identity, &[], &mut || {
            if Instant::now() >= deadline {
                return Ok(false);
            }
            if until_probe == 0 {
                let (bytes, inodes) = root.available_capacity()?;
                if has_recovery_reserve(bytes, inodes) || Instant::now() >= deadline {
                    return Ok(false);
                }
                until_probe = CAPACITY_PROBE_INTERVAL;
            }
            until_probe -= 1;
            Ok(true)
        });
        removed_entries = removed_entries.saturating_add(outcome.removed_entries);
        let current = open_cleanup_dir(&root, components)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "cleanup root disappeared during cleanup",
            )
        })?;
        if current.identity()? != directory.identity()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "cleanup root changed during cleanup",
            ));
        }
        if let Some(error) = outcome.error {
            eprintln!(
                "partial disk cleanup candidate {}: {error}",
                components.join("/")
            );
        }
    }
    if Dir::open_absolute(&path)?.identity()? != identity {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "selected filesystem root changed during cleanup",
        ));
    }
    let (available_bytes_after, available_inodes_after) = root.available_capacity()?;
    Ok(DiskCleanupReport {
        filesystem,
        available_bytes_before,
        available_bytes_after,
        available_inodes_before,
        available_inodes_after,
        removed_entries,
    })
}

fn open_cleanup_dir(root: &Dir, components: &[&str]) -> io::Result<Option<Dir>> {
    let mut current = root.try_clone()?;
    for name in components {
        match current.open_child_dir(name.as_ref()) {
            Ok(child) => {
                child.identity()?.ensure_same_mount(root.identity()?)?;
                current = child;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(Some(current))
}

fn filesystem_root(filesystem: DiskCleanupFilesystem) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("OKOU_TEST_DISK_CLEANUP_ROOT") {
        return match filesystem {
            DiskCleanupFilesystem::Home => PathBuf::from(root).join("home/user"),
            DiskCleanupFilesystem::Rootfs => PathBuf::from(root),
        };
    }
    Path::new(match filesystem {
        DiskCleanupFilesystem::Home => return crate::reuse_preparation::home_path(),
        DiskCleanupFilesystem::Rootfs => "/",
    })
    .to_path_buf()
}

#[cfg(test)]
mod tests;
