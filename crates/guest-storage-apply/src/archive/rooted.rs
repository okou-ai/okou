//! Bounded directory reuse for ordinary files in one sequential extraction.
//!
//! The caller excludes concurrent external destination mutation. Cached handles
//! are invalidated before every general tar operation, which can change directory
//! identities or permissions. Every newly opened component is a real directory;
//! links and existing leaves retain the checked tar extractor's semantics.

use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{self, File, FileTimes, OpenOptions, Permissions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

// Includes the root. Cache exhaustion releases parents before checked tar
// extraction, so wide/deep archives do not retain an unbounded number of FDs.
const MAX_DIRECTORY_HANDLES: usize = 64;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const DIRECTORY_FLAGS: libc::c_int =
    libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

#[derive(Clone, Copy)]
enum CreationMode {
    FirstFile,
    Verified(u32),
    Unavailable,
}

pub(crate) struct RootedWriter<'a> {
    target: &'a Path,
    cache_directories: bool,
    root: Option<File>,
    root_path_bytes: usize,
    parents: HashMap<PathBuf, File>,
    copy_buffer: Vec<u8>,
    creation_mode: Option<(RawFd, CreationMode)>,
    previous_parent_path: PathBuf,
    previous_parent_fd: Option<RawFd>,
}

impl<'a> RootedWriter<'a> {
    pub(crate) fn new(target: &'a Path, concurrency: usize) -> Self {
        Self {
            target,
            cache_directories: has_descriptor_budget(concurrency),
            root: None,
            root_path_bytes: target.as_os_str().as_bytes().len(),
            parents: HashMap::new(),
            copy_buffer: Vec::new(),
            creation_mode: None,
            previous_parent_path: PathBuf::new(),
            previous_parent_fd: None,
        }
    }

    pub(crate) fn invalidate(&mut self) {
        self.parents.clear();
        self.creation_mode = None;
        self.previous_parent_fd = None;
        // Release even the root before checked tar extraction: under FD pressure
        // it can occupy the last slot needed to create the output file.
        self.root = None;
    }

