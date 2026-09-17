//! Low-level host filesystem primitives for hardening runner-owned host state.
//!
//! Directory walks are relative to directory file descriptors and use
//! no-follow opens. Paths are checked lexically before any component is opened
//! or created, so parent-directory (`..`) components are rejected before
//! mutation. Every component must be a directory owned by root or the runner
//! effective uid. Group/other-writable intermediate components are accepted
//! only when they have the sticky bit. Final-component rules are mode-specific:
//! [`DirMode::Private`] normalizes a runner-owned final directory to `0700`,
//! while the trusted and shared modes reject group/other-writable final
//! directories.
//!
//! [`DirMode`] selects the final-directory policy and the mode used for
//! missing components. The caller should choose the policy that matches the
//! state being protected rather than relying on the mode name alone:
//!
//! - Use [`DirMode::Private`] for runner-exclusive state such as logs, queue
//!   state, caches, and live-runner records.
//! - Use [`DirMode::TrustedParent`] for a trusted existing parent, such as a
//!   lock-file parent, when missing components should be private and an
//!   existing safe final mode should be preserved.
//! - Use [`DirMode::SharedTrustedParent`] for a shared parent such as a local
//!   queue group directory when missing components should be shared but an
//!   existing safe final mode should be preserved.
//! - Use [`DirMode::SharedTrusted`] for a shared directory such as setup state
//!   when a runner-owned final directory should be normalized to `0755`.
//!
//! Keep policy-specific entry points in caller modules.

use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use nix::fcntl::{OFlag, open, openat};
use nix::sys::stat::{Mode, SFlag, fstat, mkdirat};

#[cfg(test)]
pub(crate) mod atomic_write_test;

pub(crate) const PRIVATE_DIR_MODE: u32 = 0o700;
pub(crate) const PRIVATE_FILE_MODE: u32 = 0o600;
pub(crate) const SHARED_TRUSTED_DIR_MODE: u32 = 0o755;

const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const ROOT_UID: u32 = 0;
const STICKY_BIT: u32 = 0o1000;

#[derive(Clone, Copy)]
/// Trust and permission policy for a directory walk.
///
/// All modes share the traversal and trust checks documented at the module
/// level. In particular, intermediate directories may be group/other-writable
/// only when they have the sticky bit. For the final directory, `Private`
/// requires runner ownership and normalizes its permission bits, while the
/// other modes accept root or runner ownership but reject group/other writes.
/// The mode also determines the permissions used for missing components and
/// whether a runner-owned final directory is normalized.
pub(crate) enum DirMode {
    /// Protect runner-exclusive state with a private final directory.
    ///
    /// The final directory must be owned by the runner effective uid. Missing
    /// components are created as `0700`, and an existing runner-owned final
    /// directory is normalized to `0700` when necessary, regardless of its
    /// previous permission bits. A root-owned final directory is not accepted
    /// by this mode.
    Private,
    /// Trust an existing final directory while creating missing components
    /// privately.
    ///
    /// The final directory must be root-owned or runner-owned and must not be
    /// group/other-writable. Missing components are created as `0700`.
    /// Existing safe final permissions are preserved; this mode does not
    /// normalize an existing final directory.
    TrustedParent,
    /// Trust a shared existing parent while preserving its safe final mode.
    ///
    /// The final directory must be root-owned or runner-owned and must not be
    /// group/other-writable. Missing components are created as `0755`.
    /// Existing safe final permissions are preserved, including for a
    /// runner-owned final directory.
    SharedTrustedParent,
    /// Trust a shared directory and normalize its runner-owned final mode.
    ///
    /// The final directory must be root-owned or runner-owned and must not be
    /// group/other-writable. Missing components are created as `0755`. An
    /// existing runner-owned final directory is normalized to `0755`; a
    /// root-owned final directory remains unchanged when it is already safe.
    SharedTrusted,
}

