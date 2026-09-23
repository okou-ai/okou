use std::io;
use std::path::Path;

use crate::host_file::{self, DirMode};

pub fn ensure_log_dir(path: &Path) -> io::Result<()> {
    host_file::ensure_dir(path, DirMode::Private, "log directory")
}

pub fn open_append(path: &Path, read: bool) -> io::Result<std::fs::File> {
    host_file::open_private_append_file(path, read)
}

pub fn validate_copy_destination(path: &Path) -> io::Result<()> {
    host_file::validate_private_file_destination(path, "guest log destination")
}

#[cfg(test)]
mod tests {
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
