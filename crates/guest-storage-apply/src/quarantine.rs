//! Isolate discarded input directories under the existing post-Run cleanup owner.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::runtime_paths;
use guest_contracts::storage_manifest::Manifest;
use guest_contracts::storage_paths::normalize_path;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub(crate) struct Quarantine {
    parent: CleanupDirectory,
    device: u64,
    eligible: HashSet<PathBuf>,
}

impl Quarantine {
    pub(crate) fn for_manifest(
        manifest: &Manifest,
        runtime_dir: &Path,
    ) -> io::Result<Option<Self>> {
        if !cfg!(target_os = "linux")
            || !runtime_dir.is_absolute()
            || normalize_path(runtime_dir) != runtime_dir
        {
            return Ok(None);
        }
        let Some(parent) = runtime_dir.parent() else {
            return Ok(None);
        };
        let Some(home) = parent.ancestors().nth(3) else {
            return Ok(None);
        };
        if runtime_paths::runtime_parent_for_home(home) != parent {
            return Ok(None);
        }
        let private = normalize_path(parent);
        let eligible = manifest
            .cleanup_paths
            .iter()
            .map(Path::new)
            .filter(|path| {
                path.is_absolute()
                    && normalize_path(path) == *path
                    && *path != home
                    && path.starts_with(home)
                    && !overlaps(path, &private)
            })
            .map(Path::to_owned)
            .collect::<HashSet<_>>();
        if eligible.is_empty() {
            return Ok(None);
        }
        let targets = manifest
            .storages
            .iter()
            .map(|entry| Path::new(&entry.mount_path))
            .chain(
                manifest
                    .artifacts
                    .iter()
                    .map(|entry| Path::new(&entry.mount_path)),
            )
            .collect::<Vec<_>>();
        if targets.iter().any(|path| {
            !path.is_absolute() || normalize_path(path) != *path || overlaps(path, &private)
        }) || manifest
            .cleanup_paths
            .iter()
            .any(|path| overlaps(&normalize_path(Path::new(path)), &private))
        {
            return Ok(None);
        }
        // Inputs must not alias the private cleanup namespace through symlink
        // ancestors. Missing roots are checked through their nearest parent.
        for target in targets {
            let mut existing = target;
            loop {
                match CleanupDirectory::open(existing) {
                    Ok(_) => break,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        let Some(ancestor) = existing.parent() else {
                            return Ok(None);
                        };
                        existing = ancestor;
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::NotADirectory | io::ErrorKind::PermissionDenied
                        ) || error.raw_os_error() == Some(libc::ELOOP) =>
                    {
                        return Ok(None);
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        // Existing final exec/park and terminal cache preparation own every
        // unprotected child. No background deletion or additional queue exists.
        runtime_paths::ensure_dir(runtime_dir)?;
        let parent = CleanupDirectory::open(parent)?;
        let metadata = parent.metadata()?;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Err(io::Error::other("runtime parent is not private"));
        }
        Ok(Some(Self {
            parent,
            device: metadata.dev(),
            eligible,
        }))
    }

    pub(crate) fn try_move(
        &self,
        path: &Path,
        can_rename: impl FnOnce(&Path, u64) -> io::Result<bool>,
    ) -> io::Result<bool> {
        let logical = normalize_path(path);
        if !self.eligible.contains(&logical) {
            return Ok(false);
        }
        let (source, name) = match CleanupDirectory::open_parent(path) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let metadata = match fs::symlink_metadata(source.proc_path().join(&name)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        if !metadata.is_dir()
            || metadata.dev() != self.device
            || !can_rename(&logical, metadata.dev())?
        {
            return Ok(false);
        }
        let destination = format!(".stale-input-{}", uuid::Uuid::new_v4());
        match source.rename_child_to(&name, &self.parent, destination.as_ref()) {
            Ok(()) => Ok(true),
            // Nothing moved. Keep the required synchronous cleanup for a
            // filesystem boundary that device identity alone cannot establish.
            Err(error) if error.raw_os_error() == Some(libc::EXDEV) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}
