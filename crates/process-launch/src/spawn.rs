//! Fork-like clone3 followed by a strictly prepared, syscall-only child path.
//!
//! This is not libc fork: no allocator, libc setxid coordination, atfork
//! callbacks, Rust unwinding or destructors may run in the copied child.

use std::collections::BTreeMap;
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::time::{Duration, Instant};

use crate::command::set_nofile_limit;
use crate::{Child, Command, Stdio, private_descriptor};

/// Already-resolved child credentials; identity lookup belongs to the caller.
#[derive(Clone, Copy)]
pub struct Credentials<'a> {
    pub uid: libc::uid_t,
    pub gid: libc::gid_t,
    pub groups: &'a [libc::gid_t],
}

/// Child setup that cannot be represented by opaque pre-exec callbacks.
#[derive(Clone, Copy, Default)]
pub struct SpawnOptions<'a> {
    pub credentials: Option<Credentials<'a>>,
    pub deny_process_inspection: bool,
}

const CLONE_CLEAR_SIGHAND: u64 = 1 << 32;
const CLONE_INTO_CGROUP: u64 = 1 << 33;
const CLOSE_RANGE_CLOEXEC: u32 = 1 << 2;
pub(super) const EXEC_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

// Linux UAPI clone_args, including the v2 cgroup field (Linux 5.7).
#[repr(C)]
#[derive(Default)]
struct CloneArguments {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

struct PreparedStdio {
    child: Option<OwnedFd>,
    parent: Option<OwnedFd>,
}

impl PreparedStdio {
    fn new(value: Stdio, input: bool) -> io::Result<Self> {
        match value {
            Stdio::Inherit => Ok(Self {
                child: None,
                parent: None,
            }),
            Stdio::Null => {
                let file = if input {
                    std::fs::OpenOptions::new().read(true).open("/dev/null")?
                } else {
                    std::fs::OpenOptions::new().write(true).open("/dev/null")?
                };
                Ok(Self {
                    child: Some(private_descriptor(file.into())?),
                    parent: None,
                })
            }
            Stdio::Owned(fd) => Ok(Self {
                child: Some(private_descriptor(fd)?),
                parent: None,
            }),
            Stdio::Piped => {
                let (reader, writer) = pipe()?;
                let (child, parent) = if input {
                    (reader, writer)
                } else {
                    (writer, reader)
                };
                Ok(Self {
                    child: Some(child),
                    parent: Some(parent),
                })
            }
        }
    }
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let (reader, writer) = io::pipe()?;
    // Own both descriptors before either fallible normalization.
    let reader: OwnedFd = reader.into();
    let writer: OwnedFd = writer.into();
    Ok((private_descriptor(reader)?, private_descriptor(writer)?))
}

fn cstring(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul byte in process input"))
}

fn executable_paths(
    program: &OsStr,
    environment: &BTreeMap<OsString, OsString>,
) -> io::Result<Vec<CString>> {
    let bytes = program.as_bytes();
    if bytes.contains(&b'/') || bytes.is_empty() {
        return Ok(vec![cstring(program)?]);
    }
    let path = environment
        .get(OsStr::new("PATH"))
        .map(|path| path.as_bytes());
    // The deployed musl execvp default. Explicit/empty PATH still wins.
    let path = path.unwrap_or(b"/usr/local/bin:/bin:/usr/bin");
    path.split(|byte| *byte == b':')
        .map(|directory| {
            let mut candidate = directory.to_vec();
            if !candidate.is_empty() {
                candidate.push(b'/');
            }
            candidate.extend_from_slice(bytes);
            cstring(OsStr::from_bytes(&candidate))
        })
        .collect()
}

pub fn spawn(
    command: Command,
    cgroup: BorrowedFd<'_>,
    options: SpawnOptions<'_>,
) -> io::Result<Child> {
    let pending = spawn_with_admission(command, cgroup, options, (), None)?;
    exec_handshake(
        &pending.error_reader,
        Instant::now() + EXEC_HANDSHAKE_TIMEOUT,
    )?;
    pending.finish()
}

/// Own the unacknowledged child until exec succeeds or cleanup finishes.
///
/// Callers still own resources such as the placement cgroup. On failure or
/// cancellation, reap before returning control so they can release those resources.
pub(super) struct PendingChild {
    child: Option<Child>,
    pub(super) error_reader: File,
}

impl PendingChild {
    pub(super) fn new(child: Child, error_reader: File) -> Self {
        Self {
            child: Some(child),
            error_reader,
        }
    }

    pub(super) fn finish(mut self) -> io::Result<Child> {
        self.child
            .take()
            .ok_or_else(|| io::Error::other("pending child ownership already released"))
    }
}

impl Drop for PendingChild {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = child.kill_and_reap();
        }
    }
}

