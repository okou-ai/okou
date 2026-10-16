//! Explicit-workspace mock builds, verified runner sessions and release gates.

use crate::readiness::wait_for_file_contains;
use shell_quote::quote_shell_arg;
use std::ffi::{CString, OsStr};
use std::io;
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct PostOpenMockGate {
    writer: std::fs::File,
    ready_file: PathBuf,
}

impl PostOpenMockGate {
    pub fn create(dir: &Path, mock: &Path) -> Result<(Self, PathBuf), String> {
        let fifo = dir.join("agent-log-mock-start.fifo");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes())
            .map_err(|error| format!("encode mock gate path: {error}"))?;
        // SAFETY: fifo_c is a valid NUL-terminated path and the mode is a
        // normal POSIX permission mask for this test-only FIFO.
        if unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) } != 0 {
            return Err(format!(
                "create mock gate {}: {}",
                fifo.display(),
                io::Error::last_os_error()
            ));
        }

        // Keep both FIFO ends open so release can happen immediately after
        // readiness even if the wrapper has not entered its read yet.
        // SAFETY: fifo_c remains valid for the call and ownership of the
        // returned descriptor transfers to File below.
        let fd = unsafe {
            libc::open(
                fifo_c.as_ptr(),
                libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(format!(
                "open mock gate {}: {}",
                fifo.display(),
                io::Error::last_os_error()
            ));
        }
        // SAFETY: fd is a fresh descriptor owned by this function.
        let writer = unsafe { std::fs::File::from_raw_fd(fd) };

        let ready_file = dir.join("agent-log-mock-ready");
        let wrapper = dir.join("gated-agent-log-mock.sh");
        let script = format!(
            "#!/bin/sh\nprintf 'ready\\n' > {}\nIFS= read -r _ < {}\nexec {} \"$@\"\n",
            quote_shell_arg(&ready_file.to_string_lossy()),
            quote_shell_arg(&fifo.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        );
        std::fs::write(&wrapper, script)
            .map_err(|error| format!("write mock gate wrapper: {error}"))?;
        let mut permissions = std::fs::metadata(&wrapper)
            .map_err(|error| format!("read mock gate wrapper metadata: {error}"))?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&wrapper, permissions)
            .map_err(|error| format!("set mock gate wrapper permissions: {error}"))?;

        Ok((Self { writer, ready_file }, wrapper))
    }

    pub async fn wait_until_ready(&self, timeout: Duration) -> io::Result<()> {
        wait_for_file_contains(&self.ready_file, "ready\n", timeout).await
    }

    pub fn release(&mut self) -> io::Result<()> {
        std::io::Write::write_all(&mut self.writer, b"start\n")
    }
}

/// Build a mock package in an explicit workspace and cache it for one Cargo build session.
pub fn build_and_locate_mock_package_in_workspace(
    workspace_dir: &Path,
    target_profile_dir: &Path,
    package: &str,
    binary: &str,
    build_session: Option<&str>,
) -> Result<PathBuf, String> {
    let target_dir = target_profile_dir
        .parent()
        .ok_or_else(|| "target dir".to_string())?;
    let profile_dir_name = target_profile_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "profile dir name".to_string())?;
    let mock = target_profile_dir.join(binary);
    let marker = target_dir.join(format!(".vm0-{package}-{profile_dir_name}.build-session"));
    let lock = target_dir.join(format!(".vm0-{package}-{profile_dir_name}.lock"));
    let _lock = acquire_mock_build_lock(&lock)?;

    if mock.exists()
        && build_session.is_some()
        && std::fs::read_to_string(&marker).ok().as_deref() == build_session
    {
        return Ok(mock);
    }

    match std::fs::remove_file(&marker) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "remove mock build session {}: {error}",
                marker.display()
            ));
        }
    }

    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "-p", package, "--quiet"])
        .arg("--target-dir")
        .arg(target_dir)
        .current_dir(workspace_dir);
    // Cargo profile → output dir mapping:
    //   --release            → target_dir/release
    //   --profile <name>     → target_dir/<name>
    //   (default / dev)      → target_dir/debug
    // So pick the flag that lands the artifact beside our test binary.
    match profile_dir_name {
        "debug" => {}
        "release" => {
            cmd.arg("--release");
        }
        other => {
            cmd.args(["--profile", other]);
        }
    }

    let status = cmd
        .status()
        .map_err(|e| format!("invoke cargo build: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build -p {package} failed"));
    }
    if !mock.exists() {
        return Err(format!("mock binary not found at {}", mock.display()));
    }
    if let Some(build_session) = build_session {
        std::fs::write(&marker, build_session)
            .map_err(|e| format!("write mock build session: {e}"))?;
    }
    Ok(mock)
}

pub fn acquire_mock_build_lock(lock: &Path) -> Result<std::fs::File, String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)
        .map_err(|e| format!("open mock build lock {}: {e}", lock.display()))?;
    file.lock()
        .map_err(|e| format!("lock mock build file {}: {e}", lock.display()))?;
    Ok(file)
}

/// Resolve a reusable session for direct Cargo or nextest children on Linux.
pub fn test_runner_build_session_id() -> Option<String> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let parent_pid = status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))?
        .trim()
        .parse::<u32>()
        .ok()?;
    let parent_exe = std::fs::read_link(format!("/proc/{parent_pid}/exe")).ok()?;
    let parent_name = parent_exe.file_name()?;
    if parent_name != OsStr::new("cargo") && parent_name != OsStr::new("cargo-nextest") {
        return None;
    }

    let parent_stat = std::fs::read_to_string(format!("/proc/{parent_pid}/stat")).ok()?;
    let fields_after_command = parent_stat.get(parent_stat.rfind(')')? + 1..)?;
    // `starttime` is field 22, or field 20 after the PID and parenthesized command.
    let parent_start_time = fields_after_command
        .split_whitespace()
        .nth(19)?
        .parse::<u64>()
        .ok()?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot_id = boot_id.trim();
    if boot_id.is_empty() {
        return None;
    }

    Some(format!("{boot_id}:{parent_pid}:{parent_start_time}"))
}
