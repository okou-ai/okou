//! Isolate discarded Memory under the existing post-Run runtime cleanup owner.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::runtime_paths;
use guest_contracts::storage_manifest::Manifest;
use guest_contracts::storage_paths::normalize_path;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub(crate) struct Quarantine {
    parent: CleanupDirectory,
    eligible: HashSet<PathBuf>,
    recovery_targets: HashSet<PathBuf>,
    discarded: Mutex<Discarded>,
}

#[derive(Default)]
struct Discarded {
    entries: HashMap<PathBuf, OsString>,
    reclaimed: Option<bool>,
    retried: HashSet<PathBuf>,
}

impl Quarantine {
    pub(crate) fn for_manifest(
        manifest: &Manifest,
        runtime_dir: &Path,
    ) -> io::Result<Option<Arc<Self>>> {
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
        if manifest
            .storages
            .iter()
            .map(|entry| Path::new(&entry.mount_path))
            .chain(
                manifest
                    .artifacts
                    .iter()
                    .map(|entry| Path::new(&entry.mount_path)),
            )
            .any(|path| !path.is_absolute() || normalize_path(path) != path)
        {
            return Ok(None);
        }
        let all_targets = manifest
            .storages
            .iter()
            .map(|entry| normalize_path(Path::new(&entry.mount_path)))
            .chain(
                manifest
                    .artifacts
                    .iter()
                    .map(|entry| normalize_path(Path::new(&entry.mount_path))),
            )
            .collect::<Vec<_>>();
        if all_targets.iter().any(|path| overlaps(path, &private))
            || all_targets.iter().enumerate().any(|(index, path)| {
                !path.is_absolute()
                    || path == home
                    || !path.starts_with(home)
                    || all_targets
                        .iter()
                        .skip(index + 1)
                        .any(|other| overlaps(path, other))
            })
            || manifest
                .cleanup_paths
                .iter()
                .any(|path| overlaps(&normalize_path(Path::new(path)), &private))
        {
            return Ok(None);
        }
        let eligible = manifest
            .artifacts
            .iter()
            .filter(|entry| {
                entry.vas_storage_name.as_deref() == Some("memory")
                    && !entry.cached
                    && !entry.empty
                    && entry.archive_url.is_some()
            })
            .map(|entry| normalize_path(Path::new(&entry.mount_path)))
            .filter(|path| {
                path != home
                    && path.starts_with(home)
                    && all_targets
                        .iter()
                        .filter(|other| overlaps(path, other))
                        .count()
                        == 1
                    && manifest
                        .cleanup_paths
                        .iter()
                        .any(|cleanup| normalize_path(Path::new(cleanup)) == *path)
            })
            .collect::<HashSet<_>>();
        if eligible.is_empty() {
            return Ok(None);
        }
        // This is the existing managed runtime parent, never a new global GC
        // root. Existing idle/cache preparation already owns every unprotected
        // direct child, including these discarded trees.
        runtime_paths::ensure_dir(runtime_dir)?;
        let parent = CleanupDirectory::open(parent)?;
        if parent.metadata()?.permissions().mode() & 0o777 != 0o700 {
            return Err(io::Error::other("runtime parent is not private"));
        }
        let device = parent.metadata()?.dev();
        for target in &all_targets {
            let mut existing = target.as_path();
            loop {
                match CleanupDirectory::open(existing) {
                    Ok(directory) => {
                        if directory.metadata()?.dev() != device {
                            return Ok(None);
                        }
                        break;
                    }
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
        Ok(Some(Arc::new(Self {
            parent,
            eligible,
            recovery_targets: all_targets.into_iter().collect(),
            discarded: Mutex::new(Discarded::default()),
        })))
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
            || metadata.dev() != self.parent.metadata()?.dev()
            || !can_rename(&logical, metadata.dev())?
        {
            return Ok(false);
        }
        let destination = OsString::from(format!(".stale-memory-{}", uuid::Uuid::new_v4()));
        match source.rename_child_to(&name, &self.parent, &destination) {
            Ok(()) => {}
            // Nothing moved. The original required synchronous cleanup can
            // handle another mount or reclaim space needed for rename metadata.
            Err(error)
                if error.raw_os_error() == Some(libc::EXDEV)
                    || crate::error::is_space_exhausted(&error) =>
            {
                return Ok(false);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
        self.discarded
            .lock()
            .map_err(|_| io::Error::other("discarded Memory custody is unavailable"))?
            .entries
            .insert(logical, destination);
        Ok(true)
    }

    /// One shared reclaim attempt may admit one fresh attempt per disjoint
    /// target, including workers that failed before another worker reclaimed.
    pub(crate) fn reclaim_for(&self, path: &Path) -> bool {
        let Ok(mut discarded) = self.discarded.lock() else {
            return false;
        };
        let logical = normalize_path(path);
        if !self.recovery_targets.contains(&logical) || discarded.retried.contains(&logical) {
            return false;
        }
        if discarded.reclaimed.is_none() {
            let mut freed = false;
            discarded.entries.retain(|_, name| {
                match fs::remove_dir_all(self.parent.proc_path().join(name)) {
                    Ok(()) => {
                        freed = true;
                        false
                    }
                    Err(error) => {
                        guest_telemetry::log_info!(
                            crate::LOG_TAG,
                            "Deferred Memory space recovery did not complete: {error}"
                        );
                        true
                    }
                }
            });
            discarded.reclaimed = Some(freed);
        }
        if discarded.reclaimed == Some(true) {
            discarded.retried.insert(logical);
            true
        } else {
            false
        }
    }
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}
