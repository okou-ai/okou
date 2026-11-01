use super::*;
use std::os::unix::fs::symlink;

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