struct DirWalk<'a> {
    full_path: &'a Path,
    mode: DirMode,
    context: &'a str,
    expected_uid: u32,
    create_missing: bool,
}

/// Create and validate a trusted directory path.
///
/// Missing components are created with the mode selected by [`DirMode`]. The
/// same ownership and permission checks used by [`validate_dir`] are applied
/// to every component. Depending on the mode, an existing runner-owned final
/// directory may also be normalized to `0700` or `0755`.
pub(crate) fn ensure_dir(path: &Path, mode: DirMode, context: &str) -> io::Result<()> {
    open_dir_components(path, mode, context, true).map(|_| ())
}

/// Validate a trusted directory path without creating missing components.
///
/// This applies the same ownership, path, symlink, and permission checks as
/// [`ensure_dir`]. It is not necessarily read-only: [`DirMode::Private`] and
/// [`DirMode::SharedTrusted`] can normalize an existing runner-owned final
/// directory to their required mode. No component is created when a path is
/// missing.
pub(crate) fn validate_dir(path: &Path, mode: DirMode, context: &str) -> io::Result<()> {
    open_dir_components(path, mode, context, false).map(|_| ())
}

/// Open the validated directory itself without creating missing components.
///
/// Keeping the descriptor preserves the directory identity for callers that
/// coordinate filesystem operations with a lock on that inode.
pub(crate) fn open_dir(path: &Path, mode: DirMode, context: &str) -> io::Result<File> {
    let dir = open_dir_components(path, mode, context, false)?;
    // The Linux walk uses O_PATH, which cannot be flocked. Reopen "."
    // relative to that descriptor, preserving the validated directory inode.
    openat(
        &dir,
        ".",
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|e| wrap_io(e.into(), format!("open {context} {}", path.display())))
}

pub(crate) fn open_private_append_file(path: &Path, read: bool) -> io::Result<File> {
    validate_file_parent(path, "log directory")?;

    let mut options = File::options();
    options
        .create(true)
        .append(true)
        .read(read)
        .mode(PRIVATE_FILE_MODE)
        .custom_flags(private_file_open_flags());
    let file = options
        .open(path)
        .map_err(|e| wrap_io(e, format!("open log file {}", path.display())))?;
    secure_regular_private_file(&file, path, "log file")?;
    Ok(file)
}

pub(crate) fn validate_private_file_destination(path: &Path, context: &str) -> io::Result<()> {
    validate_file_parent(path, context)?;

    let mut options = File::options();
    options
        .read(true)
        .write(true)
        .custom_flags(private_file_open_flags());
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(wrap_io(e, format!("open {context} {}", path.display())));
        }
    };
    secure_regular_private_file(&file, path, context)
}

/// Create a new file with `0600` permissions before writing its contents.
///
/// Existing paths, including symlinks, are refused. Permissions are normalized
/// on the opened descriptor regardless of umask, and writes are flushed before
/// returning. The caller owns parent-directory trust, failed-file cleanup, and
/// publication. This operation does not fsync the file.
#[cfg(unix)]
pub(crate) async fn write_private_new(
    path: &Path,
    content: &[u8],
    context: &str,
) -> io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(PRIVATE_FILE_MODE);
    let mut file = options
        .open(path)
        .await
        .map_err(|e| wrap_io(e, format!("open {context} {}", path.display())))?;
    chmod_private_file_fd(&file, path, context)?;
    file.write_all(content)
        .await
        .map_err(|e| wrap_io(e, format!("write {context} {}", path.display())))?;
    file.flush()
        .await
        .map_err(|e| wrap_io(e, format!("flush {context} {}", path.display())))?;
    Ok(())
}

