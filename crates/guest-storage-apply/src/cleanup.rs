use crate::LOG_TAG;
use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::storage_paths::normalize_path;
use guest_telemetry::{log_info, log_warn};
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

/// Remove stale files from cleanup paths, preserving directories that belong
/// to unchanged storages.
///
/// For each path in `cleanup_paths`:
/// - If the path is at or below a preserved path: skip it.
/// - If a preserved path is a child: remove only top-level entries that don't
///   overlap with any preserved child path.
/// - If no `preserved` path is a child and the path is a mountpoint: preserve
///   the mountpoint directory and clean its contents.
/// - Otherwise: `remove_dir_all` (clean slate).
///
/// Stop at the first cleanup failure. Protected filesystem metadata at a
/// mountpoint root may remain; it is not a managed input.
pub(crate) fn cleanup_stale_paths(
    cleanup_paths: &[String],
    preserved: &[String],
    retained_roots: &[String],
) -> bool {
    let detector = CleanupMountPointDetector::new(cleanup_mountinfo);
    cleanup_stale_paths_with_options(
        cleanup_paths,
        preserved,
        retained_roots,
        |path| detector.is_mount_point(path),
        remove_entry,
        remove_directory_tree,
    )
}

pub(crate) fn cleanup_stale_paths_with_quarantine(
    cleanup_paths: &[String],
    preserved: &[String],
    retained_roots: &[String],
    quarantine: &crate::quarantine::Quarantine,
) -> bool {
    let detector = CleanupMountPointDetector::new(cleanup_mountinfo);
    cleanup_stale_paths_with_options(
        cleanup_paths,
        preserved,
        retained_roots,
        |path| detector.is_mount_point(path),
        remove_entry,
        |path| {
            if quarantine.try_move(path, |logical, device| {
                detector.can_quarantine(logical, device)
            })? {
                return Ok(RemoveOutcome::Removed);
            }
            remove_directory_tree(path)
        },
    )
}

#[cfg(test)]
fn cleanup_stale_paths_with_mountinfo_loader<L>(
    cleanup_paths: &[String],
    preserved: &[String],
    load_mountinfo: L,
) -> bool
where
    L: Fn() -> io::Result<Vec<u8>>,
{
    let detector = CleanupMountPointDetector::new(load_mountinfo);
    cleanup_stale_paths_with_options(
        cleanup_paths,
        preserved,
        &[],
        |path| detector.is_mount_point(path),
        remove_entry,
        remove_directory_tree,
    )
}

#[cfg(test)]
fn cleanup_stale_paths_with_mount_detector<M>(
    cleanup_paths: &[String],
    preserved: &[String],
    is_mount_point: M,
) -> bool
where
    M: Fn(&Path) -> bool,
{
    cleanup_stale_paths_with_options(
        cleanup_paths,
        preserved,
        &[],
        |path| Ok(is_mount_point(path)),
        remove_entry,
        remove_directory_tree,
    )
}

fn cleanup_stale_paths_with_options<M, R, T>(
    cleanup_paths: &[String],
    preserved: &[String],
    retained_roots: &[String],
    is_mount_point: M,
    remove_entry: R,
    remove_tree: T,
) -> bool
where
    M: Fn(&Path) -> io::Result<bool>,
    R: Fn(&fs::DirEntry) -> io::Result<()>,
    T: Fn(&Path) -> io::Result<RemoveOutcome>,
{
    let preserved = PreservedPaths::new(preserved);
    let retained_roots: HashSet<_> = retained_roots
        .iter()
        .map(|path| normalize_path(Path::new(path)))
        .collect();
    let mut sorted = cleanup_paths
        .iter()
        .map(|path| {
            let original = Path::new(path);
            CleanupPath {
                original,
                logical: normalize_path(original),
            }
        })
        .collect::<Vec<_>>();
    sorted.sort_by_key(|path| path.logical.components().count());

    for path in sorted {
        if preserved.is_preserved_or_descendant(&path.logical) {
            continue;
        }

        let preserved_child_count = preserved.count_preserved_children(&path.logical);

        let retain_root = retained_roots
            .iter()
            .any(|root| root.starts_with(&path.logical));
        let clean_contents = if preserved_child_count > 0 || retain_root {
            true
        } else {
            match is_mount_point(&path.logical) {
                Ok(mount_point) => mount_point,
                Err(e) => {
                    log_warn!(
                        LOG_TAG,
                        "Failed to classify cleanup path {}: {e}",
                        path.original.display()
                    );
                    return false;
                }
            }
        };

        if clean_contents {
            if let Err(e) = clean_directory_contents(
                path.original,
                &path.logical,
                &preserved,
                &retained_roots,
                &is_mount_point,
                &remove_entry,
            ) {
                log_warn!(
                    LOG_TAG,
                    "Failed to safely clean {}: {e}",
                    path.original.display()
                );
                return false;
            }
            if preserved_child_count > 0 {
                log_info!(
                    LOG_TAG,
                    "Selectively cleaned {} (preserved {} children)",
                    path.original.display(),
                    preserved_child_count
                );
            } else if retain_root {
                log_info!(
                    LOG_TAG,
                    "Cleaned retained target contents: {}",
                    path.original.display()
                );
            } else {
                log_info!(
                    LOG_TAG,
                    "Cleaned mountpoint contents: {}",
                    path.original.display()
                );
            }
        } else {
            match remove_tree(path.original) {
                Ok(RemoveOutcome::Removed) => {
                    log_info!(LOG_TAG, "Cleaned stale path: {}", path.original.display());
                }
                Ok(RemoveOutcome::Missing) => {}
                Err(e) => {
                    log_warn!(
                        LOG_TAG,
                        "Failed to safely clean {}: {e}",
                        path.original.display()
                    );
                    return false;
                }
            }
        }
    }
    true
}

