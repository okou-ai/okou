//! Immutable mount inputs prepared before either copied-child launch path.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

pub(crate) struct PrivateMountNamespace {
    stale_targets: Vec<CString>,
    binds: Vec<(CString, CString)>,
}

impl PrivateMountNamespace {
    pub(crate) fn prepare(stale_targets: &[&Path], binds: &[(&Path, &Path)]) -> io::Result<Self> {
        fn path(path: &Path) -> io::Result<CString> {
            CString::new(path.as_os_str().as_bytes()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "nul byte in mount namespace path",
                )
            })
        }

        Ok(Self {
            stale_targets: stale_targets
                .iter()
                .map(|target| path(target))
                .collect::<io::Result<_>>()?,
            binds: binds
                .iter()
                .map(|(source, target)| Ok((path(source)?, path(target)?)))
                .collect::<io::Result<_>>()?,
        })
    }

    /// Return the raw syscall status, leaving errno intact on failure.
    ///
    /// Called only in the child after cwd/credentials setup. All paths and
    /// iteration storage belong to the parent-prepared copied address space.
    /// No allocation, lock, formatting, unwinding or destructor may run here.
    pub(crate) fn apply(&self) -> libc::c_long {
        // SAFETY: these syscalls only read live immutable C strings. A failed
        // setup is followed by the launch owner's error transport and _exit.
        unsafe {
            if libc::syscall(libc::SYS_unshare, libc::CLONE_NEWNS) != 0 {
                return -1;
            }
            if libc::syscall(
                libc::SYS_mount,
                std::ptr::null::<libc::c_char>(),
                c"/".as_ptr(),
                std::ptr::null::<libc::c_char>(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null::<libc::c_void>(),
            ) != 0
            {
                return -1;
            }
            // A missing or busy inherited mount must not stop the remaining
            // stale attempts. Bind failures below remain terminal.
            for target in &self.stale_targets {
                libc::syscall(libc::SYS_umount2, target.as_ptr(), 0);
            }
            for (source, target) in &self.binds {
                if libc::syscall(
                    libc::SYS_mount,
                    source.as_ptr(),
                    target.as_ptr(),
                    std::ptr::null::<libc::c_char>(),
                    libc::MS_BIND,
                    std::ptr::null::<libc::c_void>(),
                ) != 0
                {
                    return -1;
                }
            }
        }
        0
    }
}
