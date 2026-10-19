use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd, RawFd},
    os::unix::ffi::OsStrExt,
    path::Path,
};

use api_contracts::generated::types::sandbox_channel::fs::ListResultEntrieKind as Kind;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use super::Scope;
use crate::{ChannelError, Error};

// Linux openat2 UAPI. Flags are required as a set, never individually retried.
const NO_XDEV: u64 = 0x01;
const NO_MAGICLINKS: u64 = 0x02;
const NO_SYMLINKS: u64 = 0x04;
const BENEATH: u64 = 0x08;
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    device: libc::dev_t,
    inode: libc::ino_t,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Stamp {
    pub(super) fn same_identity(&self, other: &Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }

    fn from_stat(stat: &libc::stat) -> Self {
        Self {
            device: stat.st_dev,
            inode: stat.st_ino,
            modified: (stat.st_mtime, stat.st_mtime_nsec),
            changed: (stat.st_ctime, stat.st_ctime_nsec),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FileStamp {
    identity: Stamp,
    pub(super) size: u64,
}

fn error(errno: i32) -> Error {
    match errno {
        libc::ENOENT => Error::NotFound,
        libc::ENOTDIR => Error::NotDirectory,
        libc::ELOOP => Error::LinkNotExpandable,
        libc::EXDEV => Error::MountNotExpandable,
        libc::EAGAIN => Error::DirectoryChanged,
        _ => Error::Unavailable,
    }
}

fn open(parent: RawFd, path: &CStr, resolve: u64, scope: &mut Scope<'_>) -> Result<File, Error> {
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve,
    };
    scope.step()?;
    // SAFETY: the CString and fixed UAPI structure remain live; ownership is
    // adopted exactly once on success. Linux applies all resolution flags.
    let raw = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent,
            path.as_ptr(),
            std::ptr::from_ref(&how),
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if errno == libc::ENOTDIR {
            // O_DIRECTORY|O_NOFOLLOW reports ENOTDIR for a terminal symlink.
            // Classify only an O_PATH no-follow fd obtained with the identical
            // resolution policy; never traverse its target to improve an error.
            let metadata = OpenHow {
                flags: (libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
                mode: 0,
                resolve,
            };
            scope.step()?;
            // SAFETY: same initialized UAPI/CString; the returned fd is owned.
            let link = unsafe {
                libc::syscall(
                    libc::SYS_openat2,
                    parent,
                    path.as_ptr(),
                    std::ptr::from_ref(&metadata),
                    std::mem::size_of::<OpenHow>(),
                )
            };
            if link >= 0 {
                // SAFETY: successful openat2 returns a newly owned descriptor.
                let file = unsafe { File::from_raw_fd(link as RawFd) };
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                scope.step()?;
                // SAFETY: owned descriptor and valid output storage.
                if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } == 0 {
                    // SAFETY: fstat succeeded.
                    if unsafe { stat.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFLNK {
                        return Err(Error::LinkNotExpandable);
                    }
                }
            }
        }
        return Err(error(errno));
    }
    // SAFETY: openat2 returned a new owned fd.
    Ok(unsafe { File::from_raw_fd(raw as RawFd) })
}

pub(super) fn capture(path: &Path, scope: &mut Scope<'_>) -> Result<File, Error> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::Unavailable)?;
    // Capture the fixed Guest root without following any symlink ancestor.
    open(libc::AT_FDCWD, &path, NO_SYMLINKS | NO_MAGICLINKS, scope).map_err(|_| Error::Unavailable)
}

fn metadata(file: &File, scope: &mut Scope<'_>) -> Result<libc::stat, Error> {
    scope.step()?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: owned live descriptor and valid storage for one stat.
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(Error::Unavailable);
    }
    // SAFETY: successful fstat initialized all fields.
    Ok(unsafe { stat.assume_init() })
}

pub(super) fn stamp(file: &File, scope: &mut Scope<'_>) -> Result<Stamp, Error> {
    Ok(Stamp::from_stat(&metadata(file, scope)?))
}

pub(super) fn file_stamp(file: &File, scope: &mut Scope<'_>) -> Result<FileStamp, Error> {
    let stat = metadata(file, scope)?;
    match stat.st_mode & libc::S_IFMT {
        libc::S_IFREG => (),
        libc::S_IFLNK => return Err(Error::LinkNotExpandable),
        _ => return Err(Error::NotRegularFile),
    }
    let size = u64::try_from(stat.st_size).map_err(|_| Error::Unavailable)?;
    Ok(FileStamp {
        identity: Stamp::from_stat(&stat),
        size,
    })
}

/// Pin only metadata first: opening FIFO/device contents to discover their type
/// would already violate the regular-file boundary, even with nonblocking IO.
pub(super) fn pin_regular(
    parent: &File,
    name: &[u8],
    scope: &mut Scope<'_>,
) -> Result<(File, FileStamp), Error> {
    let name = CString::new(name).map_err(|_| Error::Unavailable)?;
    let how = OpenHow {
        flags: (libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: BENEATH | NO_SYMLINKS | NO_MAGICLINKS | NO_XDEV,
    };
    scope.step()?;
    // SAFETY: live held parent, single raw basename and initialized UAPI. O_PATH
    // obtains metadata without opening the target's contents or special device.
    let raw = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent.as_raw_fd(),
            name.as_ptr(),
            std::ptr::from_ref(&how),
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        return Err(error(
            io::Error::last_os_error().raw_os_error().unwrap_or(0),
        ));
    }
    // SAFETY: successful openat2 returns one newly owned descriptor.
    let file = unsafe { File::from_raw_fd(raw as RawFd) };
    let stamp = file_stamp(&file, scope)?;
    Ok((file, stamp))
}

/// Reopen the held, already classified inode through the kernel's fd link.
/// This intentional magic-link operation never resolves a caller's path.
pub(super) fn readable(
    pinned: &File,
    expected: FileStamp,
    scope: &mut Scope<'_>,
) -> Result<File, Error> {
    #[cfg(test)]
    {
        let hook = scope.job.owner.hooks.lock().unwrap().after_file_pin.take();
        if let Some(hook) = hook {
            hook();
        }
    }
    let path = CString::new(format!("/proc/self/fd/{}", pinned.as_raw_fd()))
        .map_err(|_| Error::Unavailable)?;
    scope.step()?;
    // SAFETY: the O_PATH descriptor remains owned/live, and the kernel fd path
    // is generated here. No user basename can select the link or its fd number.
    let raw = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOCTTY,
        )
    };
    if raw < 0 {
        return Err(Error::Unavailable);
    }
    // SAFETY: successful open returns one newly owned descriptor.
    let file = unsafe { File::from_raw_fd(raw) };
    if file_stamp(&file, scope)? != expected {
        return Err(Error::FileChanged);
    }
    Ok(file)
}