/// Publish a private file through same-directory atomic replacement on Unix.
///
/// The caller remains responsible for parent-directory trust. This operation
/// does not fsync the file or parent directory, serialize writers, or define
/// concurrent-writer ordering. Staging-file cleanup after an error is best
/// effort. Non-Unix builds use a direct platform write instead.
#[cfg(unix)]
pub(crate) async fn write_private_atomic(
    path: &Path,
    content: &[u8],
    context: &str,
) -> io::Result<()> {
    use std::ffi::OsString;

    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} does not have a file name; refusing to write {context}",
                path.display()
            ),
        )
    })?;
    let mut tmp_name = OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let tmp = path.with_file_name(tmp_name);

    let result = async {
        write_private_new(&tmp, content, context).await?;

        #[cfg(test)]
        let renamed = atomic_write_test::rename(&tmp, path).await;
        #[cfg(not(test))]
        let renamed = tokio::fs::rename(&tmp, path).await;
        renamed.map_err(|e| wrap_io(e, format!("rename {context} {}", path.display())))?;
        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

#[cfg(not(unix))]
pub(crate) async fn write_private_atomic(
    path: &Path,
    content: &[u8],
    context: &str,
) -> io::Result<()> {
    tokio::fs::write(path, content)
        .await
        .map_err(|e| wrap_io(e, format!("write {context} {}", path.display())))
}

pub(crate) fn secure_regular_private_file<Fd: AsRawFd>(
    file: &Fd,
    path: &Path,
    context: &str,
) -> io::Result<()> {
    let stat = fstat_raw(file, path, context)?;
    let file_type = stat.st_mode & nix::libc::S_IFMT;
    if file_type != nix::libc::S_IFREG {
        return Err(permission_denied(format!(
            "{} is not a regular {context}",
            path.display()
        )));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    if stat.st_uid != expected_uid {
        return Err(permission_denied(format!(
            "{} is owned by uid {}, but runner euid is {expected_uid}",
            path.display(),
            stat.st_uid
        )));
    }

    let mode = stat.st_mode & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(permission_denied(format!(
            "{} is group/other writable",
            path.display()
        )));
    }
    if mode != PRIVATE_FILE_MODE {
        chmod_private_file_fd(file, path, context)?;
    }
    Ok(())
}

pub(crate) fn private_file_open_flags() -> i32 {
    nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK
}

pub(crate) fn validate_file_parent(path: &Path, context: &str) -> io::Result<()> {
    let parent = file_parent(path);
    validate_dir(parent, DirMode::TrustedParent, context)
}

pub(crate) fn file_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn open_dir_components(
    path: &Path,
    mode: DirMode,
    context: &str,
    create_missing: bool,
) -> io::Result<OwnedFd> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("empty {context} path"),
        ));
    }
    validate_lexical_components(path)?;

    let expected_uid = nix::unistd::geteuid().as_raw();
    let start = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, dir_open_flags(), Mode::empty()).map_err(|e| {
        io::Error::other(format!("open {context} root for {}: {e}", path.display()))
    })?;
    let mut current_path = PathBuf::with_capacity(path.as_os_str().len().saturating_add(2));
    current_path.push(start);
    let mut components = path.components().peekable();
    let mut saw_normal_component = false;
    let walk = DirWalk {
        full_path: path,
        mode,
        context,
        expected_uid,
        create_missing,
    };

    while let Some(component) = components.next() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(permission_denied(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                saw_normal_component = true;
                let is_final = components.peek().is_none();
                current_path.push(name);
                current = open_dir_component(&current, name, &current_path, &walk, is_final)?;
            }
            Component::Prefix(prefix) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} contains unsupported path prefix {}",
                        path.display(),
                        prefix.as_os_str().to_string_lossy()
                    ),
                ));
            }
        }
    }

    if !saw_normal_component {
        secure_dir_component(&current, &current_path, &walk, true, false)?;
    }

    Ok(current)
}

