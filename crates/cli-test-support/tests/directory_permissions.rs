#![cfg(all(unix, feature = "test-support"))]

use cli_test_support::directory_permissions::DirectoryPermissions;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

fn mode(path: &Path) -> std::io::Result<u32> {
    Ok(fs::metadata(path)?.permissions().mode() & 0o7777)
}

#[test]
fn explicit_restore_preserves_original_mode_and_allows_tree_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let restricted = dir.path().join("restricted");
    fs::create_dir(&restricted).unwrap();
    fs::write(restricted.join("sentinel"), b"retained input").unwrap();
    fs::set_permissions(&restricted, fs::Permissions::from_mode(0o750)).unwrap();

    let permissions = DirectoryPermissions::set(&restricted, 0o555).unwrap();
    assert_eq!(mode(&restricted).unwrap(), 0o555);
    assert_eq!(
        fs::read(restricted.join("sentinel")).unwrap(),
        b"retained input"
    );
    permissions.restore().unwrap();

    assert_eq!(mode(&restricted).unwrap(), 0o750);
    let root = dir.path().to_path_buf();
    dir.close().unwrap();
    assert!(!root.exists());
}

#[test]
fn unwind_restores_unreadable_directory_before_temporary_tree_teardown() {
    let dir = tempfile::tempdir().unwrap();
    let restricted = dir.path().join("restricted");
    fs::create_dir(&restricted).unwrap();
    fs::write(restricted.join("sentinel"), b"retained input").unwrap();
    fs::set_permissions(&restricted, fs::Permissions::from_mode(0o751)).unwrap();

    let result = std::panic::catch_unwind(|| {
        let _permissions = DirectoryPermissions::set(&restricted, 0o000).unwrap();
        assert_eq!(mode(&restricted).unwrap(), 0o000);
        panic!("fixture assertion failed while access was revoked");
    });

    assert!(result.is_err());
    assert_eq!(mode(&restricted).unwrap(), 0o751);
    assert_eq!(
        fs::read(restricted.join("sentinel")).unwrap(),
        b"retained input"
    );
    let root = dir.path().to_path_buf();
    dir.close().unwrap();
    assert!(!root.exists());
}

#[test]
fn restore_keeps_directory_identity_when_path_is_replaced_by_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let restricted = dir.path().join("restricted");
    let renamed = dir.path().join("renamed");
    fs::create_dir(&restricted).unwrap();
    fs::write(restricted.join("sentinel"), b"original directory").unwrap();
    fs::write(outside.path().join("sentinel"), b"outside directory").unwrap();
    fs::set_permissions(&restricted, fs::Permissions::from_mode(0o751)).unwrap();
    fs::set_permissions(outside.path(), fs::Permissions::from_mode(0o750)).unwrap();

    let permissions = DirectoryPermissions::set(&restricted, 0o000).unwrap();
    fs::rename(&restricted, &renamed).unwrap();
    symlink(outside.path(), &restricted).unwrap();
    permissions.restore().unwrap();

    assert_eq!(mode(&renamed).unwrap(), 0o751);
    assert_eq!(mode(outside.path()).unwrap(), 0o750);
    assert_eq!(
        fs::read(renamed.join("sentinel")).unwrap(),
        b"original directory"
    );
    assert_eq!(
        fs::read(restricted.join("sentinel")).unwrap(),
        b"outside directory"
    );
    dir.close().unwrap();
    assert_eq!(
        fs::read(outside.path().join("sentinel")).unwrap(),
        b"outside directory"
    );
    outside.close().unwrap();
}

#[test]
fn acquisition_rejects_files_and_directory_symlinks_without_changing_them() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    let file = dir.path().join("file");
    fs::create_dir(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o750)).unwrap();
    fs::write(&file, b"retained file").unwrap();
    let file_mode = mode(&file).unwrap();
    symlink(&target, &link).unwrap();

    assert!(DirectoryPermissions::set(&link, 0o000).is_err());
    assert!(DirectoryPermissions::set(&file, 0o000).is_err());
    assert_eq!(mode(&target).unwrap(), 0o750);
    assert_eq!(mode(&file).unwrap(), file_mode);
    assert_eq!(fs::read(&file).unwrap(), b"retained file");
    dir.close().unwrap();
}