pub(super) fn path(tokens: &[String]) -> Result<Vec<u8>, Error> {
    let mut path = Vec::new();
    for token in tokens {
        let bytes = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| ChannelError::InvalidParams)?;
        if bytes.is_empty()
            || bytes == b"."
            || bytes == b".."
            || bytes.contains(&0)
            || bytes.contains(&b'/')
            || URL_SAFE_NO_PAD.encode(&bytes) != *token
        {
            return Err(ChannelError::InvalidParams.into());
        }
        if !path.is_empty() {
            path.push(b'/');
        }
        path.extend(bytes);
    }
    Ok(path)
}

/// Walk from the captured Guest root and stamp every prefix. Only the fixed
/// canonical home transition may cross a mount; its descendants cannot.
pub(super) fn resolve(
    root: &File,
    path: &[u8],
    scope: &mut Scope<'_>,
) -> Result<(File, Vec<Stamp>), Error> {
    let mut stamps = vec![stamp(root, scope)?];
    if path.is_empty() {
        let directory = open(
            root.as_raw_fd(),
            c".",
            BENEATH | NO_SYMLINKS | NO_MAGICLINKS | NO_XDEV,
            scope,
        )?;
        stamps.push(stamp(&directory, scope)?);
        return Ok((directory, stamps));
    }
    let home = guest_contracts::home_mount::HOME_DIR
        .trim_start_matches('/')
        .as_bytes();
    let mut prefix = Vec::new();
    let mut directory = None;
    for component in path.split(|byte| *byte == b'/') {
        if !prefix.is_empty() {
            prefix.push(b'/');
        }
        prefix.extend_from_slice(component);
        let name = CString::new(component).map_err(|_| Error::OutsideHome)?;
        let parent = directory.as_ref().unwrap_or(root);
        let mut policy = BENEATH | NO_SYMLINKS | NO_MAGICLINKS;
        if prefix != home {
            policy |= NO_XDEV;
        }
        let file = open(parent.as_raw_fd(), &name, policy, scope)?;
        stamps.push(stamp(&file, scope)?);
        directory = Some(file);
    }
    Ok((directory.ok_or(Error::Unavailable)?, stamps))
}