struct CleanupPath<'a> {
    original: &'a Path,
    logical: PathBuf,
}

fn clean_directory_contents<M, R>(
    original_path: &Path,
    logical_path: &Path,
    preserved: &PreservedPaths,
    retained_roots: &HashSet<PathBuf>,
    is_mount_point: &M,
    remove_entry: &R,
) -> io::Result<()>
where
    M: Fn(&Path) -> io::Result<bool>,
    R: Fn(&fs::DirEntry) -> io::Result<()>,
{
    let directory = match CleanupDirectory::open(original_path) {
        Ok(directory) => directory,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let entries = directory.read_dir()?;

    for entry in entries {
        let entry = entry?;
        let entry_path = original_path.join(entry.file_name());
        let logical_entry_path = logical_path.join(entry.file_name());

        if preserved.entry_overlaps_preserved_path(&logical_entry_path) {
            continue;
        }

        if retained_roots
            .iter()
            .any(|root| root.starts_with(&logical_entry_path))
        {
            clean_directory_contents(
                &entry_path,
                &logical_entry_path,
                preserved,
                retained_roots,
                is_mount_point,
                remove_entry,
            )?;
            continue;
        }

        if let Err(e) = remove_entry(&entry) {
            // ext4 may expose root-owned recovery metadata on a mounted disk.
            // Only that root entry may survive a permission failure; stale
            // managed files must not silently survive cleanup.
            if e.kind() == io::ErrorKind::PermissionDenied
                && entry.file_name() == OsStr::new("lost+found")
                && is_mount_point(logical_path)?
                && entry.file_type()?.is_dir()
            {
                log_warn!(
                    LOG_TAG,
                    "Preserving protected filesystem metadata {}: {e}",
                    entry_path.display()
                );
                continue;
            }
            return Err(io::Error::new(
                e.kind(),
                format!("failed to remove {}: {e}", entry_path.display()),
            ));
        }
    }

    Ok(())
}

fn remove_entry(entry: &fs::DirEntry) -> io::Result<()> {
    let entry_path = entry.path();
    if entry.file_type()?.is_dir() {
        fs::remove_dir_all(entry_path)
    } else {
        fs::remove_file(entry_path)
    }
}

enum RemoveOutcome {
    Removed,
    Missing,
}

fn remove_directory_tree(path: &Path) -> io::Result<RemoveOutcome> {
    let (parent, name) = match CleanupDirectory::open_parent(path) {
        Ok(parent) => parent,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(RemoveOutcome::Missing),
        Err(e) => return Err(e),
    };
    let anchored_path = parent.proc_path().join(name);

    match fs::remove_dir_all(anchored_path) {
        Ok(()) => Ok(RemoveOutcome::Removed),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(RemoveOutcome::Missing),
        Err(e) => Err(e),
    }
}

pub(crate) fn remove_partial_target(path: &Path) -> io::Result<()> {
    remove_directory_tree(path).map(|_| ())
}

/// Index path relationships once per cleanup pass, so lookups depend on path
/// depth rather than the number of unrelated preserved mounts.
struct PreservedPaths {
    paths: HashSet<PathBuf>,
    descendant_counts: HashMap<PathBuf, usize>,
}

impl PreservedPaths {
    fn new(preserved: &[String]) -> Self {
        let paths = preserved
            .iter()
            .map(|path| normalize_path(Path::new(path)))
            .collect::<HashSet<_>>();
        let mut descendant_counts = HashMap::new();

        for path in &paths {
            // The empty path is a prefix of absolute paths too, but their
            // ancestors() iterator stops at `/` without yielding it.
            let empty_prefix = path.is_absolute().then_some(Path::new(""));
            for ancestor in path.ancestors().skip(1).chain(empty_prefix) {
                *descendant_counts.entry(ancestor.to_path_buf()).or_insert(0) += 1;
            }
        }

        Self {
            paths,
            descendant_counts,
        }
    }

    fn is_preserved_or_descendant(&self, path: &Path) -> bool {
        self.paths.contains(Path::new(""))
            || path
                .ancestors()
                .any(|ancestor| self.paths.contains(ancestor))
    }

    fn count_preserved_children(&self, path: &Path) -> usize {
        self.descendant_counts.get(path).copied().unwrap_or(0)
    }

    fn entry_overlaps_preserved_path(&self, entry_path: &Path) -> bool {
        self.paths.contains(entry_path) || self.descendant_counts.contains_key(entry_path)
    }
}

struct CleanupMountPointDetector<L>
where
    L: Fn() -> io::Result<Vec<u8>>,
{
    load_mountinfo: L,
    mount_points: OnceCell<io::Result<MountSnapshot>>,
}

struct MountSnapshot {
    paths: HashSet<PathBuf>,
    #[cfg(target_os = "linux")]
    device_mounts: HashMap<(u32, u32), usize>,
}

impl MountSnapshot {
    fn parse(mountinfo: &[u8]) -> Self {
        let mut paths = HashSet::new();
        #[cfg(target_os = "linux")]
        let mut device_mounts = HashMap::new();
        for mount in linux_mountinfo::parse(mountinfo).filter_map(Result::ok) {
            paths.insert(PathBuf::from(OsString::from_vec(mount.target)));
            #[cfg(target_os = "linux")]
            {
                *device_mounts.entry(mount.device).or_insert(0) += 1;
            }
        }
        Self {
            paths,
            #[cfg(target_os = "linux")]
            device_mounts,
        }
    }
}

impl<L> CleanupMountPointDetector<L>
where
    L: Fn() -> io::Result<Vec<u8>>,
{
    fn new(load_mountinfo: L) -> Self {
        Self {
            load_mountinfo,
            mount_points: OnceCell::new(),
        }
    }

    fn is_mount_point(&self, path: &Path) -> io::Result<bool> {
        let path = absolute_path_without_following_final_symlink(path)?;
        Ok(self.mount_points()?.paths.contains(&path))
    }

    #[cfg(target_os = "linux")]
    fn can_quarantine(&self, path: &Path, device: u64) -> io::Result<bool> {
        let mounts = self.mount_points()?;
        let device = (libc::major(device), libc::minor(device));
        Ok(mounts.device_mounts.get(&device) == Some(&1)
            && !mounts.paths.iter().any(|mount| mount.starts_with(path)))
    }

    #[cfg(not(target_os = "linux"))]
    fn can_quarantine(&self, _path: &Path, _device: u64) -> io::Result<bool> {
        Ok(false)
    }

    fn mount_points(&self) -> io::Result<&MountSnapshot> {
        let load_mountinfo = &self.load_mountinfo;
        match self
            .mount_points
            .get_or_init(|| load_mountinfo().map(|mountinfo| MountSnapshot::parse(&mountinfo)))
        {
            Ok(mount_points) => Ok(mount_points),
            Err(e) => Err(io::Error::new(
                e.kind(),
                format!("failed to read /proc/self/mountinfo: {e}"),
            )),
        }
    }
}

fn cleanup_mountinfo() -> io::Result<Vec<u8>> {
    fs::read("/proc/self/mountinfo")
}

fn absolute_path_without_following_final_symlink(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(normalize_path(&absolute))
}

#[cfg(test)]
fn mount_points_from_mountinfo(mountinfo: &[u8]) -> HashSet<PathBuf> {
    MountSnapshot::parse(mountinfo).paths
}

#[cfg(test)]
mod tests;