    fn parent_fd(&mut self, parent: &Path) -> io::Result<Option<RawFd>> {
        if !self.cache_directories {
            return Ok(None);
        }
        if let Some(directory) = self.parents.get(parent) {
            return Ok(Some(directory.as_raw_fd()));
        }
        let mut previous = match &self.root {
            Some(root) => root.as_raw_fd(),
            None => match OpenOptions::new()
                .read(true)
                .custom_flags(DIRECTORY_FLAGS)
                .open(self.target)
            {
                Ok(root) => self.root.insert(root).as_raw_fd(),
                Err(error) if descriptor_limit(&error) => return Ok(None),
                Err(error) => return Err(error),
            },
        };
        let mut prefix = PathBuf::new();
        for component in parent.components() {
            let Component::Normal(name) = component else {
                return Ok(None);
            };
            prefix.push(name);
            if let Some(directory) = self.parents.get(&prefix) {
                previous = directory.as_raw_fd();
                continue;
            }
            if self.parents.len() + 1 >= MAX_DIRECTORY_HANDLES {
                return Ok(None);
            }
            let Ok(name) = CString::new(name.as_bytes()) else {
                return Ok(None);
            };
            // SAFETY: previous is held by the root or parent cache until the
            // open/create sequence completes, before the cache is mutated.
            let parent = unsafe { BorrowedFd::borrow_raw(previous) };
            let directory = match open_at(parent, name.as_c_str(), DIRECTORY_FLAGS, 0) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    match nix::sys::stat::mkdirat(
                        parent,
                        name.as_c_str(),
                        nix::sys::stat::Mode::from_bits_retain(0o777),
                    ) {
                        Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                        Err(error) => return Err(error.into()),
                    }
                    open_at(parent, name.as_c_str(), DIRECTORY_FLAGS, 0)
                }
                result => result,
            };
            let directory = match directory {
                Ok(directory) => directory,
                // A symlink parent needs tar's containment/rejection behavior.
                Err(error)
                    if descriptor_limit(&error)
                        || matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) =>
                {
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            previous = directory.as_raw_fd();
            self.parents.insert(prefix.clone(), directory);
        }
        Ok(Some(previous))
    }

    /// Only creates fresh leaves. Before a caller uses its checked replacement
    /// or link path, it must release these handles with invalidate().
    pub(crate) fn create_new(&mut self, relative: &Path) -> io::Result<Option<File>> {
        self.create_new_with_parent(relative)
            .map(|created| created.map(|(file, _)| file))
    }

    fn create_new_with_parent(&mut self, relative: &Path) -> io::Result<Option<(File, RawFd)>> {
        // Descriptor-relative syscalls can exceed the full-path limit. Retain
        // the existing path-based behavior rather than accepting new spellings.
        let path_bytes = relative.as_os_str().as_bytes();
        if path_bytes.contains(&0)
            || self.root_path_bytes + 1 + path_bytes.len() >= libc::PATH_MAX as usize
        {
            return Ok(None);
        }
        let Some(name) = relative.file_name() else {
            return Ok(None);
        };
        let Some(parent) = relative.parent() else {
            return Ok(None);
        };
        let parent = if let Some(fd) = self.previous_parent_fd
            && self.previous_parent_path.as_os_str() == parent.as_os_str()
        {
            // The parent was validated and its handle is still held. The
            // file_name call above already required a normal leaf component.
            fd
        } else {
            if !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            {
                return Ok(None);
            }
            let Some(fd) = self.parent_fd(parent)? else {
                return Ok(None);
            };
            self.previous_parent_path.clear();
            self.previous_parent_path.push(parent);
            self.previous_parent_fd = Some(fd);
            fd
        };
        // SAFETY: the root or cached parent stays open through this leaf open.
        let parent = unsafe { BorrowedFd::borrow_raw(parent) };
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        match open_at(parent, name, flags, 0o666) {
            Ok(file) => Ok(Some((file, parent.as_raw_fd()))),
            // Never truncate an existing inode: tar unlinks/recreates it, which
            // also preserves other hardlinks to that inode.
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists || descriptor_limit(&error) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// False leaves payload unread: invalidate parents before checked tar unpack.
    /// Once a leaf is created, any payload or metadata failure is returned, never
    /// retried. Tar's default mode/mtime behavior is reproduced only for plain files.
    pub(super) fn try_unpack<R: Read>(
        &mut self,
        entry: &mut tar::Entry<'_, R>,
    ) -> io::Result<bool> {
        // tar treats slash-terminated old/GNU regular entries as directories.
        // Check raw bytes before Path normalization loses the trailing slash.
        if entry.header().as_ustar().is_none() && entry.path_bytes().ends_with(b"/") {
            return Ok(false);
        }
        let (Ok(mode), Ok(mtime)) = (entry.header().mode(), entry.header().mtime()) else {
            return Ok(false);
        };
        if mtime > i64::MAX as u64 {
            return Ok(false);
        }
        // tar maps epoch-zero file times to one second for compatibility.
        let Some(modified) = UNIX_EPOCH.checked_add(Duration::from_secs(mtime.max(1))) else {
            return Ok(false);
        };
        let Some((mut file, parent)) = self.create_new_with_parent(entry.path()?.as_ref())? else {
            return Ok(false);
        };
        copy_payload(entry, &mut file, &mut self.copy_buffer)?;
        file.set_times(
            FileTimes::new()
                .set_accessed(modified)
                .set_modified(modified),
        )?;
        self.set_file_mode(&file, parent, mode & 0o777)?;
        Ok(true)
    }

    fn set_file_mode(&mut self, file: &File, parent: RawFd, mode: u32) -> io::Result<()> {
        // Adjacent fresh files use the same creation request, parent, and
        // process umask. Sample on the second file to avoid probing directories
        // that supply only one leaf. General tar operations invalidate the proof.
        let creation_mode = match self.creation_mode {
            Some((previous, observed)) if previous == parent => match observed {
                CreationMode::FirstFile => observe_creation_mode(file),
                observed => observed,
            },
            _ => CreationMode::FirstFile,
        };
        self.creation_mode = Some((parent, creation_mode));
        if matches!(creation_mode, CreationMode::Verified(bits) if bits == mode) {
            return Ok(());
        }
        file.set_permissions(Permissions::from_mode(mode))
    }
}

fn observe_creation_mode(file: &File) -> CreationMode {
    use rustix::fs::{fgetxattr_query, fstatfs};
    use rustix::io::Errno;

    // Even identical mode bits can represent a permission write to an ACL.
    // Only an ext inode without an inherited access ACL proves reuse.
    if fstatfs(file).is_ok_and(|stat| stat.f_type == libc::EXT4_SUPER_MAGIC)
        && fgetxattr_query(file, c"system.posix_acl_access") == Err(Errno::NODATA)
        && let Ok(metadata) = file.metadata()
    {
        return CreationMode::Verified(metadata.mode() & 0o7777);
    }
    CreationMode::Unavailable
}

// Reuse space for the next member while retaining the bounded streaming copy.
fn copy_payload<R: Read>(
    entry: &mut tar::Entry<'_, R>,
    file: &mut File,
    buffer: &mut Vec<u8>,
) -> io::Result<()> {
    let mut remaining = entry.size();
    let needed = remaining.min(COPY_BUFFER_BYTES as u64) as usize;
    if buffer.len() < needed {
        // Vec's default growth can exceed the copy limit near the upper bound.
        let capacity = needed.next_power_of_two().min(COPY_BUFFER_BYTES);
        buffer.reserve_exact(capacity - buffer.len());
        buffer.resize(needed, 0);
    }
    while remaining > 0 {
        let chunk = remaining.min(buffer.len() as u64) as usize;
        let output = buffer.split_at_mut(chunk).0;
        match entry.read(output) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "failed to write entire tar file",
                ));
            }
            Ok(read) => {
                file.write_all(output.split_at(read).0)?;
                remaining -= read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn has_descriptor_budget(concurrency: usize) -> bool {
    use nix::sys::resource::{Resource, getrlimit};

    let Ok((soft_limit, _)) = getrlimit(Resource::RLIMIT_NOFILE) else {
        return false;
    };
    // All workers can retain a full directory cache at once. Keep the same
    // number of slots free for source setup and checked file IO: releasing one
    // worker's handles on EMFILE cannot release handles held by its peers.
    let required = (2 * MAX_DIRECTORY_HANDLES * concurrency) as libc::rlim_t;
    if soft_limit < required {
        return false;
    }

    // The Runner's pinned Guest kernel reports the open descriptor count as
    // the procfs directory size. Retain the previous conservative cutoff.
    fs::metadata("/proc/self/fd").is_ok_and(|metadata| {
        metadata.is_dir()
            && metadata.len() > 0
            && u128::from(metadata.len()) < u128::from(soft_limit - required)
    })
}

fn descriptor_limit(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::EMFILE | libc::ENFILE))
}

fn open_at(
    parent: BorrowedFd<'_>,
    name: &(impl nix::NixPath + ?Sized),
    flags: libc::c_int,
    mode: libc::mode_t,
) -> io::Result<File> {
    let fd = nix::fcntl::openat(
        parent,
        name,
        nix::fcntl::OFlag::from_bits_retain(flags),
        nix::sys::stat::Mode::from_bits_retain(mode),
    )?;
    Ok(File::from(fd))
}