// Only the parent may release admission. The copied child takes the existing
// non-returning syscall-only branch and never runs this guard's destructor.
pub(super) fn spawn_with_admission<G>(
    command: Command,
    cgroup: BorrowedFd<'_>,
    options: SpawnOptions<'_>,
    admission: G,
    deadline: Option<Instant>,
) -> io::Result<PendingChild> {
    check_deadline(deadline)?;
    let mut environment: BTreeMap<OsString, OsString> = if command.inherit_environment {
        std::env::vars_os().collect()
    } else {
        BTreeMap::new()
    };
    environment.extend(command.environment);
    let paths = executable_paths(&command.program, &environment)?;
    let arguments: Vec<CString> = std::iter::once(&command.program)
        .chain(command.args.iter())
        .map(|value| cstring(value))
        .collect::<io::Result<_>>()?;
    let argv: Vec<_> = arguments
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let environment: Vec<CString> = environment
        .into_iter()
        .map(|(key, value)| {
            if key.as_bytes().contains(&b'=') {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "equals sign in environment key",
                ));
            }
            let mut entry = key.into_encoded_bytes();
            entry.push(b'=');
            entry.extend(value.into_encoded_bytes());
            cstring(OsStr::from_bytes(&entry))
        })
        .collect::<io::Result<_>>()?;
    let envp: Vec<_> = environment
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let directory = command
        .directory
        .as_ref()
        .map(|path| cstring(path.as_os_str()))
        .transpose()?;
    let stdin = PreparedStdio::new(command.stdin, true)?;
    let stdout = PreparedStdio::new(command.stdout, false)?;
    let stderr = PreparedStdio::new(command.stderr, false)?;
    let (error_reader, error_writer) = pipe()?;
    // SAFETY: a zeroed sigaction with SIG_DFL is a valid reset disposition.
    let mut sigpipe: libc::sigaction = unsafe { std::mem::zeroed() };
    sigpipe.sa_sigaction = libc::SIG_DFL;
    let inputs = ChildInputs {
        paths: &paths,
        search_path: !command.program.as_bytes().contains(&b'/') && !command.program.is_empty(),
        argv: &argv,
        envp: &envp,
        directory: directory.as_deref(),
        credentials: options.credentials,
        deny_process_inspection: options.deny_process_inspection,
        nofile_limit: command.nofile_limit,
        stdio: [
            stdin.child.as_ref(),
            stdout.child.as_ref(),
            stderr.child.as_ref(),
        ]
        .map(|fd| fd.map(AsRawFd::as_raw_fd)),
        error_fd: error_writer.as_raw_fd(),
        sigpipe: &sigpipe,
    };
    let arguments = CloneArguments {
        flags: CLONE_INTO_CGROUP | CLONE_CLEAR_SIGHAND,
        exit_signal: libc::SIGCHLD as u64,
        cgroup: cgroup.as_raw_fd() as u64,
        ..CloneArguments::default()
    };
    check_deadline(deadline)?;
    let old_mask = set_signal_mask(u64::MAX)?;
    // SAFETY: without CLONE_VM/FILES/THREAD, the child owns its copied address
    // space, stack and descriptor table. All referenced input is prepared and
    // live. Its branch never returns, allocates, unwinds or calls Rust Drop.
    let pid = unsafe { libc::syscall(libc::SYS_clone3, &arguments, size_of::<CloneArguments>()) };
    if pid == 0 {
        child_exec(&inputs, old_mask);
    }
    let clone_error = (pid < 0).then(io::Error::last_os_error);
    let restore = set_signal_mask(old_mask);
    // Capture errno and restore the parent's signal mask before waking another
    // launch task. The host yields separately while awaiting acknowledgement.
    drop(admission);
    if let Some(error) = clone_error {
        restore?;
        return Err(error);
    }
    let mut child = Child::direct(pid as libc::pid_t);
    child.stdin = stdin.parent.map(Into::into);
    child.stdout = stdout.parent.map(Into::into);
    child.stderr = stderr.parent.map(Into::into);
    drop((stdin.child, stdout.child, stderr.child, error_writer));
    let pending = PendingChild::new(child, File::from(error_reader));
    restore?;
    Ok(pending)
}

fn check_deadline(deadline: Option<Instant>) -> io::Result<()> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process launch timed out before clone3",
        ));
    }
    Ok(())
}