fn validate_lexical_components(path: &Path) -> io::Result<()> {
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir | Component::Normal(_) => {}
            Component::ParentDir => {
                return Err(permission_denied(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Prefix(prefix) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} contains unsupported path prefix {}",
                        path.display(),
                        prefix.as_os_str().to_string_lossy()
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn open_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    component_path: &Path,
    walk: &DirWalk<'_>,
    is_final: bool,
) -> io::Result<OwnedFd> {
    ensure_parent_not_replaceable(
        parent,
        file_parent(component_path),
        walk.full_path,
        walk.context,
        walk.expected_uid,
    )?;
    match openat(parent, name, dir_open_flags(), Mode::empty()) {
        Ok(fd) => {
            secure_dir_component(&fd, component_path, walk, is_final, false)?;
            Ok(fd)
        }
        Err(nix::errno::Errno::ENOENT) if walk.create_missing => {
            create_and_open_dir_component(parent, name, component_path, walk, is_final)
        }
        Err(e) => Err(dir_component_error(
            "open",
            name,
            walk.full_path,
            walk.context,
            e,
        )),
    }
}

fn create_and_open_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    component_path: &Path,
    walk: &DirWalk<'_>,
    is_final: bool,
) -> io::Result<OwnedFd> {
    let created = match mkdirat(
        parent,
        name,
        Mode::from_bits_truncate(create_dir_mode(walk.mode)),
    ) {
        Ok(()) => true,
        Err(nix::errno::Errno::EEXIST) => false,
        Err(e) => {
            return Err(io::Error::other(format!(
                "create {} component {} for {}: {e}",
                walk.context,
                name.to_string_lossy(),
                walk.full_path.display()
            )));
        }
    };
    if created {
        chmod_created_dir_entry(
            parent,
            name,
            walk.full_path,
            walk.context,
            create_dir_mode(walk.mode),
        )?;
    }

    let fd = openat(parent, name, dir_open_flags(), Mode::empty())
        .map_err(|e| dir_component_error("open", name, walk.full_path, walk.context, e))?;
    secure_dir_component(&fd, component_path, walk, is_final, created)?;
    Ok(fd)
}

fn create_dir_mode(mode: DirMode) -> u32 {
    match mode {
        DirMode::Private | DirMode::TrustedParent => PRIVATE_DIR_MODE,
        DirMode::SharedTrustedParent | DirMode::SharedTrusted => SHARED_TRUSTED_DIR_MODE,
    }
}

fn chmod_created_dir_entry(
    parent: &(impl AsRawFd + ?Sized),
    name: &OsStr,
    full_path: &Path,
    context: &str,
    mode: u32,
) -> io::Result<()> {
    let c_name = CString::new(name.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} contains a NUL byte in component {}",
                full_path.display(),
                name.to_string_lossy()
            ),
        )
    })?;
    // SAFETY: `c_name` is NUL-terminated, `parent` owns a live directory fd,
    // and fchmodat does not affect Rust aliasing.
    let result = unsafe {
        nix::libc::fchmodat(
            parent.as_raw_fd(),
            c_name.as_ptr(),
            mode as nix::libc::mode_t,
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod {context} component {} for {}: {}",
            name.to_string_lossy(),
            full_path.display(),
            io::Error::last_os_error()
        )))
    }
}

fn ensure_parent_not_replaceable(
    parent: &(impl AsFd + AsRawFd),
    parent_path: &Path,
    full_path: &Path,
    context: &str,
    expected_uid: u32,
) -> io::Result<()> {
    let stat = fstat(parent).map_err(|e| {
        io::Error::other(format!(
            "stat {context} parent {} for {}: {e}",
            parent_path.display(),
            full_path.display()
        ))
    })?;
    let mode = (stat.st_mode as u32) & 0o7777;
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(permission_denied(format!(
            "{context} parent {} is owned by untrusted uid {}",
            parent_path.display(),
            stat.st_uid
        )));
    }
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && mode & STICKY_BIT == 0 {
        return Err(permission_denied(format!(
            "{context} parent {} is group/other writable without the sticky bit",
            parent_path.display()
        )));
    }
    Ok(())
}

