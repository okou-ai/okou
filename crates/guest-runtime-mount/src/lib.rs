//! Verify and mount the independently immutable runtime image before Guest services.
//!
//! PID 1 captures the boot image identity before admitting user code. Its forked
//! services inherit that expectation; reuse verifies the current immutable mount
//! against it, never against a marker on the now-writable workload filesystem.

use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use guest_contracts::runtime_drive::{RUNTIME_IDENTITY_PATH, RUNTIME_MOUNT_PATH};
use nix::mount::{MsFlags, mount};
use rustix::fs::{AtFlags, StatVfsMountFlags, StatxFlags, fstatfs, fstatvfs, statx};

const IDENTITY_BYTES: u64 = 65;
const EXT4_MAGIC: rustix::fs::FsWord = 0xef53;
static BOOT_RUNTIME: OnceLock<RuntimeMount> = OnceLock::new();

/// The observed placement of the optional home drive at boot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeLayout {
    /// Whether /dev/vdb remains the separate home device.
    pub home_attached: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct RuntimeDevice {
    path: PathBuf,
    number: (u32, u32),
    home_attached: bool,
}

struct RuntimeMount {
    device: RuntimeDevice,
    identity: String,
    mount_id: u64,
}

/// Establish the immutable runtime mount before PID 1 forks Guest services.
///
/// Missing, duplicate, writable, unpaired or mis-mounted runtime devices fail
/// boot. This does not establish mandatory process/caller isolation.
pub fn initialize() -> io::Result<RuntimeLayout> {
    if BOOT_RUNTIME.get().is_some() {
        return Err(invalid("runtime boot expectation is already initialized"));
    }
    let identity = read_identity(Path::new(RUNTIME_IDENTITY_PATH))?;
    let device = runtime_device()?;
    let target = Path::new(RUNTIME_MOUNT_PATH);
    create_mount_directory(target)?;
    if !runtime_mount_present()? {
        mount(
            Some(device.path.as_path()),
            target,
            Some("ext4"),
            MsFlags::MS_RDONLY | MsFlags::MS_NODEV | MsFlags::MS_NOSUID,
            None::<&str>,
        )
        .map_err(io::Error::other)?;
    }
    let mount_id = verify_mount(&device, &identity)?;
    let layout = RuntimeLayout {
        home_attached: device.home_attached,
    };
    BOOT_RUNTIME
        .set(RuntimeMount {
            device,
            identity,
            mount_id,
        })
        .map_err(|_| invalid("runtime boot expectation changed during initialization"))?;
    Ok(layout)
}

/// Revalidate the current runtime source and mount against trusted boot state.
///
/// Called at the existing fixed home-validation boundary after restore/reuse.
/// A missing expectation or a replaced source/mount is fatal to that operation.
pub fn verify() -> io::Result<()> {
    let expected = BOOT_RUNTIME
        .get()
        .ok_or_else(|| invalid("runtime boot expectation is unavailable"))?;
    let device = runtime_device()?;
    if device != expected.device {
        return Err(invalid("runtime device changed since boot"));
    }
    if verify_mount(&device, &expected.identity)? != expected.mount_id {
        return Err(invalid("runtime mount changed since boot"));
    }
    Ok(())
}

fn runtime_device() -> io::Result<RuntimeDevice> {
    let mut selected = None;
    // Rootfs is vda. Optional home precedes runtime, so only these two slots
    // are valid. Firecracker's drive_id is NOT its Guest serial; discover the
    // sole readonly non-root device, then verify the complete paired topology.
    let mut present = [false; 2];
    for (name, is_present) in ["vdb", "vdc"].into_iter().zip(present.iter_mut()) {
        let sys = Path::new("/sys/class/block").join(name);
        let readonly = match fs::read(sys.join("ro")) {
            Ok(readonly) => readonly,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        *is_present = true;
        if readonly == b"0\n" {
            continue;
        }
        if readonly != b"1\n" {
            return Err(invalid("runtime block readonly state is malformed"));
        }
        if selected.is_some() {
            return Err(invalid("multiple immutable runtime devices"));
        }
        let path = Path::new("/dev").join(name);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_block_device() {
            return Err(invalid("runtime source is not a block device"));
        }
        let number = (libc::major(metadata.rdev()), libc::minor(metadata.rdev()));
        if fs::read_to_string(sys.join("dev"))? != format!("{}:{}\n", number.0, number.1) {
            return Err(invalid(
                "runtime block device does not match its kernel identity",
            ));
        }
        let root = fs::metadata("/")?;
        if number == (libc::major(root.dev()), libc::minor(root.dev())) {
            return Err(invalid("runtime shares the writable rootfs device"));
        }
        selected = Some(RuntimeDevice {
            path,
            number,
            home_attached: name == "vdc",
        });
    }
    let selected =
        selected.ok_or_else(|| invalid("immutable runtime device is missing or writable"))?;
    let [home_present, third_present] = present;
    if (selected.home_attached && !home_present) || (!selected.home_attached && third_present) {
        return Err(invalid(
            "runtime device does not match the paired home layout",
        ));
    }
    Ok(selected)
}

fn create_mount_directory(target: &Path) -> io::Result<()> {
    reject_symlinks(Path::new("/run"))?;
    for path in [Path::new("/run/okou"), target] {
        match fs::DirBuilder::new().mode(0o755).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(invalid("runtime mount directory is not controller-owned"));
        }
    }
    Ok(())
}

