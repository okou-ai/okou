//! Kernel-held ownership and durable inode evidence for crash-only recovery.
//! This is filesystem lifecycle state, never routing, readiness or ticket authority.
//! Journal inode/timestamps identify the retained socket anchor. Mount-local
//! device numbers are compared only between current links, never persisted.

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

use super::namespace::NamespaceLock;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    inode: u64,
    mtime: i64,
    mtime_nsec: i64,
    temporary_name: String,
}

#[derive(PartialEq)]
struct JournalIdentity {
    inode: (u64, u64),
    modified: (i64, i64),
    changed: (i64, i64),
    length: u64,
}

impl JournalIdentity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            inode: identity(metadata),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
            length: metadata.len(),
        }
    }
}

pub(super) struct Owner {
    parent: File,
    #[cfg(not(target_os = "linux"))]
    directory: PathBuf,
    _lock: Flock<File>,
    id: Uuid,
    lock_name: String,
    journal_name: String,
    journal_identity: Option<JournalIdentity>,
    // Pin the journal inode while this owner is alive. Otherwise unlink/write
    // can reuse the inode before teardown's pathname identity check.
    journal_file: Option<File>,
    record: Option<Record>,
}

impl Owner {
    pub(super) fn acquire(guard: &NamespaceLock, directory: &Path, id: Uuid) -> io::Result<Self> {
        Self::open(guard, directory, id, true)
    }

    pub(super) fn existing(guard: &NamespaceLock, directory: &Path, id: Uuid) -> io::Result<Self> {
        Self::open(guard, directory, id, false)
    }

    fn open(guard: &NamespaceLock, _directory: &Path, id: Uuid, create: bool) -> io::Result<Self> {
        let parent = guard.parent();
        let lock_name = format!("{id}.lock");
        validate_existing(parent, &lock_name)?;
        let lock_file = File::from(openat(
            parent,
            lock_name.as_str(),
            OFlag::O_RDWR
                | if create {
                    OFlag::O_CREAT
                } else {
                    OFlag::empty()
                }
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
            id,
            lock_name: lock_name.clone(),
            journal_name: format!("{id}.owner"),
            journal_identity: None,
            journal_file: None,
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
        if let Some(mut file) = file {
            let metadata = file.metadata()?;
            validate_private(&metadata)?;
            owner.journal_identity = Some(JournalIdentity::of(&metadata));
            let mut bytes = Vec::new();
            (&mut file).take(1025).read_to_end(&mut bytes)?;
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
            owner.journal_file = Some(file);
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
        let stale = self.dead_paths(final_name, group)?;
        self.validate_metadata()?;
        // Recheck all links before deletion. Device numbers belong to the
        // current mount, not to a durable record from a previous boot.
        for (name, expected) in &stale {
            let current = std::fs::symlink_metadata(self.path(name))?;
            if identity(&current) != *expected
                || !matches(self.record.as_ref().ok_or_else(changed)?, &current, group)
            {
                return Err(changed());
            }
        }
        for (name, _) in stale {
            unlinkat(&self.parent, name.as_str(), UnlinkatFlags::NoRemoveDir)?;
        }
        Ok(())
    }

    pub(super) fn dead_paths(
        &self,
        final_name: &str,
        group: Gid,
    ) -> io::Result<Vec<(String, (u64, u64))>> {
        self.validate_metadata()?;
        let anchor = match &self.record {
            Some(record) => match std::fs::symlink_metadata(self.path(&record.temporary_name)) {
                Ok(metadata) if matches(record, &metadata, group) => Some(identity(&metadata)),
                Ok(_) => return Err(changed()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            },
            None => None,
        };
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
            // A missing anchor never authorizes recovery of a remaining
            // published endpoint, even if its old inode/timestamps match.
            if !anchored_identity(record.inode, identity(&metadata), anchor)
                || !matches(record, &metadata, group)
            {
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
            stale.push((name.to_owned(), identity(&metadata)));
        }
        Ok(stale)
    }

    fn validate_metadata(&self) -> io::Result<()> {
        let lock = std::fs::symlink_metadata(self.path(&self.lock_name))?;
        validate_private(&lock)?;
        if identity(&lock) != identity(&self._lock.metadata()?) {
            return Err(changed());
        }
        let journal = match std::fs::symlink_metadata(self.path(&self.journal_name)) {
            Ok(metadata) => {
                validate_private(&metadata)?;
                Some(JournalIdentity::of(&metadata))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if journal != self.journal_identity {
            return Err(changed());
        }
        Ok(())
    }

    pub(super) fn retire_metadata(&self) -> io::Result<()> {
        let guard = NamespaceLock::acquire(&self.parent)?;
        self.retire_locked(&guard)
    }

    pub(super) fn retire_locked(&self, _guard: &NamespaceLock) -> io::Result<()> {
        self.validate_metadata()?;
        let final_name = format!("{}.sock", self.id);
        let mut names = vec![final_name.as_str()];
        if let Some(record) = &self.record {
            names.push(&record.temporary_name);
        }
        for name in names {
            match std::fs::symlink_metadata(self.path(name)) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
                Ok(_) => return Err(changed()),
            }
        }
        if self.journal_identity.is_some() {
            unlinkat(
                &self.parent,
                self.journal_name.as_str(),
                UnlinkatFlags::NoRemoveDir,
            )?;
        }
        // Starters take the same directory flock before opening an ID lock,
        // so unlinking a held ID lock cannot split listener ownership.
        unlinkat(
            &self.parent,
            self.lock_name.as_str(),
            UnlinkatFlags::NoRemoveDir,
        )?;
        self.parent.sync_all()?;
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
            inode: metadata.ino(),
            mtime: metadata.mtime(),
            mtime_nsec: metadata.mtime_nsec(),
            temporary_name: temporary_name.to_owned(),
        };
        self.validate_metadata()?;
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
            self.journal_identity = Some(JournalIdentity::of(&file.metadata()?));
            self.record = Some(record);
            self.journal_file = Some(file);
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

fn anchored_identity(inode: u64, current: (u64, u64), anchor: Option<(u64, u64)>) -> bool {
    current.1 == inode && anchor == Some(current)
}

pub(super) fn directory_path(parent: &File, directory: &Path) -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let _ = directory;
        PathBuf::from(format!("/proc/self/fd/{}", parent.as_raw_fd()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = parent;
        directory.to_owned()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_uses_current_mount_identity_and_requires_intact_anchor() {
        // Simulate a stable persisted inode on two boots with different st_dev
        // values. This is a predicate check, not physical reboot evidence.
        for device in [66305, 66306] {
            assert!(anchored_identity(42, (device, 42), Some((device, 42))));
            assert!(!anchored_identity(42, (device, 42), None));
            assert!(!anchored_identity(42, (device, 42), Some((device + 1, 42))));
            assert!(!anchored_identity(42, (device, 43), Some((device, 43))));
        }
    }
}
