//! Telemetry recording for sandbox operations.
//!
//! The configured log destination is process-global and shared by every thread.
//! Embedding runtimes should install it during process bootstrap. Tests and
//! other callers that replace or clear it must coordinate exclusive ownership.

use crate::log;
use serde::Serialize;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};

static SANDBOX_OPS_APPEND_LOCK: Mutex<()> = Mutex::new(());
static SANDBOX_OPS_LOG_OVERRIDE: Mutex<Option<Arc<SandboxOpsSink>>> = Mutex::new(None);

/// Configured sandbox-operation destination and its lazily opened append file.
///
/// The cached handle is dropped with the sink. Installing a path, including the
/// same path again, creates a new sink so callers can force a reopen after an
/// external pathname replacement.
struct SandboxOpsSink {
    path: PathBuf,
    startup_path: Option<guest_contracts::sandbox_startup::SandboxStartupPath>,
    file: Mutex<Option<File>>,
}

impl SandboxOpsSink {
    fn new(
        path: PathBuf,
        startup_path: Option<guest_contracts::sandbox_startup::SandboxStartupPath>,
    ) -> Self {
        Self {
            path,
            startup_path,
            file: Mutex::new(None),
        }
    }

    fn append_record(&self, record: &[u8]) -> io::Result<()> {
        let mut file_state = self.file.lock().unwrap_or_else(|e| e.into_inner());
        let file = match file_state.as_mut() {
            Some(file) => file,
            None => file_state.insert(guest_contracts::runtime_paths::open_private_append(
                &self.path,
            )?),
        };

        let result = append_sandbox_op_record(file, record);
        if result.is_err() {
            *file_state = None;
        }
        result
    }
}

/// Set the process-global sandbox operations log path.
///
/// The selected path is shared by every thread. A later call replaces it for
/// `record_sandbox_op` calls that have not yet captured a destination. Records
/// already in progress may still append to the path they captured.
///
/// The file is opened lazily by the first record and retained by the configured
/// sink. Installing any path, including the currently selected path, creates a
/// new sink and forces future records to reopen it. A previous handle is dropped
/// after records that already captured its sink finish.
///
/// This is not a scoped override. Tests and other callers that replace or clear
/// the path must coordinate exclusive ownership of the shared state.
pub fn set_sandbox_ops_log_file(path: impl AsRef<Path>) {
    set_sandbox_ops_log_file_with_startup_path(path, None);
}

/// Install the captured startup resource with the process-owned operation sink.
pub fn set_sandbox_ops_log_file_with_startup_path(
    path: impl AsRef<Path>,
    startup_path: Option<guest_contracts::sandbox_startup::SandboxStartupPath>,
) {
    let mut state = SANDBOX_OPS_LOG_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state = Some(Arc::new(SandboxOpsSink::new(
        path.as_ref().to_path_buf(),
        startup_path,
    )));
}

/// Clear the process-global sandbox operations log path.
///
/// This disables recording for calls that have not yet captured a destination.
/// It does not restore a path installed by an earlier setter, and records
/// already in progress may still append to the path they captured.
///
/// Clearing releases the retained file after records that already captured its
/// sink finish.
///
/// Tests and other callers that replace or clear the path must coordinate
/// exclusive ownership of the shared state.
pub fn clear_sandbox_ops_log_file() {
    let mut state = SANDBOX_OPS_LOG_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state = None;
}

fn configured_sandbox_ops_log() -> Option<Arc<SandboxOpsSink>> {
    SANDBOX_OPS_LOG_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[cfg(unix)]
struct FileLockGuard {
    fd: RawFd,
}

#[cfg(unix)]
impl FileLockGuard {
    fn lock(file: &File) -> io::Result<Self> {
        let fd = file.as_raw_fd();
        flock_fd(fd, libc::LOCK_EX)?;
        Ok(Self { fd })
    }
}

#[cfg(unix)]
impl Drop for FileLockGuard {
    fn drop(&mut self) {
        let _ = flock_fd(self.fd, libc::LOCK_UN);
    }
}

#[cfg(unix)]
fn flock_fd(fd: RawFd, operation: libc::c_int) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is borrowed from an open `File`, and `flock` does not
        // mutate Rust memory. The caller owns the descriptor for the lock's
        // lifetime.
        let result = unsafe { libc::flock(fd, operation) };
        if result == 0 {
            return Ok(());
        }

        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
}

#[cfg(not(unix))]
struct FileLockGuard;

#[cfg(not(unix))]
impl FileLockGuard {
    fn lock(_file: &File) -> io::Result<Self> {
        Ok(Self)
    }
}

#[derive(Serialize)]
struct SandboxOpEntry {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_startup_path: Option<guest_contracts::sandbox_startup::SandboxStartupPath>,
}

/// Optional low-cardinality dimensions for a sandbox operation.
#[derive(Clone, Copy, Debug, Default)]
pub struct SandboxOpDimensions<'a> {
    /// Bounded result classification for the operation.
    pub outcome: Option<&'a str>,
    /// Bounded content-free explanation for the result.
    pub reason: Option<&'a str>,
}

/// Record a sandbox operation to the telemetry log on a best-effort basis.
///
/// Each call snapshots the process-global destination before serialization and
/// append. A setter or clear that overlaps after the snapshot does not reroute
/// that record; it may still finish on the previous path.
///
/// This helper is non-fatal: it no-ops when no explicit log path is configured.
/// Serialization or append/open/lock/write failures are not propagated to the
/// caller. Guest operations should not treat a successful return from this
/// function as proof that a telemetry entry was written.
///
/// A configured sink opens its append file lazily and reuses it across records.
/// An append-path failure drops the retained handle so a later record retries
/// the secure open.
///
/// Each JSONL entry contains `ts`, `action_type`, `duration_ms`, `success`, and
/// optional `error`, `outcome`, and `reason` fields. The format is compatible
/// with the TypeScript version for consistency.
pub fn record_sandbox_op(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
) {
    record_sandbox_op_with_dimensions(
        action_type,
        duration,
        success,
        error,
        SandboxOpDimensions::default(),
    );
}

/// Record a sandbox operation with optional low-cardinality dimensions.
///
/// This has the same best-effort behavior as [`record_sandbox_op`]. Callers
/// must provide only bounded, content-free values suitable for log dimensions.
pub fn record_sandbox_op_with_dimensions(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
    dimensions: SandboxOpDimensions<'_>,
) {
    let Some(sink) = configured_sandbox_ops_log() else {
        return;
    };

    let entry = SandboxOpEntry {
        ts: log::timestamp(),
        action_type: action_type.to_string(),
        duration_ms: duration_ms(duration),
        success,
        error: error.map(String::from),
        outcome: dimensions.outcome.map(String::from),
        reason: dimensions.reason.map(String::from),
        runner_startup_path: sink.startup_path,
    };

    let Ok(mut record) = serde_json::to_vec(&entry) else {
        return;
    };
    record.push(b'\n');

    let _ = sink.append_record(&record);
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn append_sandbox_op_record(file: &mut File, record: &[u8]) -> io::Result<()> {
    let _append_guard = SANDBOX_OPS_APPEND_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _file_lock = FileLockGuard::lock(file)?;

    file.write_all(record)
}

#[cfg(test)]
mod tests;
