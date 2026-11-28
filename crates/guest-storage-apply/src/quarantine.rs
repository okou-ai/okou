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
use std::thread;
use std::time::{Duration, Instant};

const WIDE_TARGET_COUNT: usize = 64;
const TARGET_READERS: usize = 4;
const SAMPLE_TARGETS: usize = 16;
const SLOW_SAMPLE: Duration = Duration::from_millis(1);

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
        #[cfg(target_os = "linux")]
        let unchecked = unchecked_after_listing(manifest, home);
        #[cfg(not(target_os = "linux"))]
        let unchecked: Option<Vec<&Path>> = None;
        let eligible_targets = match unchecked {
            Some(paths) if paths.len() < WIDE_TARGET_COUNT => check_target_slice(&paths)?,
            Some(paths) => check_targets(&paths)?,
            None => check_targets(&targets)?,
        };
        if !eligible_targets {
            return Ok(None);
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

#[cfg(target_os = "linux")]
fn unchecked_after_listing<'a>(manifest: &'a Manifest, home: &Path) -> Option<Vec<&'a Path>> {
    use guest_contracts::storage_manifest::StorageEntry;
    use std::ffi::OsStr;
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt;

    fn retained_parent(entry: &StorageEntry) -> Option<&Path> {
        if entry.cached && entry.archive_url.is_none() {
            Path::new(&entry.mount_path).parent()
        } else {
            None
        }
    }

    if manifest.storages.len() < WIDE_TARGET_COUNT {
        return None;
    }
    let groups = || {
        manifest.storages.chunk_by(|left, right| {
            retained_parent(left).is_some_and(|parent| retained_parent(right) == Some(parent))
        })
    };
    if !groups().any(|group| group.len() >= WIDE_TARGET_COUNT) {
        return None;
    }

    let mut unchecked = Vec::new();
    let mut buffer = [MaybeUninit::uninit(); 4096];
    for group in groups() {
        let paths = || group.iter().map(|entry| Path::new(&entry.mount_path));
        let parent = group
            .first()
            .and_then(retained_parent)
            .filter(|path| group.len() >= WIDE_TARGET_COUNT && path.starts_with(home))
            .and_then(|path| CleanupDirectory::open(path).ok());
        let Some(mut listing) = parent
            .as_ref()
            .and_then(|parent| parent.read_ext_directory(&mut buffer))
        else {
            unchecked.extend(paths());
            continue;
        };

        // These retained roots have no write or repair work. A typed direct
        // child of the checked parent proves the root is a real directory.
        // Bound the scan by the declared names plus "." and "..".
        let mut unverified = paths().filter_map(Path::file_name).collect::<HashSet<_>>();
        for _ in 0..unverified.len().saturating_add(2) {
            let Some(entry) = listing.next() else {
                break;
            };
            let entry = entry.ok()?;
            if entry.file_type() == rustix::fs::FileType::Directory {
                unverified.remove(OsStr::from_bytes(entry.file_name().to_bytes()));
                if unverified.is_empty() {
                    break;
                }
            }
        }
        unchecked.extend(paths().filter(|path| {
            path.file_name()
                .is_none_or(|name| unverified.contains(name))
        }));
    }
    unchecked.extend(
        manifest
            .artifacts
            .iter()
            .map(|entry| Path::new(&entry.mount_path)),
    );
    let total = manifest.storages.len() + manifest.artifacts.len();
    (unchecked.len() < total).then_some(unchecked)
}

fn check_targets(targets: &[&Path]) -> io::Result<bool> {
    if targets.len() < WIDE_TARGET_COUNT {
        return check_target_group(targets, None);
    }

    let (sample, targets) = targets.split_at(SAMPLE_TARGETS);
    let started = Instant::now();
    // Keep the existing sample cost for the decision to use parallel readers.
    if !check_target_group(sample, None)? {
        return Ok(false);
    }
    if started.elapsed() < SLOW_SAMPLE {
        return check_target_slice(targets);
    }

    check_targets_in_parallel(targets)
}

fn check_targets_in_parallel(targets: &[&Path]) -> io::Result<bool> {
    let chunk_size = targets.len().div_ceil(TARGET_READERS);
    let (first, remaining) = targets.split_at(chunk_size);
    // Overlap cold inode reads, but keep inspection results in manifest order.
    // Scoped readers all finish before the caller can start cleanup.
    thread::scope(|scope| {
        let workers = remaining
            .chunks(chunk_size)
            .map(|paths| {
                let worker = thread::Builder::new()
                    .spawn_scoped(scope, move || check_target_slice(paths))
                    .ok();
                (paths, worker)
            })
            .collect::<Vec<_>>();
        if !check_target_slice(first)? {
            return Ok(false);
        }
        for (paths, worker) in workers {
            let eligible = match worker {
                Some(worker) => worker
                    .join()
                    .unwrap_or_else(|payload| std::panic::resume_unwind(payload))?,
                // A slice stays with the caller if the OS cannot start its reader.
                None => check_target_slice(paths)?,
            };
            if !eligible {
                return Ok(false);
            }
        }
        Ok(true)
    })
}

fn check_target_slice(targets: &[&Path]) -> io::Result<bool> {
    for siblings in targets.chunk_by(|left, right| left.parent() == right.parent()) {
        // A single checked handle suffices for consecutive siblings in this
        // read-only slice. The individual walk owns errors if the open fails.
        let parent = match siblings {
            [first, _, ..] => first
                .parent()
                .and_then(|path| CleanupDirectory::open(path).ok()),
            _ => None,
        };
        if !check_target_group(siblings, parent.as_ref())? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn check_target_group(targets: &[&Path], parent: Option<&CleanupDirectory>) -> io::Result<bool> {
    // Inputs must not alias the private cleanup namespace through symlink
    // ancestors. Missing roots are checked through their nearest parent.
    for &target in targets {
        let anchored = parent.and_then(|parent| target.file_name().map(|name| (parent, name)));
        let mut existing = target;
        loop {
            let directory = match anchored {
                Some((parent, name)) => parent.open_child(name),
                None => CleanupDirectory::open(existing),
            };
            match directory {
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if anchored.is_some() {
                        break;
                    }
                    let Some(ancestor) = existing.parent() else {
                        return Ok(false);
                    };
                    existing = ancestor;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotADirectory | io::ErrorKind::PermissionDenied
                    ) || error.raw_os_error() == Some(libc::ELOOP) =>
                {
                    return Ok(false);
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(true)
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_checks_return_the_first_unsuccessful_result_in_manifest_order() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-a-directory");
        fs::write(&file, b"").unwrap();
        let invalid = directory.path().join("invalid\0path");
        let root = directory.path();

        assert!(!check_targets_in_parallel(&[root, &file, root, &invalid]).unwrap());
        let error = check_targets_in_parallel(&[root, &invalid, root, &file]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
