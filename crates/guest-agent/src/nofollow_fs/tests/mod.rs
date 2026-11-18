use super::*;
use std::os::unix::fs::symlink;

#[test]
fn cooperative_stop_inside_a_subtree_preserves_partial_progress() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("one"), "one").unwrap();
    fs::write(nested.join("two"), "two").unwrap();
    let root = Dir::open(dir.path()).unwrap();

    let outcome =
        root.remove_children_except_while(&[], root.identity().unwrap(), &[], &mut || {
            Ok(fs::read_dir(&nested)?.count() == 2)
        });

    assert!(outcome.error.is_none());
    assert_eq!(outcome.removed_entries, 0);
    assert_eq!(fs::read_dir(&nested).unwrap().count(), 1);
    assert!(nested.is_dir());
}

#[test]
fn cooperative_removal_keeps_counts_when_a_later_probe_fails() {
    let dir = tempfile::tempdir().unwrap();
    let leaf = dir.path().join("payload");
    fs::write(&leaf, "discard").unwrap();
    let root = Dir::open(dir.path()).unwrap();

    let outcome =
        root.remove_children_except_while(&[], root.identity().unwrap(), &[], &mut || {
            if leaf.exists() {
                Ok(true)
            } else {
                Err(io::Error::other("capacity probe unavailable"))
            }
        });

    assert!(outcome.error.is_some());
    assert_eq!(outcome.removed_entries, 1);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn cooperative_stop_before_work_retains_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let leaf = dir.path().join("payload");
    fs::write(&leaf, "keep").unwrap();
    let root = Dir::open(dir.path()).unwrap();
    let outcome =
        root.remove_children_except_while(&[], root.identity().unwrap(), &[], &mut || Ok(false));
    assert!(outcome.error.is_none());
    assert_eq!(outcome.removed_entries, 0);
    assert_eq!(fs::read(&leaf).unwrap(), b"keep");
}

#[test]
fn open_rejects_symlinked_root() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    symlink(&real, &link).unwrap();

    assert!(Dir::open(&link).is_err());
}

#[test]
fn open_child_dir_rejects_symlinked_child() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    let outside = dir.path().join("outside");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&outside, root_path.join("linked")).unwrap();

    let root = Dir::open(&root_path).unwrap();

    assert!(root.open_child_dir(OsStr::new("linked")).is_err());
}

#[test]
fn open_child_file_rejects_symlinked_child() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    let outside = dir.path().join("outside.txt");
    fs::create_dir(&root_path).unwrap();
    fs::write(&outside, "outside").unwrap();
    symlink(&outside, root_path.join("linked.txt")).unwrap();

    let root = Dir::open(&root_path).unwrap();

    assert!(root.open_child_file(OsStr::new("linked.txt")).is_err());
}

#[test]
fn open_child_rejects_nul_name() {
    let dir = tempfile::tempdir().unwrap();
    let root = Dir::open(dir.path()).unwrap();

    let err = root
        .open_child_file(OsStr::from_bytes(b"bad\0name"))
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn open_child_rejects_invalid_child_names() {
    let dir = tempfile::tempdir().unwrap();
    let root = Dir::open(dir.path()).unwrap();

    for name in [b"".as_slice(), b".", b"..", b"nested/file"] {
        let err = root.open_child_file(OsStr::from_bytes(name)).unwrap_err();

        assert_eq!(
            err.kind(),
            io::ErrorKind::InvalidInput,
            "name {name:?} should be rejected"
        );
    }
}