fn secure_dir_component(
    fd: &(impl AsFd + AsRawFd),
    component_path: &Path,
    walk: &DirWalk<'_>,
    is_final: bool,
    created: bool,
) -> io::Result<()> {
    let stat = fstat(fd).map_err(|e| {
        io::Error::other(format!(
            "stat {} component {} for {}: {e}",
            walk.context,
            component_path.display(),
            walk.full_path.display()
        ))
    })?;
    let fd_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if fd_type != SFlag::S_IFDIR {
        return Err(permission_denied(format!(
            "{} is not a directory",
            walk.full_path.display()
        )));
    }

    match walk.mode {
        DirMode::Private if is_final => {
            if stat.st_uid != walk.expected_uid {
                return Err(permission_denied(format!(
                    "{} {} is owned by uid {}, but runner euid is {}",
                    walk.context,
                    component_path.display(),
                    stat.st_uid,
                    walk.expected_uid
                )));
            }
            let component_mode = (stat.st_mode as u32) & 0o7777;
            if component_mode != PRIVATE_DIR_MODE {
                chmod_dir_fd(fd, component_path, PRIVATE_DIR_MODE, walk.context)?;
            }
        }
        DirMode::TrustedParent if is_final => {
            validate_trusted_component_owner(
                stat.st_uid,
                walk.expected_uid,
                walk.context,
                component_path,
            )?;
            let component_mode = (stat.st_mode as u32) & 0o7777;
            if component_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
                return Err(permission_denied(format!(
                    "{} {} is group/other writable",
                    walk.context,
                    component_path.display()
                )));
            }
        }
        DirMode::SharedTrustedParent | DirMode::SharedTrusted => {
            validate_trusted_component_owner(
                stat.st_uid,
                walk.expected_uid,
                walk.context,
                component_path,
            )?;
            let component_mode = (stat.st_mode as u32) & 0o7777;
            if is_final {
                if component_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
                    return Err(permission_denied(format!(
                        "{} {} is group/other writable",
                        walk.context,
                        component_path.display()
                    )));
                }
            } else if component_mode & GROUP_OR_OTHER_WRITE_BITS != 0
                && component_mode & STICKY_BIT == 0
            {
                return Err(permission_denied(format!(
                    "{} component {} is group/other writable without the sticky bit",
                    walk.context,
                    component_path.display()
                )));
            }
            let normalize_final = matches!(walk.mode, DirMode::SharedTrusted) && is_final;
            if (created || normalize_final)
                && stat.st_uid == walk.expected_uid
                && component_mode != SHARED_TRUSTED_DIR_MODE
            {
                chmod_dir_fd(fd, component_path, SHARED_TRUSTED_DIR_MODE, walk.context)?;
            }
        }
        _ => {
            validate_trusted_component_owner(
                stat.st_uid,
                walk.expected_uid,
                walk.context,
                component_path,
            )?;
            let component_mode = (stat.st_mode as u32) & 0o7777;
            if component_mode & GROUP_OR_OTHER_WRITE_BITS != 0 && component_mode & STICKY_BIT == 0 {
                return Err(permission_denied(format!(
                    "{} component {} is group/other writable without the sticky bit",
                    walk.context,
                    component_path.display()
                )));
            }
        }
    }

    Ok(())
}

fn validate_trusted_component_owner(
    actual_uid: u32,
    expected_uid: u32,
    context: &str,
    path: &Path,
) -> io::Result<()> {
    if actual_uid != ROOT_UID && actual_uid != expected_uid {
        return Err(permission_denied(format!(
            "{context} component {} is owned by untrusted uid {actual_uid}",
            path.display()
        )));
    }
    Ok(())
}

fn fstat_raw<Fd: AsRawFd>(file: &Fd, path: &Path, context: &str) -> io::Result<nix::libc::stat> {
    let mut stat = std::mem::MaybeUninit::<nix::libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live fd.
    let result = unsafe { nix::libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::other(format!(
            "stat {context} {}: {}",
            path.display(),
            io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    Ok(unsafe { stat.assume_init() })
}

fn chmod_private_file_fd<Fd: AsRawFd>(file: &Fd, path: &Path, context: &str) -> io::Result<()> {
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result =
        unsafe { nix::libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE as nix::libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod {context} {}: {}",
            path.display(),
            io::Error::last_os_error()
        )))
    }
}

