use super::{remove_manifest_file, remove_stale_manifest_file, run_manifest_file_and_remove};

#[test]
fn remove_manifest_file_removes_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("storage-manifest.json");
    std::fs::write(&path, br#"{"secret":"old"}"#).unwrap();

    assert!(remove_manifest_file(path.to_str().unwrap()));

    assert!(!path.exists());
}

#[test]
fn remove_manifest_file_allows_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing-storage-manifest.json");

    assert!(remove_manifest_file(path.to_str().unwrap()));

    assert!(!path.exists());
}

#[test]
fn remove_manifest_file_fails_for_non_removable_path() {
    let dir = tempfile::tempdir().unwrap();

    assert!(!remove_manifest_file(dir.path().to_str().unwrap()));
}

#[test]
fn remove_stale_manifest_file_allows_directory_without_removing_it() {
    let dir = tempfile::tempdir().unwrap();

    assert!(remove_stale_manifest_file(dir.path().to_str().unwrap()));

    assert!(dir.path().is_dir());
}

#[test]
fn run_manifest_file_and_remove_removes_file_on_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("storage-manifest.json");
    std::fs::write(&path, br#"{"storageMounts":[]}"#).unwrap();

    assert!(run_manifest_file_and_remove(path.to_str().unwrap()));

    assert!(!path.exists());
}

#[test]
fn run_manifest_file_and_remove_removes_file_on_parse_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("storage-manifest.json");
    std::fs::write(&path, br#"{{not valid json secret-body"#).unwrap();

    assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn run_manifest_file_and_remove_removes_symlink_on_read_failure() {
    let dir = tempfile::tempdir().unwrap();
    let target_dir = dir.path().join("target-dir");
    let path = dir.path().join("storage-manifest.json");
    std::fs::create_dir(&target_dir).unwrap();
    std::os::unix::fs::symlink(&target_dir, &path).unwrap();

    assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

    assert!(!path.exists());
    assert!(target_dir.exists());
}

#[cfg(unix)]
#[test]
fn run_manifest_file_and_remove_rejects_symlink_to_regular_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target-manifest.json");
    let path = dir.path().join("storage-manifest.json");
    std::fs::write(&target, br#"{"storageMounts":[]}"#).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();

    assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

    assert!(!path.exists());
    assert!(target.exists());
}

#[cfg(unix)]
#[test]
fn run_manifest_file_and_remove_rejects_fifo_without_blocking() {
    use std::ffi::CString;
    use std::io;
    use std::io::{Read as _, Seek as _};
    use std::os::unix::ffi::OsStrExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct FifoChild(Child);

    impl Drop for FifoChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("storage-manifest.json");
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();

    // SAFETY: `c_path` is a valid, NUL-terminated filesystem path.
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(result, 0, "mkfifo failed: {}", io::Error::last_os_error());

    // Keep the FIFO and child lifetime in the parent: a blocking open must
    // be killed and reaped before the temporary directory is removed.
    let mut output = tempfile::tempfile().unwrap();
    let mut child = FifoChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::run_manifest_file_and_remove_rejects_fifo_child",
                "--ignored",
                "--nocapture",
            ])
            .env("OKOU_STORAGE_MANIFEST_FIFO_CHILD_PATH", &path)
            .stdin(Stdio::null())
            .stdout(output.try_clone().unwrap())
            .stderr(output.try_clone().unwrap())
            .spawn()
            .unwrap(),
    );
    let timeout = Duration::from_secs(10);
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "FIFO child {} did not exit within {timeout:?}",
            child.0.id()
        );
        std::thread::sleep(remaining.min(Duration::from_millis(1)));
    };

    output.rewind().unwrap();
    let mut diagnostics = String::new();
    output.read_to_string(&mut diagnostics).unwrap();
    assert!(
        status.success(),
        "FIFO child failed: {status}\n{diagnostics}"
    );
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
#[ignore = "spawned by run_manifest_file_and_remove_rejects_fifo_without_blocking"]
fn run_manifest_file_and_remove_rejects_fifo_child() {
    let Some(path) = std::env::var_os("OKOU_STORAGE_MANIFEST_FIFO_CHILD_PATH") else {
        return;
    };
    let path = std::path::PathBuf::from(path);

    assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

    assert!(!path.exists());
}
