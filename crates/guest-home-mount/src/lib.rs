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
mod tests;