fn mounts() -> io::Result<Vec<linux_mountinfo::Mount>> {
    let bytes = fs::read("/proc/self/mountinfo")?;
    let mounts = linux_mountinfo::parse(&bytes).collect::<io::Result<Vec<_>>>()?;
    if mounts.is_empty() {
        return Err(invalid("mount table is empty"));
    }
    Ok(mounts)
}

fn runtime_mount_present() -> io::Result<bool> {
    Ok(mounts()?
        .iter()
        .any(|mount| mount.target == RUNTIME_MOUNT_PATH.as_bytes()))
}

fn verify_mount(device: &RuntimeDevice, identity: &str) -> io::Result<u64> {
    let target = Path::new(RUNTIME_MOUNT_PATH);
    reject_symlinks(target)?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(target)?;
    let observed = statx(&directory, "", AtFlags::EMPTY_PATH, StatxFlags::MNT_ID)?;
    if observed.stx_mask & StatxFlags::MNT_ID.bits() == 0 {
        return Err(invalid("runtime mount identity is unavailable"));
    }
    let table = mounts()?;
    let matching = table
        .iter()
        .filter(|mount| mount.target == RUNTIME_MOUNT_PATH.as_bytes())
        .collect::<Vec<_>>();
    let [mount] = matching.as_slice() else {
        return Err(invalid("runtime mount is missing or ambiguous"));
    };
    if mount.id != observed.stx_mnt_id || mount.root != b"/" || mount.device != device.number {
        return Err(invalid(
            "runtime mount does not expose the expected complete image",
        ));
    }
    if fstatfs(&directory)?.f_type != EXT4_MAGIC
        || !fstatvfs(&directory)?
            .f_flag
            .contains(StatVfsMountFlags::RDONLY)
    {
        return Err(invalid("runtime filesystem is not read-only ext4"));
    }
    let marker = target.join(RUNTIME_IDENTITY_PATH.trim_start_matches('/'));
    if read_identity(&marker)? != identity {
        return Err(invalid(
            "runtime image does not match the boot build identity",
        ));
    }
    let current = statx(
        rustix::fs::CWD,
        target,
        AtFlags::SYMLINK_NOFOLLOW | AtFlags::NO_AUTOMOUNT,
        StatxFlags::MNT_ID,
    )?;
    if current.stx_mnt_id != mount.id {
        return Err(invalid("runtime mount changed during verification"));
    }
    Ok(mount.id)
}

fn read_identity(path: &Path) -> io::Result<String> {
    reject_symlinks(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("runtime build identity is not a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(IDENTITY_BYTES + 1).read_to_end(&mut bytes)?;
    decode_identity(&bytes)
}

fn decode_identity(bytes: &[u8]) -> io::Result<String> {
    let Some(digest) = bytes.strip_suffix(b"\n") else {
        return Err(invalid("runtime build identity is malformed"));
    };
    if digest.len() != 64
        || !digest
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(invalid("runtime build identity is malformed"));
    }
    std::str::from_utf8(digest)
        .map(str::to_owned)
        .map_err(|_| invalid("runtime build identity is malformed"))
}

fn reject_symlinks(path: &Path) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err(invalid("runtime path is not canonical"));
        }
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(invalid("runtime path contains a symlink"));
        }
    }
    Ok(())
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_the_canonical_bounded_build_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity");
        let digest = "1234567890abcdef".repeat(4);
        fs::write(&path, format!("{digest}\n")).unwrap();
        assert_eq!(read_identity(&path).unwrap(), digest);
        for value in [
            String::new(),
            digest.clone(),
            format!("{digest}\nextra"),
            format!("{digest}\n\n"),
            format!("{}\n", "A".repeat(64)),
            "x".repeat(4096),
        ] {
            fs::write(&path, value).unwrap();
            assert_eq!(
                read_identity(&path).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn identity_cannot_be_redirected_through_a_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        fs::write(&real, format!("{}\n", "1".repeat(64))).unwrap();
        let alias = directory.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert_eq!(
            read_identity(&alias).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn reuse_requires_a_captured_boot_expectation() {
        assert_eq!(verify().unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
}
