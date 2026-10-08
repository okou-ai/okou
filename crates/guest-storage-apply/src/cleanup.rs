use crate::LOG_TAG;
use crate::path::normalize_path;
use guest_telemetry::{log_info, log_warn};
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

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
pub(crate) fn cleanup_stale_paths(cleanup_paths: &[String], preserved: &[String]) -> bool {
    cleanup_stale_paths_with_mountinfo_loader(cleanup_paths, preserved, cleanup_mountinfo)
}

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
        |path| detector.is_mount_point(path),
        remove_entry,
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
        |path| Ok(is_mount_point(path)),
        remove_entry,
    )
}

fn cleanup_stale_paths_with_options<M, R>(
    cleanup_paths: &[String],
    preserved: &[String],
    is_mount_point: M,
    remove_entry: R,
) -> bool
where
    M: Fn(&Path) -> io::Result<bool>,
    R: Fn(&fs::DirEntry) -> io::Result<()>,
{
    let preserved = PreservedPaths::new(preserved);
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

        let clean_contents = if preserved_child_count > 0 {
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
            } else {
                log_info!(
                    LOG_TAG,
                    "Cleaned mountpoint contents: {}",
                    path.original.display()
                );
            }
        } else {
            match remove_directory_tree(path.original) {
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

struct CleanupDirectory(File);

impl CleanupDirectory {
    fn open(path: &Path) -> io::Result<Self> {
        let anchor = if path.is_absolute() {
            Path::new("/")
        } else {
            Path::new(".")
        };
        let mut current = Self::open_anchor(anchor)?;

        for component in path.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::ParentDir => {
                    current = current.open_child(OsStr::new(".."))?;
                }
                Component::Normal(name) => {
                    current = current.open_child(name)?;
                }
                Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "cleanup path contains an unsupported prefix",
                    ));
                }
            }
        }

        Ok(current)
    }

    fn open_parent(path: &Path) -> io::Result<(Self, OsString)> {
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "cleanup path has no removable basename",
            )
        })?;
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        Ok((Self::open(parent)?, name.to_os_string()))
    }

    fn open_anchor(path: &Path) -> io::Result<Self> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map(Self)
    }

    fn open_child(&self, name: &OsStr) -> io::Result<Self> {
        let bytes = name.as_bytes();
        if bytes.is_empty() || bytes.contains(&b'/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cleanup path component must be a non-empty basename",
            ));
        }
        let name =
            CString::new(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: the parent fd is owned by this live `CleanupDirectory`,
        // `name` is a validated NUL-terminated basename, and these flags do
        // not require a mode argument.
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful `openat` returns a new owned file descriptor.
        Ok(Self(unsafe { File::from_raw_fd(fd) }))
    }

    fn read_dir(&self) -> io::Result<fs::ReadDir> {
        fs::read_dir(self.proc_path())
    }

    fn proc_path(&self) -> PathBuf {
        PathBuf::from("/proc/self/fd").join(self.0.as_raw_fd().to_string())
    }
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
    mount_points: OnceCell<io::Result<HashSet<PathBuf>>>,
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
        Ok(self.mount_points()?.contains(&path))
    }

    fn mount_points(&self) -> io::Result<&HashSet<PathBuf>> {
        let load_mountinfo = &self.load_mountinfo;
        match self.mount_points.get_or_init(|| {
            load_mountinfo().map(|mountinfo| mount_points_from_mountinfo(&mountinfo))
        }) {
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

fn mount_points_from_mountinfo(mountinfo: &[u8]) -> HashSet<PathBuf> {
    linux_mountinfo::parse(mountinfo)
        .filter_map(Result::ok)
        .map(|mount| PathBuf::from(OsString::from_vec(mount.target)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::ffi::OsStr;

    fn disable_system_log() {
        guest_telemetry::log::clear_system_log_file();
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn mountinfo_line(path: &Path) -> String {
        format!(
            "36 25 0:32 / {} rw,relatime - ext4 /dev/vdb rw\n",
            path.display()
        )
    }

    #[test]
    fn cleanup_removes_path_without_preserved_children() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mount");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("stale.txt"), "old").unwrap();

        cleanup_stale_paths(&[path_string(&path)], &[]);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_preserves_unchanged_children() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("claude");
        let child = parent.join("skills").join("foo");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("CLAUDE.md"), "old instructions").unwrap();
        fs::write(child.join("skill.md"), "keep me").unwrap();

        let parent_str = path_string(&parent);
        let child_str = path_string(&child);

        cleanup_stale_paths(&[parent_str], &[child_str]);

        // Parent dir still exists (not fully removed)
        assert!(parent.exists());
        // Child preserved
        assert!(child.join("skill.md").exists());
        // Stale file at parent level removed
        assert!(!parent.join("CLAUDE.md").exists());
    }

    #[test]
    fn cleanup_preserves_unicode_mountpoints_without_preserving_their_prefixes() {
        disable_system_log();
        for whitespace in ['\u{a0}', '\u{85}', '\u{2003}', '\u{2028}'] {
            for root in ["/".to_owned(), format!("/root{whitespace}dir")] {
                let dir = tempfile::tempdir().unwrap();
                let mountpoint = dir.path().join(format!("a{whitespace}b"));
                let prefix = dir.path().join("a");
                fs::create_dir(&mountpoint).unwrap();
                fs::create_dir(&prefix).unwrap();
                fs::write(mountpoint.join("stale.txt"), "old").unwrap();
                fs::write(prefix.join("stale.txt"), "old").unwrap();
                let mut mountinfo = format!(
                    "36 25 0:32 {root} {} rw - ext4 /dev/vdb rw\n",
                    mountpoint.display(),
                )
                .into_bytes();
                mountinfo.extend_from_slice(
                    b"malformed\n37 25 0:33 / /other/\xff rw - ext4 /dev/vdc rw\n",
                );

                cleanup_stale_paths_with_mountinfo_loader(
                    &[path_string(&mountpoint), path_string(&prefix)],
                    &[],
                    || Ok(mountinfo.clone()),
                );

                assert!(mountpoint.is_dir());
                assert!(!mountpoint.join("stale.txt").exists());
                assert!(!prefix.exists());
            }
        }
    }

    #[test]
    fn cleanup_mountinfo_detector_loads_mountinfo_once_for_multiple_paths() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("stale.txt"), "old").unwrap();
        fs::write(second.join("stale.txt"), "old").unwrap();

        let mountinfo = format!("{}{}", mountinfo_line(&first), mountinfo_line(&second));
        let load_count = Cell::new(0);

        cleanup_stale_paths_with_mountinfo_loader(
            &[path_string(&first), path_string(&second)],
            &[],
            || {
                load_count.set(load_count.get() + 1);
                Ok(mountinfo.as_bytes().to_vec())
            },
        );

        assert_eq!(load_count.get(), 1);
        assert!(first.exists());
        assert!(second.exists());
        assert!(!first.join("stale.txt").exists());
        assert!(!second.join("stale.txt").exists());
    }

    #[test]
    fn cleanup_preserved_children_do_not_load_mountinfo() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let child = parent.join("cache");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("stale.txt"), "old").unwrap();
        fs::write(child.join("keep.txt"), "keep").unwrap();
        let load_count = Cell::new(0);

        cleanup_stale_paths_with_mountinfo_loader(
            &[path_string(&parent)],
            &[path_string(&child)],
            || {
                load_count.set(load_count.get() + 1);
                Ok(Vec::new())
            },
        );

        assert_eq!(load_count.get(), 0);
        assert!(parent.exists());
        assert!(child.join("keep.txt").exists());
        assert!(!parent.join("stale.txt").exists());
    }

    #[test]
    fn cleanup_mountinfo_read_failure_stops_before_removing_paths() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let load_count = Cell::new(0);

        let success = cleanup_stale_paths_with_mountinfo_loader(
            &[path_string(&first), path_string(&second)],
            &[],
            || {
                load_count.set(load_count.get() + 1);
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "mountinfo unavailable",
                ))
            },
        );

        assert_eq!(load_count.get(), 1);
        assert!(!success);
        assert!(first.exists());
        assert!(second.exists());
    }

    #[test]
    fn cleanup_does_not_treat_preserved_sibling_prefix_as_child() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let cleanup_path = parent.join("cache");
        let preserved_sibling = parent.join("cache-old");
        fs::create_dir_all(&cleanup_path).unwrap();
        fs::create_dir_all(&preserved_sibling).unwrap();
        fs::write(cleanup_path.join("stale.txt"), "old").unwrap();
        fs::write(preserved_sibling.join("keep.txt"), "keep").unwrap();

        cleanup_stale_paths_with_mount_detector(
            &[path_string(&cleanup_path)],
            &[path_string(&preserved_sibling)],
            |_| false,
        );

        assert!(!cleanup_path.exists());
        assert!(preserved_sibling.join("keep.txt").exists());
    }

    #[test]
    fn cleanup_does_not_treat_entry_sibling_prefix_as_preserved() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let stale_sibling = parent.join("cache");
        let preserved_child = parent.join("cache-old");
        fs::create_dir_all(&stale_sibling).unwrap();
        fs::create_dir_all(&preserved_child).unwrap();
        fs::write(stale_sibling.join("stale.txt"), "old").unwrap();
        fs::write(preserved_child.join("keep.txt"), "keep").unwrap();

        cleanup_stale_paths(&[path_string(&parent)], &[path_string(&preserved_child)]);

        assert!(parent.exists());
        assert!(!stale_sibling.exists());
        assert!(preserved_child.join("keep.txt").exists());
    }

    #[test]
    fn cleanup_handles_nonexistent_path() {
        disable_system_log();
        // Should not panic
        cleanup_stale_paths(&["/nonexistent/path/12345".into()], &[]);
    }

    #[test]
    fn cleanup_mountpoint_removes_contents_but_keeps_root() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        let alias = dir.path().join("alias");
        let cleanup_path = alias.join("..").join("workspace");
        fs::create_dir_all(&alias).unwrap();
        fs::create_dir_all(path.join("old-dir")).unwrap();
        fs::write(path.join("old-dir").join("nested.txt"), "old").unwrap();
        fs::write(path.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_mount_detector(&[path_string(&cleanup_path)], &[], |candidate| {
            candidate == path
        });

        assert!(path.exists());
        assert!(!path.join("agent.txt").exists());
        assert!(!path.join("old-dir").exists());
    }

    #[test]
    fn cleanup_mountpoint_continues_after_protected_root_entry() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        let metadata_dir = path.join("lost+found");
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(path.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_options(
            &[path_string(&path)],
            &[],
            |candidate| Ok(candidate == path),
            |entry| {
                if entry.file_name() == OsStr::new("lost+found") {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "protected filesystem metadata",
                    ))
                } else {
                    remove_entry(entry)
                }
            },
        );

        assert!(path.exists());
        assert!(metadata_dir.exists());
        assert!(!path.join("agent.txt").exists());
    }

    #[test]
    fn cleanup_does_not_globally_skip_lost_found() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        fs::create_dir_all(path.join("lost+found")).unwrap();
        fs::create_dir_all(path.join("stale").join("lost+found")).unwrap();

        cleanup_stale_paths_with_mount_detector(&[path_string(&path)], &[], |candidate| {
            candidate == path
        });

        assert!(path.exists());
        assert!(!path.join("lost+found").exists());
        assert!(!path.join("stale").exists());
    }

    #[test]
    fn cleanup_non_mount_lost_found_is_removed_with_parent() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        fs::create_dir_all(path.join("lost+found")).unwrap();
        fs::create_dir_all(path.join("stale").join("lost+found")).unwrap();

        cleanup_stale_paths_with_mount_detector(&[path_string(&path)], &[], |_| false);

        assert!(!path.exists());
    }

    #[test]
    fn cleanup_mountpoint_preserves_cached_child() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        let child = path.join("cache");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("keep.txt"), "keep").unwrap();
        fs::write(path.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_mount_detector(
            &[path_string(&path)],
            &[path_string(&child)],
            |candidate| candidate == path,
        );

        assert!(path.exists());
        assert!(child.join("keep.txt").exists());
        assert!(!path.join("agent.txt").exists());
    }

    #[test]
    fn cleanup_parent_before_child_ordering_with_mountpoint_root() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let child = parent.join("child");
        let alias = dir.path().join("alias");
        let parent_cleanup = alias.join("..").join("workspace");
        let observed = RefCell::new(Vec::new());
        fs::create_dir_all(&alias).unwrap();
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("stale.txt"), "old").unwrap();
        fs::write(parent.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_mount_detector(
            &[path_string(&child), path_string(&parent_cleanup)],
            &[],
            |candidate| {
                observed.borrow_mut().push(candidate.to_path_buf());
                candidate == parent
            },
        );

        assert_eq!(*observed.borrow(), [parent.clone(), child.clone()]);
        assert!(parent.exists());
        assert!(!parent.join("agent.txt").exists());
        assert!(!child.exists());
    }

    #[test]
    fn mountinfo_contains_exact_mount_point() {
        let mountinfo = b"\
36 25 0:32 / /home/user/workspace rw,relatime - ext4 /dev/vdb rw
37 25 0:33 / /home/user rw,relatime - ext4 /dev/root rw
";

        assert!(mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace")));
    }

    #[test]
    fn mountinfo_does_not_match_mount_point_prefix() {
        let mountinfo = b"\
36 25 0:32 / /home/user/workspace-old rw,relatime - ext4 /dev/vdb rw
37 25 0:33 / /home/user rw,relatime - ext4 /dev/root rw
";

        assert!(
            !mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace"))
        );
    }

    #[test]
    fn mountinfo_decodes_escaped_mount_point_path() {
        let mountinfo = br"36 25 0:32 / /home/user/work\040space rw,relatime - ext4 /dev/vdb rw";

        assert!(
            mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/work space"))
        );
    }

    #[test]
    fn mountinfo_returns_false_for_non_mount_path() {
        let mountinfo = b"36 25 0:32 / /home/user rw,relatime - ext4 /dev/root rw";

        assert!(
            !mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace"))
        );
    }
}
