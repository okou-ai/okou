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
mod tests {
    use super::*;
    use std::collections::HashSet;

    static LOG_TEST_MUTEX: Mutex<()> = Mutex::new(());

    struct SystemLogFileGuard;

    impl SystemLogFileGuard {
        fn set(path: impl AsRef<Path>) -> Self {
            set_system_log_file(path);
            Self
        }
    }

    impl Drop for SystemLogFileGuard {
        fn drop(&mut self) {
            clear_system_log_file();
        }
    }

    #[test]
    fn timestamp_is_rfc3339() {
        let ts = timestamp();
        // RFC3339 with millis: "2026-01-01T00:00:00.000Z"
        assert!(ts.ends_with('Z'), "timestamp should end with Z: {ts}");
        assert!(ts.contains('T'), "timestamp should contain T: {ts}");
        assert_eq!(ts.len(), 24, "unexpected timestamp length: {ts}");
        // Verify it parses as a valid datetime
        assert!(
            chrono::DateTime::parse_from_rfc3339(&ts).is_ok(),
            "not a valid RFC3339: {ts}"
        );
    }

    #[test]
    fn emit_does_not_require_system_log_when_file_logging_is_disabled() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        clear_system_log_file();

        emit(
            "INFO",
            "sandbox:guest-agent",
            format_args!("stderr-only log line"),
        );
    }

    #[test]
    fn emit_does_not_write_previous_path_when_file_logging_is_disabled() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        let _system_log = SystemLogFileGuard::set(&path);
        clear_system_log_file();

        emit(
            "INFO",
            "sandbox:guest-agent",
            format_args!("stderr-only after clearing system log"),
        );

        assert!(
            !path.exists(),
            "disabled system log should not write to previous path",
        );
    }

    #[test]
    fn emit_appends_to_configured_system_log_file() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        let _system_log = SystemLogFileGuard::set(&path);

        emit(
            "WARN",
            "sandbox:guest-agent",
            format_args!("Tool timeout {}", "WebFetch"),
        );

        let content = std::fs::read_to_string(path).unwrap();
        assert!(
            content.contains("[WARN] [sandbox:guest-agent] Tool timeout WebFetch"),
            "unexpected content: {content:?}"
        );
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn emit_appends_to_existing_system_log_file_without_truncating() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        std::fs::write(&path, "existing line\n").unwrap();
        let _system_log = SystemLogFileGuard::set(&path);

        emit(
            "INFO",
            "sandbox:guest-agent",
            format_args!("new line after existing content"),
        );

        let content = std::fs::read_to_string(path).unwrap();
        assert!(
            content.starts_with("existing line\n"),
            "existing content should be preserved: {content:?}",
        );
        assert!(
            content.contains("[INFO] [sandbox:guest-agent] new line after existing content"),
            "new log line should be appended: {content:?}",
        );
    }

    #[test]
    fn set_system_log_file_switches_paths_and_drops_cached_handle() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.log");
        let second_path = dir.path().join("second.log");
        let _system_log = SystemLogFileGuard::set(&first_path);

        append_system_log_line("first path line").unwrap();
        set_system_log_file(&second_path);
        append_system_log_line("second path line").unwrap();

        let first_content = std::fs::read_to_string(first_path).unwrap();
        let second_content = std::fs::read_to_string(second_path).unwrap();
        assert_eq!(first_content, "first path line\n");
        assert_eq!(second_content, "second path line\n");
    }

    #[test]
    fn set_system_log_file_switches_unopened_path_without_creating_old_file() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.log");
        let second_path = dir.path().join("second.log");
        let _system_log = SystemLogFileGuard::set(&first_path);

        set_system_log_file(&second_path);
        append_system_log_line("final path line").unwrap();

        assert!(
            !first_path.exists(),
            "path updates before first append should not create the old path",
        );
        let second_content = std::fs::read_to_string(second_path).unwrap();
        assert_eq!(second_content, "final path line\n");
    }

    #[test]
    fn setting_same_system_log_file_path_forces_reopen() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        let _system_log = SystemLogFileGuard::set(&path);

        append_system_log_line("before removal").unwrap();
        std::fs::remove_file(&path).unwrap();

        set_system_log_file(&path);
        append_system_log_line("after reopen").unwrap();

        let content = std::fs::read_to_string(path).unwrap();
        assert_eq!(content, "after reopen\n");
    }

    #[test]
    fn clear_system_log_file_drops_cached_handle() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        let _system_log = SystemLogFileGuard::set(&path);

        append_system_log_line("before clear").unwrap();
        clear_system_log_file();
        std::fs::remove_file(&path).unwrap();
        append_system_log_line("after clear").unwrap();

        assert!(
            !path.exists(),
            "cleared system log should not recreate the previous path",
        );
    }

    #[test]
    fn transient_open_failure_is_not_cached() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("parent-file");
        std::fs::write(&parent, "not a directory").unwrap();
        let path = parent.join("system.log");
        let _system_log = SystemLogFileGuard::set(&path);

        let error = append_system_log_line("before parent exists").unwrap_err();
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::NotADirectory
            ),
            "unexpected error kind: {error:?}",
        );

        std::fs::remove_file(&parent).unwrap();
        std::fs::create_dir(&parent).unwrap();
        append_system_log_line("after parent exists").unwrap();

        let content = std::fs::read_to_string(path).unwrap();
        assert_eq!(content, "after parent exists\n");
    }

    #[test]
    fn cached_handle_write_failure_reopens_on_next_append() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        std::fs::write(&path, "").unwrap();
        let read_only_file = File::open(&path).unwrap();
        let mut state = SystemLogState {
            path: Some(path.clone()),
            file: Some(read_only_file),
        };

        assert!(state.append_line("fails").is_err());

        state.append_line("recovers").unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert_eq!(content, "recovers\n");
    }

    struct InterruptedPartialWriter {
        output: Vec<u8>,
        interrupt_next_write: bool,
        max_write_size: usize,
    }

    impl Write for InterruptedPartialWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.write_vectored(&[IoSlice::new(buf)])
        }

        fn write_vectored(&mut self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
            if self.interrupt_next_write {
                self.interrupt_next_write = false;
                return Err(io::ErrorKind::Interrupted.into());
            }

            let mut written = 0usize;
            for buf in bufs {
                if written == self.max_write_size {
                    break;
                }
                let remaining = self.max_write_size - written;
                let take = remaining.min(buf.len());
                self.output.extend(buf.iter().take(take).copied());
                written += take;
            }
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_line_with_newline_retries_interrupted_partial_writes() {
        let mut writer = InterruptedPartialWriter {
            output: Vec::new(),
            interrupt_next_write: true,
            max_write_size: 3,
        };

        write_line_with_newline(&mut writer, "abcdef").unwrap();

        assert_eq!(writer.output, b"abcdef\n");
    }

    #[test]
    fn write_line_with_newline_errors_on_write_zero() {
        let mut writer = InterruptedPartialWriter {
            output: Vec::new(),
            interrupt_next_write: false,
            max_write_size: 0,
        };

        let error = write_line_with_newline(&mut writer, "line").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::WriteZero);
        assert!(writer.output.is_empty());
    }

    #[test]
    fn write_line_with_newline_preserves_empty_line() {
        let mut writer = InterruptedPartialWriter {
            output: Vec::new(),
            interrupt_next_write: false,
            max_write_size: 8,
        };

        write_line_with_newline(&mut writer, "").unwrap();

        assert_eq!(writer.output, b"\n");
    }

    #[test]
    fn emit_appends_complete_lines_concurrently() {
        let _guard = LOG_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        let _system_log = SystemLogFileGuard::set(&path);

        let handles: Vec<_> = (0..8)
            .map(|thread_id| {
                std::thread::spawn(move || {
                    for line_id in 0..20 {
                        append_system_log_line(&format!(
                            "[timestamp] [INFO] [sandbox:guest-agent] concurrent {thread_id}-{line_id}"
                        ))
                        .unwrap();
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }

        let content = std::fs::read_to_string(path).unwrap();
        let lines: Vec<_> = content.lines().collect();
        let expected: HashSet<_> = (0..8)
            .flat_map(|thread_id| {
                (0..20).map(move |line_id| {
                    format!(
                        "[timestamp] [INFO] [sandbox:guest-agent] concurrent {thread_id}-{line_id}"
                    )
                })
            })
            .collect();
        let actual: HashSet<_> = lines.iter().map(|line| (*line).to_owned()).collect();
        assert_eq!(lines.len(), 160);
        assert_eq!(actual, expected);
        assert!(content.ends_with('\n'));
    }
}
