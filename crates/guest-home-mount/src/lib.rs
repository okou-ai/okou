//! Fixed home mounting and bounded initialization without shell launches.
//!
//! The caller owns the mount tool's process group through timeout/disconnect.
//! Every invocation observes the current visible mount; PID 1 or a snapshot's
//! earlier mount is never sufficient authority for a later job.

use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use guest_contracts::home_mount::{HOME_DEVICE, HOME_DIR};
use nix::unistd::{Group, User};
use rustix::fs::{AtFlags, CWD, StatxFlags, statx};

const MOUNTINFO_PATH: &str = "/proc/self/mountinfo";
// Only these public defaults may be created. No used rootfs home, framework
// tree, credentials, environment, instructions or history is copied into home.
const HOME_DEFAULTS: [(&str, &[u8]); 3] = [
    (".bashrc", b"# Public initial interactive shell defaults.\ncase $- in *i*) ;; *) return;; esac\nexport PATH=\"$PATH:$HOME/go/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/bin\"\n"),
    (".profile", b"# Public initial login shell defaults.\nif [ -n \"$BASH_VERSION\" ] && [ -f \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\"; fi\n"),
    (".bash_logout", b"# Public initial logout defaults.\n"),
];

/// Mount `/dev/vdb` at `/home/user` and validate/initialize the unchanged cwd.
///
/// IDs and the home path must match the rootfs account authority; no guessed
/// UID/GID is used. Existing ordinary home files are never overwritten.
pub fn mount_home_drive() -> io::Result<()> {
    let user = User::from_name("user")?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home user unavailable"))?;
    let group = Group::from_name("user")?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home group unavailable"))?;
    validate_account(
        &user.dir,
        user.uid.as_raw(),
        user.gid.as_raw(),
        group.gid.as_raw(),
    )?;
    mount_at(
        Path::new(HOME_DIR),
        Path::new(HOME_DEVICE),
        Path::new(MOUNTINFO_PATH),
        user.uid.as_raw(),
        group.gid.as_raw(),
    )
}

fn validate_account(home: &Path, uid: u32, primary_gid: u32, gid: u32) -> io::Result<()> {
    if home != Path::new(HOME_DIR) || uid == 0 || gid == 0 || primary_gid != gid {
        return Err(invalid(
            "home account identity does not match the fixed layout",
        ));
    }
    Ok(())
}

fn mount_at(
    directory: &Path,
    device: &Path,
    mountinfo: &Path,
    uid: u32,
    gid: u32,
) -> io::Result<()> {
    reject_symlink_components(directory)?;
    reject_symlink_components(device)?;
    let device_metadata = fs::symlink_metadata(device)?;
    if !device_metadata.file_type().is_block_device() {
        return Err(invalid("home device is not a block device"));
    }
    let expected_device = (
        libc::major(device_metadata.rdev()),
        libc::minor(device_metadata.rdev()),
    );
    let mounts = parse_mountinfo(&fs::read(mountinfo)?)?;
    let mounted = match visible_mount(directory, &mounts)? {
        Some((mount, target_device)) if mount.target == directory.as_os_str().as_bytes() => {
            validate_home_mount(mount, target_device, expected_device)?;
            true
        }
        _ => false,
    };
    if !mounted {
        if mounts.iter().any(|mount| mount.device == expected_device) {
            return Err(invalid("home device is already mounted elsewhere"));
        }
        fs::create_dir_all(directory)?;
        reject_symlink_components(directory)?;
        let status = Command::new("/usr/bin/mount")
            .args(["-t", "ext4", "--"])
            .arg(device)
            .arg(directory)
            .status()?;
        if !status.success() {
            return Err(io::Error::other(format!(
                "ext4 home mount failed: {status}"
            )));
        }
    }
    // Observe the actual post-mount view, including on repeated calls and
    // restored snapshots. Successful utility exit alone is not mount proof.
    let mounts = parse_mountinfo(&fs::read(mountinfo)?)?;
    let (mount, target_device) = visible_mount(directory, &mounts)?
        .ok_or_else(|| invalid("home mount identity unavailable after mount"))?;
    if mount.target != directory.as_os_str().as_bytes() {
        return Err(invalid("home path is not the visible mountpoint"));
    }
    validate_home_mount(mount, target_device, expected_device)?;
    let home = open_directory(directory)?;
    let pinned = statx(&home, "", AtFlags::EMPTY_PATH, StatxFlags::MNT_ID)?;
    if pinned.stx_mask & StatxFlags::MNT_ID.bits() == 0 || pinned.stx_mnt_id != mount.id {
        return Err(invalid("home mount changed before initialization"));
    }
    repair_owner(&home, uid, gid)?;
    initialize_home(directory, &home, uid, gid)?;
    // Initialization must not cross an unrelated bind/stacked cwd mount.
    let cwd = open_child_directory(&home, "workspace")?;
    let cwd_mount = statx(&cwd, "", AtFlags::EMPTY_PATH, StatxFlags::MNT_ID)?;
    if cwd_mount.stx_mask & StatxFlags::MNT_ID.bits() == 0 || cwd_mount.stx_mnt_id != mount.id {
        return Err(invalid("execution cwd is outside the home mount"));
    }
    let current = statx(
        CWD,
        directory,
        AtFlags::SYMLINK_NOFOLLOW | AtFlags::NO_AUTOMOUNT,
        StatxFlags::MNT_ID,
    )?;
    if current.stx_mnt_id != mount.id {
        return Err(invalid("home mount changed during initialization"));
    }
    Ok(())
}

