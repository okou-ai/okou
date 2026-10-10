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
    let mut start = error.len() - max_bytes;
    while !error.is_char_boundary(start) {
        start += 1;
    }
    Some(&error[start..])
}

#[cfg(test)]
mod tests {
    #[test]
    fn bounded_error_tail_preserves_short_text_and_byte_budget() {
        assert_eq!(super::bounded_error_tail("short", 5), None);
        assert_eq!(super::bounded_error_tail("prefix-cause", 5), Some("cause"));
        assert_eq!(super::bounded_error_tail("nonempty", 0), Some(""));
        assert_eq!(super::bounded_error_tail("", 0), None);
    }

    #[test]
    fn bounded_error_tail_never_splits_utf8_or_exceeds_limit() {
        let text = "prefix🦀cause";
        for limit in 0..text.len() {
            let tail = super::bounded_error_tail(text, limit).unwrap();
            assert!(tail.len() <= limit);
            assert!(text.ends_with(tail));
        }
        assert_eq!(super::bounded_error_tail("🦀", 3), Some(""));
    }

    use std::io::Write;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::Path;

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn ensure_log_dir_tightens_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = dir.path().join("logs");
        std::fs::create_dir(&log_dir).unwrap();
        std::fs::set_permissions(&log_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_log_dir(&log_dir).unwrap();

        assert_eq!(mode(&log_dir), 0o700);
    }

    #[test]
    fn ensure_log_dir_rejects_unsafe_parent_without_creating_dir() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("unsafe");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
        let log_dir = parent.join("logs");

        let error = ensure_log_dir(&log_dir).unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(!log_dir.exists());
    }

    #[test]
    fn open_append_creates_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");

        let mut file = open_append(&path, false).unwrap();
        file.write_all(b"line\n").unwrap();

        assert_eq!(mode(&path), 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"line\n");
    }

    #[test]
    fn open_append_rejects_symlink_destination() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.log");
        let path = dir.path().join("network.jsonl");
        symlink(&target, &path).unwrap();

        let error = open_append(&path, false).unwrap_err();

        assert!(
            error.to_string().contains("open log file"),
            "unexpected error: {error}"
        );
        assert!(!target.exists());
    }

    #[test]
    fn open_append_rejects_fifo_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();

        let error = open_append(&path, false).unwrap_err();

        assert!(
            error.to_string().contains("open log file")
                || error.to_string().contains("regular log file"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn validate_copy_destination_rejects_directory_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.log");
        std::fs::create_dir(&path).unwrap();

        let error = validate_copy_destination(&path).unwrap_err();

        assert!(
            error.to_string().contains("open guest log destination"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn open_append_rejects_unsafe_parent_without_creating_file() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("unsafe");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
        let path = parent.join("network.jsonl");

        let error = open_append(&path, false).unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(!path.exists());
    }
}