#[cfg(target_os = "linux")]
fn chmod_dir_fd<Fd: AsRawFd>(fd: &Fd, path: &Path, mode: u32, context: &str) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| wrap_io(e, format!("chmod {context} {}", path.display())))
}

#[cfg(not(target_os = "linux"))]
fn chmod_dir_fd<Fd: AsFd>(fd: &Fd, path: &Path, mode: u32, context: &str) -> io::Result<()> {
    nix::sys::stat::fchmod(fd, Mode::from_bits_truncate(mode))
        .map_err(|e| io::Error::other(format!("chmod {context} {}: {e}", path.display())))
}

#[cfg(target_os = "linux")]
fn dir_open_flags() -> OFlag {
    OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

#[cfg(not(target_os = "linux"))]
fn dir_open_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

fn dir_component_error(
    operation: &str,
    name: &OsStr,
    full_path: &Path,
    context: &str,
    error: nix::errno::Errno,
) -> io::Error {
    match error {
        nix::errno::Errno::ENOENT => io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "{operation} {context} component {} for {}: {error}",
                name.to_string_lossy(),
                full_path.display()
            ),
        ),
        nix::errno::Errno::ELOOP => permission_denied(format!(
            "{} contains symlink component {}; refusing to use it as {context}",
            full_path.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => permission_denied(format!(
            "{} is not a directory; refusing to use it as {context}",
            full_path.display()
        )),
        _ => io::Error::other(format!(
            "{operation} {context} component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        )),
    }
}

fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn wrap_io(error: io::Error, context: String) -> io::Error {
    io::Error::new(error.kind(), format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::time::Duration;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const RESTRICTIVE_UMASK_CHILD_ENV: &str = "OKOU_RUN_RESTRICTIVE_UMASK_TEST";

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn ensure_dir_preserves_nested_relative_non_utf8_components() {
        let dir = tempfile::tempdir_in(".").unwrap();
        let relative = Path::new(".").join(dir.path().file_name().unwrap());
        let parent = relative.join(OsStr::from_bytes(b"cache-\xff"));
        let path = parent.join("nested/leaf");

        ensure_dir(&path, DirMode::Private, "test cache").unwrap();
        validate_dir(&path, DirMode::Private, "test cache").unwrap();
        let file = path.join("state");
        let mut writer = open_private_append_file(&file, false).unwrap();
        std::io::Write::write_all(&mut writer, b"cached bytes").unwrap();

        assert_eq!(std::fs::read(&file).unwrap(), b"cached bytes");
        assert_eq!(mode(&parent), PRIVATE_DIR_MODE);
        assert_eq!(mode(&parent.join("nested")), PRIVATE_DIR_MODE);
        assert_eq!(mode(&path), PRIVATE_DIR_MODE);
    }

    #[test]
    fn validate_dir_does_not_create_missing_nested_components() {
        let dir = tempfile::tempdir().unwrap();
        for dir_mode in [
            DirMode::Private,
            DirMode::TrustedParent,
            DirMode::SharedTrustedParent,
            DirMode::SharedTrusted,
        ] {
            let error = validate_dir(
                &dir.path().join("missing/child"),
                dir_mode,
                "test directory",
            )
            .unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::NotFound);
            assert!(error.to_string().contains("missing"));
            assert!(!dir.path().join("missing").exists());
        }
    }

    #[test]
    fn ensure_dir_reports_unsafe_nested_component_without_creating_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let unsafe_parent = dir.path().join("safe/writable");
        std::fs::create_dir_all(&unsafe_parent).unwrap();
        std::fs::set_permissions(&unsafe_parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = ensure_dir(
            &unsafe_parent.join("missing/leaf"),
            DirMode::TrustedParent,
            "test cache",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            error.to_string(),
            format!(
                "test cache component {} is group/other writable without the sticky bit",
                unsafe_parent.display()
            )
        );
        assert!(!unsafe_parent.join("missing").exists());
        assert_eq!(mode(&unsafe_parent), 0o777);
    }

    #[test]
    fn ensure_dir_keeps_sticky_intermediate_but_rejects_writable_final_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sticky = dir.path().join("sticky");
        std::fs::create_dir(&sticky).unwrap();
        std::fs::set_permissions(&sticky, std::fs::Permissions::from_mode(0o1777)).unwrap();
        let leaf = sticky.join("shared/leaf");

        ensure_dir(&leaf, DirMode::SharedTrustedParent, "test directory").unwrap();

        assert_eq!(mode(&leaf), SHARED_TRUSTED_DIR_MODE);
        assert_eq!(
            std::fs::metadata(&sticky).unwrap().permissions().mode() & 0o7777,
            0o1777
        );
        let error = validate_dir(&sticky, DirMode::TrustedParent, "test directory").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            error.to_string(),
            format!(
                "test directory {} is group/other writable",
                sticky.display()
            )
        );
    }

    #[tokio::test]
    async fn write_private_new_preserves_existing_files_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.json");
        std::fs::write(&path, b"existing content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        let link = dir.path().join("link.json");
        symlink(&path, &link).unwrap();

        for destination in [&path, &link] {
            let error = write_private_new(destination, b"replacement", "test file")
                .await
                .unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
            assert_eq!(std::fs::read(&path).unwrap(), b"existing content");
            assert_eq!(mode(&path), 0o660);
        }
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
    }

    #[tokio::test]
    async fn write_private_atomic_publishes_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        write_private_atomic(&path, b"new content", "test file")
            .await
            .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new content");
        assert_eq!(mode(&path), PRIVATE_FILE_MODE);
    }

    #[tokio::test]
    async fn write_private_atomic_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, b"old content").unwrap();

        write_private_atomic(&path, b"new content", "test file")
            .await
            .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new content");
    }

    #[tokio::test]
    async fn write_private_atomic_removes_staging_file_after_rename_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).unwrap();

        let error = write_private_atomic(&path, b"content", "test file")
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("rename test file"),
            "unexpected error: {error}"
        );
        let leftover_staging_files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".state.json.") && name.ends_with(".tmp")
            })
            .collect();
        assert!(
            leftover_staging_files.is_empty(),
            "private file staging sibling should be removed after rename failure"
        );
        assert!(path.is_dir());
    }

    #[tokio::test]
    async fn ensure_dir_handles_restrictive_umask() {
        run_ignored_child_test(
            "host_file::tests::ensure_dir_handles_restrictive_umask_child",
            (RESTRICTIVE_UMASK_CHILD_ENV, "1"),
            &[],
            Duration::from_secs(60),
        )
        .await;
    }

    #[test]
    #[ignore]
    fn ensure_dir_handles_restrictive_umask_child() {
        if !ignored_child_test_env_guard_enabled((RESTRICTIVE_UMASK_CHILD_ENV, "1")) {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let _umask = UmaskGuard::set(Mode::from_bits_truncate(0o777));
        for (name, dir_mode) in [
            ("shared-parent", DirMode::SharedTrustedParent),
            ("shared", DirMode::SharedTrusted),
        ] {
            let base = dir.path().join(name);
            let path = base.join("child");

            ensure_dir(&path, dir_mode, "test directory").unwrap();

            assert_eq!(mode(&base), SHARED_TRUSTED_DIR_MODE);
            assert_eq!(mode(&path), SHARED_TRUSTED_DIR_MODE);
        }
    }

    struct UmaskGuard {
        original: Mode,
    }

    impl UmaskGuard {
        fn set(mask: Mode) -> Self {
            Self {
                original: nix::sys::stat::umask(mask),
            }
        }
    }

    impl Drop for UmaskGuard {
        fn drop(&mut self) {
            nix::sys::stat::umask(self.original);
        }
    }

    #[test]
    fn ensure_dir_rejects_private_intermediate_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error =
            ensure_dir(&link.join("child"), DirMode::Private, "test directory").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("child").exists());
    }

    #[test]
    fn ensure_dir_rejects_trusted_parent_intermediate_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_dir(
            &link.join("child"),
            DirMode::TrustedParent,
            "test directory",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("child").exists());
    }

    #[test]
    fn ensure_dir_rejects_private_parent_segment_before_creating_missing_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        std::fs::create_dir(&base).unwrap();

        let error = ensure_dir(
            &base.join("missing").join("..").join("leaf"),
            DirMode::Private,
            "test directory",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!base.join("missing").exists());
        assert!(!base.join("leaf").exists());
    }

    #[test]
    fn ensure_dir_rejects_trusted_parent_parent_segment_before_creating_missing_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        std::fs::create_dir(&base).unwrap();

        let error = ensure_dir(
            &base.join("missing").join("..").join("leaf"),
            DirMode::TrustedParent,
            "test directory",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!base.join("missing").exists());
        assert!(!base.join("leaf").exists());
    }

    #[test]
    fn ensure_dir_creates_shared_trusted_parent_as_shared() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let path = base.join("child");

        ensure_dir(&path, DirMode::SharedTrustedParent, "test directory").unwrap();

        assert_eq!(mode(&base), SHARED_TRUSTED_DIR_MODE);
        assert_eq!(mode(&path), SHARED_TRUSTED_DIR_MODE);
    }

    #[test]
    fn ensure_dir_keeps_existing_shared_trusted_parent_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE)).unwrap();

        ensure_dir(&path, DirMode::SharedTrustedParent, "test directory").unwrap();

        assert_eq!(mode(&path), PRIVATE_DIR_MODE);
    }

    #[test]
    fn ensure_dir_normalizes_existing_shared_trusted_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE)).unwrap();

        ensure_dir(&path, DirMode::SharedTrusted, "test directory").unwrap();

        assert_eq!(mode(&path), SHARED_TRUSTED_DIR_MODE);
    }

    #[test]
    fn ensure_dir_rejects_writable_shared_trusted_final_before_normalizing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = ensure_dir(&path, DirMode::SharedTrusted, "test directory").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(mode(&path), 0o777);
    }

    #[test]
    fn create_dir_component_keeps_eexist_intermediate_mode() {
        let dir = tempfile::tempdir().unwrap();
        let component = dir.path().join("existing");
        std::fs::create_dir(&component).unwrap();
        std::fs::set_permissions(
            &component,
            std::fs::Permissions::from_mode(PRIVATE_DIR_MODE),
        )
        .unwrap();
        let parent = open(dir.path(), dir_open_flags(), Mode::empty()).unwrap();
        let full_path = component.join("child");
        let walk = DirWalk {
            full_path: &full_path,
            mode: DirMode::SharedTrusted,
            context: "test directory",
            expected_uid: nix::unistd::geteuid().as_raw(),
            create_missing: true,
        };

        let component_fd = create_and_open_dir_component(
            &parent,
            Path::new("existing").as_os_str(),
            &component,
            &walk,
            false,
        )
        .unwrap();

        drop(component_fd);
        assert_eq!(mode(&component), PRIVATE_DIR_MODE);
    }

    #[test]
    fn ensure_dir_rejects_shared_trusted_parent_intermediate_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_dir(
            &link.join("child"),
            DirMode::SharedTrustedParent,
            "test directory",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("child").exists());
    }

    #[test]
    fn open_private_append_file_rejects_symlink_parent_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = open_private_append_file(&link.join("log.jsonl"), false).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("log.jsonl").exists());
    }
}
