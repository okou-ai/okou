use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use ::sandbox::{Result, SandboxError, SandboxOperation, SandboxOperationReason};

pub(crate) const MOCK_COPY_FILE_MAX_BYTES: u64 = 128 * 1024 * 1024;

/// Ignore mutex poisoning and take the lock anyway.
///
/// Callers here are test doubles; surfacing a poison error would appear as
/// a spurious test failure rather than a real issue to propagate.
pub(crate) trait LockIgnoringPoison<T> {
    fn lock_ignoring_poison(&self) -> MutexGuard<'_, T>;
}

impl<T> LockIgnoringPoison<T> for Mutex<T> {
    fn lock_ignoring_poison(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn mock_file_operation_error(
    operation: SandboxOperation,
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::Operation {
        operation,
        reason: SandboxOperationReason::Other,
        message: message.into(),
    }
}

fn mock_copy_file_error(message: impl Into<String>) -> SandboxError {
    mock_file_operation_error(SandboxOperation::CopyFile, message)
}

pub(crate) fn validate_mock_guest_file_path(
    operation: SandboxOperation,
    operation_name: &str,
    path: &str,
) -> Result<()> {
    if path.is_empty() {
        return Err(mock_file_operation_error(
            operation,
            format!("mock {operation_name} guest file path must not be empty"),
        ));
    }
    if path.as_bytes().contains(&0) {
        return Err(mock_file_operation_error(
            operation,
            format!("mock {operation_name} guest file path contains NUL bytes"),
        ));
    }
    Ok(())
}

pub(crate) fn validate_mock_copy_host_path(host_path: &Path) -> Result<()> {
    let path_text = host_path.as_os_str().to_string_lossy();
    if path_text.is_empty() {
        return Err(mock_copy_file_error(
            "mock copy_file host path must not be empty",
        ));
    }
    if path_text.contains('\0') {
        return Err(mock_copy_file_error(
            "mock copy_file host path contains NUL bytes",
        ));
    }
    if host_path.file_name().is_none() || path_text.ends_with('/') || path_text.ends_with("/.") {
        return Err(mock_copy_file_error(
            "mock copy_file host path must name a file",
        ));
    }
    Ok(())
}
