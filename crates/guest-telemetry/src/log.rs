//! Structured guest logging utilities for VM scripts.
//!
//! Logging macros always emit one structured line to stderr. When an embedding
//! runtime has installed a guest system log with [`set_system_log_file`], they
//! synchronously attempt to append the same line before returning.
//! Without a configured system log, logging falls back to stderr-only behavior.
//! System log append failures are reported to stderr and do not suppress the
//! original stderr line.
//! The configured file sink is process-global and shared by every thread. Tests
//! and other callers that replace or clear it must coordinate exclusive ownership.
//!
//! Embedding runtimes may persist or upload the configured system log; this
//! module only owns the local logging sinks.

use std::fs::File;
use std::io::{self, IoSlice, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static SYSTEM_LOG: Mutex<SystemLogState> = Mutex::new(SystemLogState::disabled());

/// Process-global guest system log state.
///
/// The cached handle is dropped on every path update, including same-path
/// updates, so callers can force a reopen if the path was externally replaced.
struct SystemLogState {
    path: Option<PathBuf>,
    file: Option<File>,
}

impl SystemLogState {
    const fn disabled() -> Self {
        Self {
            path: None,
            file: None,
        }
    }

    fn set_path(&mut self, path: PathBuf) {
        self.path = Some(path);
        self.file = None;
    }

    fn clear(&mut self) {
        self.path = None;
        self.file = None;
    }

    fn append_line(&mut self, line: &str) -> std::io::Result<()> {
        let Some(path) = self.path.as_ref() else {
            return Ok(());
        };

        let file = match self.file.as_mut() {
            Some(file) => file,
            None => {
                let file = open_system_log_file(path)?;
                self.file.insert(file)
            }
        };

        let result = write_line_with_newline(file, line).and_then(|()| file.flush());

        if result.is_err() {
            self.file = None;
        }

        result
    }
}

fn write_line_with_newline(writer: &mut impl Write, line: &str) -> io::Result<()> {
    let mut bufs = [IoSlice::new(line.as_bytes()), IoSlice::new(b"\n")];
    let mut bufs = &mut bufs[..];

    while !bufs.is_empty() {
        let written = match writer.write_vectored(bufs) {
            Ok(written) => written,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "failed to write system log line",
            ));
        }

        IoSlice::advance_slices(&mut bufs, written);
    }

    Ok(())
}

fn open_system_log_file(path: &Path) -> std::io::Result<File> {
    guest_contracts::runtime_paths::open_private_append(path)
        .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", path.display())))
}

/// Get current timestamp in RFC3339 format with milliseconds.
pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Override the process-global system log file used by future log lines.
///
/// The selected path and cached handle are shared by every thread. A later call
/// replaces the selected path. Tests and other callers that replace or clear it
/// must coordinate exclusive ownership of the shared state.
///
/// Updating this path drops any cached file handle, including same-path
/// updates. This lets callers force the next write to reopen the path.
///
/// The file is still opened lazily by the next log line. System log append
/// attempts are synchronous and finish before the logging macro returns. This
/// matters for guest-agent's final telemetry upload, which reads the same file
/// immediately after some fatal-path log lines are emitted.
pub fn set_system_log_file(path: impl AsRef<Path>) {
    let mut guard = SYSTEM_LOG.lock().unwrap_or_else(|e| e.into_inner());
    guard.set_path(path.as_ref().to_path_buf());
}

#[doc(hidden)]
pub fn clear_system_log_file() {
    let mut guard = SYSTEM_LOG.lock().unwrap_or_else(|e| e.into_inner());
    guard.clear();
}

fn append_system_log_line(line: &str) -> std::io::Result<()> {
    let mut guard = SYSTEM_LOG.lock().unwrap_or_else(|e| e.into_inner());
    guard.append_line(line)
}

fn write_stderr_line(line: &str) {
    use std::io::Write;
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(line.as_bytes());
    let _ = stderr.write_all(b"\n");
    let _ = stderr.flush();
}

/// Emit one formatted log line to stderr and attempt to append it to the
/// configured guest-side system log.
pub fn emit(level: &str, tag: &str, args: std::fmt::Arguments<'_>) {
    let line = format!("[{}] [{level}] [{tag}] {args}", timestamp());
    if let Err(e) = append_system_log_line(&line) {
        write_stderr_line(&format!(
            "[{}] [WARN] [sandbox:guest-telemetry] failed to append system log: {e}",
            timestamp()
        ));
    }
    write_stderr_line(&line);
}

/// Log an info message to stderr and attempt to append it to the configured
/// guest system log.
///
/// If no guest system log has been installed with
/// [`crate::log::set_system_log_file`], the message is emitted to stderr only.
#[macro_export]
macro_rules! log_info {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::emit("INFO", $tag, format_args!($($arg)*))
    };
}

/// Log a warning message to stderr and attempt to append it to the configured
/// guest system log.
///
/// If no guest system log has been installed with
/// [`crate::log::set_system_log_file`], the message is emitted to stderr only.
#[macro_export]
macro_rules! log_warn {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::emit("WARN", $tag, format_args!($($arg)*))
    };
}

/// Log an error message to stderr and attempt to append it to the configured
/// guest system log.
///
/// If no guest system log has been installed with
/// [`crate::log::set_system_log_file`], the message is emitted to stderr only.
#[macro_export]
macro_rules! log_error {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::emit("ERROR", $tag, format_args!($($arg)*))
    };
}

#[cfg(test)]
mod tests;
