use super::*;
use std::os::unix::fs::symlink;

fn ids() -> (u32, u32) {
    // SAFETY: scalar identity getters have no preconditions.
    unsafe { (libc::geteuid(), libc::getegid()) }
}

#[test]
fn account_authority_must_match_home_and_nonroot_primary_group() {
    validate_account(Path::new(HOME_DIR), 1234, 2345, 2345).unwrap();
    for (home, uid, primary, group) in [
        ("/home/other", 1234, 2345, 2345),
        (HOME_DIR, 0, 2345, 2345),
        (HOME_DIR, 1234, 0, 0),
        (HOME_DIR, 1234, 2345, 3456),
    ] {
        assert_eq!(
            validate_account(Path::new(home), uid, primary, group)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[test]
fn fresh_home_initializes_owned_cwd_and_only_public_defaults() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("lost+found")).unwrap();
    let home = open_directory(dir.path()).unwrap();
    let (uid, gid) = ids();
    initialize_home(dir.path(), &home, uid, gid).unwrap();
    validate_owner(&open_child_directory(&home, "workspace").unwrap(), uid, gid).unwrap();
    for (name, bytes) in HOME_DEFAULTS {
        assert_eq!(fs::read(dir.path().join(name)).unwrap(), bytes);
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 5);
}

#[test]
fn used_home_and_repeated_calls_preserve_files_and_create_missing_cwd_only() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".bashrc"), b"user customization").unwrap();
    fs::write(dir.path().join("ordinary"), b"ordinary bytes").unwrap();
    let home = open_directory(dir.path()).unwrap();
    let (uid, gid) = ids();
    for _ in 0..2 {
        initialize_home(dir.path(), &home, uid, gid).unwrap();
    }
    assert_eq!(
        fs::read(dir.path().join(".bashrc")).unwrap(),
        b"user customization"
    );
    assert_eq!(
        fs::read(dir.path().join("ordinary")).unwrap(),
        b"ordinary bytes"
    );
    assert!(!dir.path().join(".profile").exists());
    fs::write(dir.path().join("workspace/file"), b"cwd bytes").unwrap();
    initialize_home(dir.path(), &home, uid, gid).unwrap();
    assert_eq!(
        fs::read(dir.path().join("workspace/file")).unwrap(),
        b"cwd bytes"
    );
}

#[test]
fn ownership_validation_uses_observed_ids_and_does_not_repair_hit_contents() {
    let dir = tempfile::tempdir().unwrap();
    let home = open_directory(dir.path()).unwrap();
    let (uid, gid) = ids();
    fs::write(dir.path().join("ordinary"), b"retained").unwrap();
    validate_owner(&home, uid, gid).unwrap();
    assert_eq!(
        validate_owner(&home, uid.wrapping_add(1), gid)
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        validate_owner(&home, uid, gid.wrapping_add(1))
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(fs::read(dir.path().join("ordinary")).unwrap(), b"retained");
}

#[test]
fn directory_traversal_and_cwd_reject_symlinks_and_non_directories() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    symlink(other.path(), dir.path().join("link")).unwrap();
    assert!(open_directory(&dir.path().join("link/nested")).is_err());
    let home = open_directory(dir.path()).unwrap();
    symlink(other.path(), dir.path().join("workspace")).unwrap();
    let (uid, gid) = ids();
    assert!(initialize_home(dir.path(), &home, uid, gid).is_err());
    assert_eq!(fs::read_dir(other.path()).unwrap().count(), 0);
    fs::remove_file(dir.path().join("workspace")).unwrap();
    fs::write(dir.path().join("workspace"), b"not a directory").unwrap();
    assert!(initialize_home(dir.path(), &home, uid, gid).is_err());
}

#[test]
fn non_block_device_cannot_mount_or_initialize_a_home() {
    let dir = tempfile::tempdir().unwrap();
    let device = dir.path().join("device");
    fs::write(&device, b"not a block device").unwrap();
    let (uid, gid) = ids();
    assert_eq!(
        mount_at(
            &dir.path().join("home"),
            &device,
            Path::new(MOUNTINFO_PATH),
            uid,
            gid
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::InvalidData
    );
    assert!(!dir.path().join("home").exists());
}

#[test]
fn visible_mount_observation_uses_current_kernel_identity_not_containing_path() {
    let dir = tempfile::tempdir().unwrap();
    let mounts = parse_mountinfo(&fs::read(MOUNTINFO_PATH).unwrap()).unwrap();
    let (mount, device) = visible_mount(dir.path(), &mounts).unwrap().unwrap();
    assert_eq!(mount.device, device);
    assert_ne!(mount.target, dir.path().as_os_str().as_bytes());
    assert!(visible_mount(dir.path(), &[]).is_err());
    validate_mount_device(device, device, device).unwrap();
    assert!(validate_mount_device(device, device, (u32::MAX, u32::MAX)).is_err());
    assert!(validate_mount_device(device, (u32::MAX, u32::MAX), device).is_err());
}

#[test]
fn home_mount_rejects_same_device_subtree_before_namespace_initialization() {
    let full = parse_mountinfo(b"42 25 253:17 / /home/user rw - ext4 /dev/vdb rw").unwrap();
    validate_home_mount(full.first().unwrap(), (253, 17), (253, 17)).unwrap();
    for root in [b"/bind-source".as_slice(), b"/space\\040subtree"] {
        let mut record = b"43 42 253:17 ".to_vec();
        record.extend_from_slice(root);
        record.extend_from_slice(b" /home/user rw - ext4 /dev/vdb rw");
        let subtree = parse_mountinfo(&record).unwrap();
        assert_eq!(
            validate_home_mount(subtree.first().unwrap(), (253, 17), (253, 17))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[test]
fn home_mountinfo_preserves_mount_identity_and_target_bytes() {
    let mounts = parse_mountinfo(
        b"42 25 253:17 /root/\xff /home/us\\040er\xfe rw shared:7 - ext4 /dev/vdb rw",
    )
    .unwrap();
    assert_eq!(mounts[0].id, 42);
    assert_eq!(mounts[0].device, (253, 17));
    assert_eq!(mounts[0].target, b"/home/us er\xfe");
}

#[test]
fn home_mountinfo_rejects_empty_tables_and_any_malformed_record() {
    for input in [
        b"".as_slice(),
        b"\n\n",
        b"malformed\n42 25 0:32 / /home/user rw - ext4 /dev/vdb rw",
        b"42 25 0:32 / /home/user rw - ext4 /dev/vdb rw\nmalformed",
        br"42 25 0:32 / /home/us\041er rw - ext4 /dev/vdb rw",
    ] {
        assert_eq!(
            parse_mountinfo(input).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
