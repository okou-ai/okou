//! Host log directory and private-file helpers.
//!
//! [`ensure_log_dir`] creates a private directory, while [`open_append`] and
//! [`validate_copy_destination`] require an existing trusted parent. Directory
//! traversal, symlink, ownership and trust checks follow [`crate::host_file`].
//!
//! Log files must be regular files owned by the effective uid. Group/other-writable
//! files are rejected; otherwise accepted permissions are normalized to `0600`
//! through the opened file descriptor.

use std::io;
use std::path::Path;

use crate::host_file::{self, DirMode};

/// Create and validate a private log directory using [`DirMode::Private`].
///
/// Missing directory components are created as `0700`. The final directory must
/// be owned by the effective uid, and its permissions are normalized to `0700`,
/// including when it already exists.
///
/// # Errors
///
/// Returns an error for invalid, symlinked or untrusted directory paths, a final
/// directory with the wrong owner, or filesystem creation/permission failures.
pub fn ensure_log_dir(path: &Path) -> io::Result<()> {
    host_file::ensure_dir(path, DirMode::Private, "log directory")
}

/// Open or create a private log file for appending without truncating it.
///
/// The parent must already exist and satisfy [`DirMode::TrustedParent`]. When
/// `read` is `true`, the handle also permits reading; otherwise it is write-only.
/// The file is opened with no-follow, nonblocking and close-on-exec flags and
/// checked against this module's private-file policy, normalizing its mode to
/// `0600` for both new and otherwise accepted existing files.
///
/// # Errors
///
/// Returns an error for a missing or untrusted parent, a symlink or nonregular
/// target, a file with the wrong owner or group/other-write permissions, or
/// filesystem open/permission failures.
pub fn open_append(path: &Path, read: bool) -> io::Result<std::fs::File> {
    host_file::open_private_append_file(path, read)
}

/// Validate a host destination before a separate guest-log copy.
///
/// The parent must already exist and satisfy [`DirMode::TrustedParent`]. An
/// absent target is accepted without creating it. An existing target is opened
/// for reading and writing without truncation and checked against this module's
/// private-file policy; this may change its permissions to `0600` even if no
/// subsequent copy occurs.
///
/// This is not a read-only check. It neither copies data nor atomically reserves
/// the destination: success does not guarantee the path remains safe for a later
/// copy, which is the caller's responsibility.
///
/// # Errors
///
/// Returns an error for a missing or untrusted parent, a symlink or nonregular
/// target, a file with the wrong owner or group/other-write permissions, or
/// filesystem open/permission failures (including insufficient read/write access).
pub fn validate_copy_destination(path: &Path) -> io::Result<()> {
    host_file::validate_private_file_destination(path, "guest log destination")
}

/// Borrow a UTF-8-safe suffix only when text exceeds the caller's byte budget.
/// The caller owns field policy; this primitive never formats or allocates.
pub fn bounded_error_tail(error: &str, max_bytes: usize) -> Option<&str> {
    if error.len() <= max_bytes {
        return None;
    }
    let start = error.ceil_char_boundary(error.len() - max_bytes);
    Some(&error[start..])
}

#[cfg(test)]
mod tests;