fn visible_mount<'a>(
    directory: &Path,
    mounts: &'a [linux_mountinfo::Mount],
) -> io::Result<Option<(&'a linux_mountinfo::Mount, (u32, u32))>> {
    let target = match statx(
        CWD,
        directory,
        AtFlags::SYMLINK_NOFOLLOW | AtFlags::NO_AUTOMOUNT,
        StatxFlags::MNT_ID,
    ) {
        Ok(target) => target,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if target.stx_mask & StatxFlags::MNT_ID.bits() == 0 {
        return Err(invalid("home mount identity unavailable"));
    }
    let mount = mounts
        .iter()
        .find(|mount| mount.id == target.stx_mnt_id)
        .ok_or_else(|| invalid("visible home mount missing from mountinfo"))?;
    Ok(Some((mount, (target.stx_dev_major, target.stx_dev_minor))))
}

fn validate_home_mount(
    mount: &linux_mountinfo::Mount,
    target_device: (u32, u32),
    expected: (u32, u32),
) -> io::Result<()> {
    if mount.root != b"/" {
        return Err(invalid("home mount exposes only a filesystem subtree"));
    }
    validate_mount_device(mount.device, target_device, expected)
}

fn validate_mount_device(
    mount_device: (u32, u32),
    target_device: (u32, u32),
    expected: (u32, u32),
) -> io::Result<()> {
    if mount_device != expected || target_device != expected {
        return Err(invalid("refusing unrelated existing home mount"));
    }
    Ok(())
}

fn reject_symlink_components(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(invalid("home path must be absolute and normalized"));
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Normal(_) => current.push(component),
            _ => return Err(invalid("home path must be absolute and normalized")),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid("refusing symlink home path component"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn open_directory(path: &Path) -> io::Result<File> {
    // Component-wise descriptor traversal prevents a concurrent path exchange
    // from turning a prechecked parent into a followed symlink.
    reject_symlink_components(path)?;
    let mut directory = open_child_directory_fd(libc::AT_FDCWD, "/")?;
    for component in path.components() {
        if let Component::Normal(name) = component {
            directory = open_child_directory_fd(directory.as_raw_fd(), name.as_bytes())?;
        }
    }
    Ok(directory)
}

fn open_child_directory(parent: &File, name: &str) -> io::Result<File> {
    open_child_directory_fd(parent.as_raw_fd(), name)
}

fn open_child_directory_fd(parent: libc::c_int, name: impl AsRef<[u8]>) -> io::Result<File> {
    let name = CString::new(name.as_ref()).map_err(|_| invalid("home path contains NUL"))?;
    // SAFETY: name is NUL-terminated; the returned descriptor has one File owner.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn repair_owner(directory: &File, uid: u32, gid: u32) -> io::Result<()> {
    // SAFETY: directory owns a live descriptor; IDs are account-derived.
    if unsafe { libc::fchown(directory.as_raw_fd(), uid, gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    validate_owner(directory, uid, gid)
}

fn validate_owner(file: &File, uid: u32, gid: u32) -> io::Result<()> {
    let metadata = file.metadata()?;
    if metadata.uid() != uid || metadata.gid() != gid {
        return Err(invalid("home entry is not owned by the sandbox account"));
    }
    Ok(())
}

fn initialize_home(_path: &Path, home: &File, uid: u32, gid: u32) -> io::Result<()> {
    // Only an empty ext4 namespace (plus mkfs's lost+found) gets defaults.
    // Stop at the first ordinary entry: used homes are not scanned or copied.
    let mut pristine = true;
    // This proc path is generated from our live descriptor, not supplied by
    // the caller. Enumeration remains on the pinned mount if a path moves.
    for entry in fs::read_dir(format!("/proc/self/fd/{}", home.as_raw_fd()))? {
        if entry?.file_name() != "lost+found" {
            pristine = false;
            break;
        }
    }
    let cwd_name = CString::new("workspace").map_err(|_| invalid("invalid fixed cwd"))?;
    // SAFETY: home is live and cwd_name is a fixed NUL-terminated component.
    let result = unsafe { libc::mkdirat(home.as_raw_fd(), cwd_name.as_ptr(), 0o755) };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    let cwd = open_child_directory(home, "workspace")?;
    if result == 0 {
        repair_owner(&cwd, uid, gid)?;
    }
    // Do not recursively chown hit-owned ordinary files or repair a symlink.
    validate_owner(&cwd, uid, gid)?;
    if !pristine {
        return Ok(());
    }
    for (name, content) in HOME_DEFAULTS {
        let name = CString::new(name).map_err(|_| invalid("invalid public default name"))?;
        // SAFETY: the pinned home fd and fixed component cannot traverse a
        // parent; exclusive/no-follow creation never overwrites a hit's file.
        let fd = unsafe {
            libc::openat(
                home.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o644,
            )
        };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::AlreadyExists {
                continue;
            }
            return Err(error);
        }
        // SAFETY: openat returned a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        repair_owner(&file, uid, gid)?;
        file.write_all(content)?;
    }
    Ok(())
}

fn parse_mountinfo(input: &[u8]) -> io::Result<Vec<linux_mountinfo::Mount>> {
    let mounts = linux_mountinfo::parse(input).collect::<io::Result<Vec<_>>>()?;
    if mounts.is_empty() {
        return Err(invalid("home mountinfo is empty"));
    }
    Ok(mounts)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
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
}
