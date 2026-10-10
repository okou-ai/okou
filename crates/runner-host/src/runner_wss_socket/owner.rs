//! Kernel-held ownership and durable inode evidence for crash-only recovery.
//! This is filesystem lifecycle state, never routing, readiness or ticket authority.

use std::fs::{File, Metadata};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg, OFlag, openat, renameat};
use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
use nix::sys::stat::Mode;
use nix::unistd::{Gid, UnlinkatFlags, geteuid, unlinkat};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    device: u64,
    inode: u64,
    mtime: i64,
    mtime_nsec: i64,
    temporary_name: String,
}

pub(super) struct Owner {
    parent: File,
    #[cfg(not(target_os = "linux"))]
    directory: PathBuf,
    _lock: Flock<File>,
    journal_name: String,
    journal_identity: Option<(u64, u64)>,
    record: Option<Record>,
}

impl Owner {
    pub(super) fn acquire(parent: &File, _directory: &Path, id: Uuid) -> io::Result<Self> {
        let lock_name = format!("{id}.lock");
        validate_existing(parent, &lock_name)?;
        let lock_file = File::from(openat(
            parent,
            lock_name.as_str(),
            OFlag::O_RDWR
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )?);
        validate_private(&lock_file.metadata()?)?;
        let lock = Flock::lock(lock_file, FlockArg::LockExclusiveNonblock)
            .map_err(|(_, error)| io::Error::from_raw_os_error(error as i32))?;
        let mut owner = Self {
            parent: parent.try_clone()?,
            #[cfg(not(target_os = "linux"))]
            directory: _directory.to_owned(),
            _lock: lock,
            journal_name: format!("{id}.owner"),
            journal_identity: None,
            record: None,
        };
        let current = std::fs::symlink_metadata(owner.path(&lock_name))?;
        validate_private(&current)?;
        if identity(&current) != identity(&owner._lock.metadata()?) {
            return Err(changed());
        }
        validate_existing(&owner.parent, &owner.journal_name)?;
        let file = match openat(
            &owner.parent,
            owner.journal_name.as_str(),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        ) {
            Ok(file) => Some(File::from(file)),
            Err(nix::errno::Errno::ENOENT) => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(file) = file {
            let metadata = file.metadata()?;
            validate_private(&metadata)?;
            owner.journal_identity = Some(identity(&metadata));
            let mut bytes = Vec::new();
            file.take(1025).read_to_end(&mut bytes)?;
            if bytes.len() > 1024 {
                return Err(changed());
            }
            let record: Record = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            let Some(suffix) = record.temporary_name.strip_prefix(".wss-") else {
                return Err(changed());
            };
            if suffix.len() != 32 || Uuid::parse_str(suffix).is_err() || record.inode == 0 {
                return Err(changed());
            }
            owner.record = Some(record);
        }
        Ok(owner)
    }

    pub(super) fn path(&self, name: &str) -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            PathBuf::from(format!(
                "/proc/self/fd/{}/{}",
                self.parent.as_raw_fd(),
                name
            ))
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.directory.join(name)
        }
    }

    pub(super) fn recover(&self, final_name: &str, group: Gid) -> io::Result<()> {
        let mut stale = Vec::new();
        let names = match &self.record {
            Some(record) => vec![final_name, record.temporary_name.as_str()],
            None => vec![final_name],
        };
        for name in names {
            let metadata = match std::fs::symlink_metadata(self.path(name)) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let Some(record) = &self.record else {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "unowned WSS endpoint exists",
                ));
            };
            if !matches(record, &metadata, group) {
                return Err(changed());
            }
            // A lock alone must not erase an endpoint retained by an unexpected
            // live descriptor holder. Nonblocking refusal is the only stale proof.
            let probe = socket(
                AddressFamily::Unix,
                SockType::Stream,
                SockFlag::SOCK_NONBLOCK | SockFlag::SOCK_CLOEXEC,
                None,
            )?;
            let address = UnixAddr::new(&self.path(name))?;
            match connect(probe.as_raw_fd(), &address) {
                Err(nix::errno::Errno::ECONNREFUSED) => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "WSS endpoint is live or uncertain",
                    ));
                }
            }
            stale.push(name);
        }
        // A retained private anchor prevents inode reuse after the listener dies.
        // A final pathname without that anchor is not recoverable ownership proof.
        if stale.contains(&final_name)
            && !stale.contains(
                &self
                    .record
                    .as_ref()
                    .ok_or_else(changed)?
                    .temporary_name
                    .as_str(),
            )
        {
            return Err(changed());
        }
        // Validate every candidate before touching either published or temporary
        // link. Unknown/replaced/symlink endpoints are preserved, never followed.
        for name in stale {
            let current = std::fs::symlink_metadata(self.path(name))?;
            if !matches(self.record.as_ref().ok_or_else(changed)?, &current, group) {
                return Err(changed());
            }
            unlinkat(&self.parent, name, UnlinkatFlags::NoRemoveDir)?;
        }
        Ok(())
    }

    pub(super) fn remove_if_owned(
        &self,
        name: &std::ffi::OsStr,
        device: u64,
        inode: u64,
    ) -> io::Result<()> {
        let current = match nix::sys::stat::fstatat(
            &self.parent,
            name,
            nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
        ) {
            Ok(current) => current,
            Err(nix::errno::Errno::ENOENT) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        #[cfg(not(target_os = "linux"))]
        let device = device as libc::dev_t;
        if current.st_dev == device
            && current.st_ino == inode
            && current.st_mode & libc::S_IFMT == libc::S_IFSOCK
        {
            unlinkat(&self.parent, name, UnlinkatFlags::NoRemoveDir)?;
        }
        Ok(())
    }

    pub(super) fn record(&mut self, metadata: &Metadata, temporary_name: &str) -> io::Result<()> {
        let record = Record {
            device: metadata.dev(),
            inode: metadata.ino(),
            mtime: metadata.mtime(),
            mtime_nsec: metadata.mtime_nsec(),
            temporary_name: temporary_name.to_owned(),
        };
        let current = match std::fs::symlink_metadata(self.path(&self.journal_name)) {
            Ok(metadata) => {
                validate_private(&metadata)?;
                Some(identity(&metadata))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if current != self.journal_identity {
            return Err(changed());
        }
        let temporary = format!(".owner-{}", Uuid::new_v4().simple());
        let mut file = File::from(openat(
            &self.parent,
            temporary.as_str(),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )?);
        let result = (|| {
            file.write_all(&serde_json::to_vec(&record).map_err(io::Error::other)?)?;
            file.sync_all()?;
            renameat(
                &self.parent,
                temporary.as_str(),
                &self.parent,
                self.journal_name.as_str(),
            )?;
            self.parent.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = unlinkat(&self.parent, temporary.as_str(), UnlinkatFlags::NoRemoveDir);
        }
        result
    }
}

fn validate_existing(parent: &File, name: &str) -> io::Result<()> {
    let current =
        match nix::sys::stat::fstatat(parent, name, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(current) => current,
            Err(nix::errno::Errno::ENOENT) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
    if current.st_mode & libc::S_IFMT != libc::S_IFREG
        || current.st_uid != geteuid().as_raw()
        || current.st_mode & 0o7777 != 0o600
        || current.st_nlink != 1
    {
        return Err(changed());
    }
    Ok(())
}

fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

fn validate_private(metadata: &Metadata) -> io::Result<()> {
    if !metadata.is_file()
        || metadata.uid() != geteuid().as_raw()
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(changed());
    }
    Ok(())
}

fn matches(record: &Record, metadata: &Metadata, group: Gid) -> bool {
    use std::os::unix::fs::FileTypeExt;
    metadata.file_type().is_socket()
        && metadata.uid() == geteuid().as_raw()
        && metadata.gid() == group.as_raw()
        && metadata.mode() & 0o7777 == 0o660
        && metadata.dev() == record.device
        && metadata.ino() == record.inode
        && metadata.mtime() == record.mtime
        && metadata.mtime_nsec() == record.mtime_nsec
}

fn changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "WSS endpoint ownership evidence changed",
    )
}