pub(super) fn kind(directory: &File, name: &[u8], scope: &mut Scope<'_>) -> Result<Kind, Error> {
    let name = CString::new(name).map_err(|_| Error::Unavailable)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    scope.step()?;
    // SAFETY: name is a single raw basename, descriptor is live, and no-follow
    // metadata never opens a symlink target or special-file contents.
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(Error::DirectoryChanged);
    }
    // SAFETY: successful fstatat initialized the structure.
    let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
    Ok(match mode {
        libc::S_IFDIR => Kind::Directory,
        libc::S_IFREG => Kind::File,
        libc::S_IFLNK => Kind::Symlink,
        _ => Kind::Other,
    })
}

pub(super) fn read(
    directory: &File,
    buffer: &mut [u8],
    scope: &mut Scope<'_>,
) -> Result<usize, Error> {
    scope.step()?;
    // SAFETY: live independent directory fd and writable buffer. The kernel
    // advances only this listing's offset; no dup/shared seek offset is used.
    let result = unsafe {
        libc::syscall(
            libc::SYS_getdents64,
            directory.as_raw_fd(),
            buffer.as_mut_ptr(),
            buffer.len(),
        )
    };
    if result < 0 {
        return Err(Error::Unavailable);
    }
    #[cfg(test)]
    scope.hook(true);
    usize::try_from(result).map_err(|_| Error::Unavailable)
}

pub(super) fn display(name: &[u8]) -> Result<String, Error> {
    let mut label = String::new();
    let mut remaining = name;
    while !remaining.is_empty() {
        let (valid, invalid) = match std::str::from_utf8(remaining) {
            Ok(valid) => (valid, 0),
            Err(error) => {
                let prefix = remaining
                    .get(..error.valid_up_to())
                    .ok_or(Error::Unavailable)?;
                let valid = std::str::from_utf8(prefix).map_err(|_| Error::Unavailable)?;
                (
                    valid,
                    error
                        .error_len()
                        .unwrap_or(remaining.len() - error.valid_up_to()),
                )
            }
        };
        for character in valid.chars() {
            if character.is_control()
                || character == '\\'
                || matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                label.extend(character.escape_default());
            } else {
                label.push(character);
            }
        }
        remaining = remaining.get(valid.len()..).ok_or(Error::Unavailable)?;
        for byte in remaining.get(..invalid).ok_or(Error::Unavailable)? {
            use std::fmt::Write;
            let _ = write!(label, "\\x{byte:02x}");
        }
        remaining = remaining.get(invalid..).ok_or(Error::Unavailable)?;
    }
    Ok(label)
}
