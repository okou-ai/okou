//! Reclaim fixed package caches during bootstrap or reuse preparation.
//!
//! This helper never initializes the ordinary agent runtime or writes a file in
//! home. It retains cache roots, work, installed environments, credentials and
//! histories. Deletion can be partial on error; it is not transactional.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};

use crate::nofollow_fs::Dir;

// uv's supported symlink link mode installs packages backed by its cache.
// Retain that cache because deleting it can break an installed environment.
const HOME_CACHES: &[&[&str]] = &[
    &[".npm", "_cacache"],
    &[".npm", "_logs"],
    &[".cache", "pip"],
];
const ROOT_CACHES: &[&[&str]] = &[
    &["var", "cache", "apt", "archives"],
    &["root", ".npm", "_cacache"],
    &["root", ".npm", "_logs"],
    &["root", ".cache", "pip"],
];

/// Reclaim allowlisted caches on one selected filesystem.
///
/// # Errors
/// Refuses concurrent supervised workloads, unsafe path components, mount
/// boundaries, changed root identities, failed deletion or unavailable capacity.
pub fn recover(filesystem: DiskCleanupFilesystem) -> io::Result<DiskCleanupReport> {
    crate::reuse_preparation::verify_process_containment()?;
    let path = filesystem_root(filesystem);
    let root = Dir::open_absolute(&path)?;
    let identity = root.identity()?;
    let (available_bytes_before, available_inodes_before) = root.available_capacity()?;
    let caches = match filesystem {
        DiskCleanupFilesystem::Home => HOME_CACHES,
        DiskCleanupFilesystem::Rootfs => ROOT_CACHES,
    };

    // Validate every existing candidate before mutating any cache. A missing
    // standard cache is expected; an unsafe cache root must not widen deletion.
    let mut opened = Vec::new();
    for components in caches {
        if let Some(cache) = open_cache(&root, components)? {
            cache.identity()?.ensure_same_mount(identity)?;
            opened.push((components, cache));
        }
    }
    let mut removed_entries = 0u64;
    for (components, cache) in &opened {
        let excluded = if **components == ["var", "cache", "apt", "archives"] {
            vec![OsString::from("lock")]
        } else {
            Vec::new()
        };
        removed_entries = removed_entries.saturating_add(cache.remove_children_except(
            &excluded,
            identity,
            &[],
        )?);
        let current = open_cache(&root, components)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "cache root disappeared during cleanup",
            )
        })?;
        if current.identity()? != cache.identity()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "cache root changed during cleanup",
            ));
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

fn open_cache(root: &Dir, components: &[&str]) -> io::Result<Option<Dir>> {
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
