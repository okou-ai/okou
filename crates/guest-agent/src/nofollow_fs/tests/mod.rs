use super::*;
use std::io::Read;
use std::os::unix::fs::symlink;
use std::time::{Duration, UNIX_EPOCH};

#[test]
fn proof_reads_preserve_file_and_directory_access_times() {
    let tree = tempfile::tempdir().unwrap();
    let leaf = tree.path().join("note.md");
    fs::write(&leaf, b"memory").unwrap();
    let accessed = UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    let times = fs::FileTimes::new().set_accessed(accessed);
    for path in [tree.path(), leaf.as_path()] {
        File::open(path).unwrap().set_times(times).unwrap();
    }

    let dir = Dir::open(tree.path()).unwrap();
    let mut buffer = [MaybeUninit::<u8>::uninit(); 1024];
    let mut entries = dir.read_dir_noatime(&mut buffer).unwrap();
    let mut found_leaf = false;
    while let Some(entry) = entries.next() {
        if entry.unwrap().file_name() == c"note.md" {
            found_leaf = true;
            break;
        }
    }
    assert!(found_leaf);
    let mut content = Vec::new();
    dir.open_child_file_noatime(OsStr::new("note.md"))
        .unwrap()
        .read_to_end(&mut content)
        .unwrap();
    assert_eq!(content, b"memory");
    for path in [tree.path(), leaf.as_path()] {
        assert_eq!(fs::metadata(path).unwrap().accessed().unwrap(), accessed);
    }
}

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
