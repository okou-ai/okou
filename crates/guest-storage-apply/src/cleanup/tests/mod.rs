use super::*;

fn cleanup_stale_paths(paths: &[String], preserved: &[String]) -> bool {
    super::cleanup_stale_paths(paths, preserved, &[])
}
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
            mountinfo
                .extend_from_slice(b"malformed\n37 25 0:33 / /other/\xff rw - ext4 /dev/vdc rw\n");

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

    assert!(!mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace")));
}

#[test]
fn mountinfo_decodes_escaped_mount_point_path() {
    let mountinfo = br"36 25 0:32 / /home/user/work\040space rw,relatime - ext4 /dev/vdb rw";

    assert!(mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/work space")));
}

#[test]
fn mountinfo_returns_false_for_non_mount_path() {
    let mountinfo = b"36 25 0:32 / /home/user rw,relatime - ext4 /dev/root rw";

    assert!(!mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace")));
}