fn set_signal_mask(mask: u64) -> io::Result<u64> {
    let mut old = 0u64;
    // SAFETY: Linux uses a 64-bit kernel signal set on both supported guest
    // architectures. This masks only the calling thread, including libc's
    // reserved signals, which pthread_sigmask deliberately leaves unblocked.
    if unsafe {
        libc::syscall(
            libc::SYS_rt_sigprocmask,
            libc::SIG_SETMASK,
            &mask,
            &mut old,
            size_of::<u64>(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(old)
}

fn exec_handshake(reader: &File, deadline: Instant) -> io::Result<()> {
    let mut poll = libc::pollfd {
        fd: reader.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process exec handshake timed out",
            ));
        }
        let timeout = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: poll points to one initialized descriptor record.
        let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
        if ready == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process exec handshake timed out",
            ));
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        match read_exec_result(reader) {
            Ok(result) => return result.into_result(),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

pub(super) enum ExecResult {
    Success,
    Error(i32),
}

impl ExecResult {
    pub(super) fn into_result(self) -> io::Result<()> {
        match self {
            Self::Success => Ok(()),
            Self::Error(errno) => Err(io::Error::from_raw_os_error(errno)),
        }
    }
}

// Transport errors alone may trigger an I/O retry. An errno reported by the
// child is terminal even when its numeric value is EINTR or EAGAIN.
pub(super) fn read_exec_result(mut reader: &File) -> io::Result<ExecResult> {
    let mut bytes = [0; size_of::<i32>()];
    match reader.read(&mut bytes)? {
        0 => Ok(ExecResult::Success),
        4 => Ok(ExecResult::Error(i32::from_ne_bytes(bytes))),
        _ => Err(io::Error::other("incomplete process exec error")),
    }
}

struct ChildInputs<'a> {
    paths: &'a [CString],
    search_path: bool,
    argv: &'a [*const libc::c_char],
    envp: &'a [*const libc::c_char],
    directory: Option<&'a CStr>,
    credentials: Option<Credentials<'a>>,
    deny_process_inspection: bool,
    nofile_limit: Option<libc::rlim_t>,
    stdio: [Option<RawFd>; 3],
    error_fd: RawFd,
    sigpipe: &'a libc::sigaction,
}

fn child_exec(inputs: &ChildInputs<'_>, old_mask: u64) -> ! {
    // SAFETY: exclusive copied-child path. Every pointer refers to immutable
    // parent-prepared storage. All called operations are raw syscalls or
    // async-signal-safe sigaction; no libc threaded credential coordination.
    unsafe {
        if libc::syscall(libc::SYS_setpgid, 0, 0) != 0 {
            child_errno(inputs.error_fd);
        }
        for (target, source) in inputs.stdio.iter().enumerate() {
            if let Some(source) = source
                && libc::syscall(libc::SYS_dup3, *source, target as RawFd, 0) < 0
            {
                child_errno(inputs.error_fd);
            }
        }
        if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) != 0 {
            child_errno(inputs.error_fd);
        }
        if let Some(limit) = inputs.nofile_limit
            && set_nofile_limit(limit) != 0
        {
            child_errno(inputs.error_fd);
        }
        if let Some(credentials) = inputs.credentials
            && (libc::syscall(
                libc::SYS_setgroups,
                credentials.groups.len(),
                credentials.groups.as_ptr(),
            ) != 0
                || libc::syscall(libc::SYS_setgid, credentials.gid) != 0
                || libc::syscall(libc::SYS_setuid, credentials.uid) != 0)
        {
            child_errno(inputs.error_fd);
        }
        if let Some(directory) = inputs.directory
            && libc::syscall(libc::SYS_chdir, directory.as_ptr()) != 0
        {
            child_errno(inputs.error_fd);
        }
        // setuid can reset dumpability, so preserve the existing ordering.
        if inputs.deny_process_inspection
            && libc::syscall(libc::SYS_prctl, libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
        {
            child_errno(inputs.error_fd);
        }
        if libc::sigaction(libc::SIGPIPE, inputs.sigpipe, std::ptr::null_mut()) != 0
            || libc::syscall(
                libc::SYS_rt_sigprocmask,
                libc::SIG_SETMASK,
                &old_mask,
                std::ptr::null_mut::<u64>(),
                size_of::<u64>(),
            ) != 0
        {
            child_errno(inputs.error_fd);
        }
        let mut missing_error = libc::ENOENT;
        for path in inputs.paths {
            libc::syscall(
                libc::SYS_execve,
                path.as_ptr(),
                inputs.argv.as_ptr(),
                inputs.envp.as_ptr(),
            );
            let error = *libc::__errno_location();
            if !inputs.search_path {
                child_error(inputs.error_fd, error);
            }
            match error {
                libc::EACCES => missing_error = error,
                libc::ENOENT | libc::ENOTDIR => {}
                _ => child_error(inputs.error_fd, error),
            }
        }
        child_error(inputs.error_fd, missing_error);
    }
}

fn child_errno(error_fd: RawFd) -> ! {
    // SAFETY: errno is copied thread-local scalar state, not a libc lock.
    child_error(error_fd, unsafe { *libc::__errno_location() });
}

fn child_error(error_fd: RawFd, error: i32) -> ! {
    // SAFETY: this empty CLOEXEC pipe has exactly one child writer. The
    // four-byte write is atomic. _exit never runs parent-owned destructors.
    unsafe {
        loop {
            if libc::syscall(libc::SYS_write, error_fd, &error, size_of::<i32>()) >= 0
                || *libc::__errno_location() != libc::EINTR
            {
                break;
            }
        }
        libc::_exit(127);
    }
}

#[cfg(test)]
mod tests;
