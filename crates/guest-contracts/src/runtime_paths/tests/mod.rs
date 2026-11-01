use super::*;
#[cfg(target_os = "linux")]
use std::os::fd::FromRawFd;
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(unix)]
fn mode(path: impl AsRef<Path>) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn canonical_paths_are_not_under_tmp() {
    let run_dir = run_dir_for_home("/home/user", "00000000-0000-0000-0000-000000000001").unwrap();
    assert_eq!(
        finalization_error_file(&run_dir),
        run_dir.join("finalization-error")
    );
    let files = [
        session_id_file(&run_dir),
        finalization_error_file(&run_dir),
        final_session_history_identity_file(&run_dir),
        failure_diagnostic_file(&run_dir),
        system_log_file(&run_dir),
        agent_log_file(&run_dir),
        metrics_log_file(&run_dir),
        sandbox_ops_log_file(&run_dir),
        telemetry_system_log_pos_file(&run_dir),
        telemetry_metrics_pos_file(&run_dir),
        telemetry_sandbox_ops_pos_file(&run_dir),
    ];

    for path in files {
        assert!(!path_is_under(&path, Path::new("/tmp")));
        assert!(path.starts_with("/home/user/.vm0/guest-agent/runs/"));
    }
}

#[test]
fn write_private_new_preserves_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session-id");

    write_private_new(&path, "first").unwrap();
    let error = write_private_new(&path, "second").unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "first");
}

#[test]
fn rejects_unsafe_run_id_segments() {
    for run_id in ["", ".", "..", "a/b", "a\\b", "a\0b"] {
        assert!(run_dir_for_home("/home/user", run_id).is_err());
    }
}

#[test]
fn canonical_guest_runtime_dir_preserves_path_and_empty_semantics() {
    assert_eq!(CANONICAL_GUEST_RUNTIME_DIR_ENV, "OKOU_GUEST_RUNTIME_DIR");
    assert_eq!(
        canonical_guest_runtime_dir(None),
        Ok(None),
        "an absent override must use fallback resolution"
    );
    assert_eq!(
        canonical_guest_runtime_dir(Some(OsString::new())),
        Ok(None),
        "an empty override must use fallback resolution"
    );
    assert_eq!(
        canonical_guest_runtime_dir(Some(OsString::from("/canonical"))),
        Ok(Some(PathBuf::from("/canonical")))
    );
}

#[test]
fn canonical_guest_runtime_dir_preserves_non_unicode_and_fallback_contract() {
    #[cfg(unix)]
    {
        let absolute = PathBuf::from(OsString::from_vec(vec![b'/', b'r', b'u', b'n', 0xff]));
        assert_eq!(
            canonical_guest_runtime_dir(Some(absolute.as_os_str().to_owned())),
            Ok(Some(absolute))
        );

        let home = PathBuf::from(OsString::from_vec(vec![b'/', b'h', b'o', b'm', b'e', 0xfe]));
        let fallback = run_dir_from_captured_env("run-123", None, Some(&home)).unwrap();
        assert_eq!(fallback, home.join(DEFAULT_RUNTIME_PARENT).join("run-123"));
    }

    let override_dir = run_dir_from_captured_env(
        "not/validated/when/env/is/set",
        Some(Path::new("/runtime")),
        None,
    )
    .unwrap();
    assert_eq!(override_dir, Path::new("/runtime"));
    assert_eq!(
        run_dir_from_captured_env(
            "run-123",
            Some(Path::new("relative-runtime")),
            Some(Path::new("/home/vm0")),
        ),
        Err(RuntimePathError::InvalidRuntimeDir)
    );
    assert_eq!(
        canonical_guest_runtime_dir(Some(OsString::from("relative-runtime"))),
        Err(RuntimePathError::InvalidRuntimeDir)
    );
}

#[test]
fn write_private_creates_private_parent_dirs() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("run/logs/system.log");

    write_private(&path, b"hello").unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    #[cfg(unix)]
    {
        assert_eq!(mode(temp.path().join("run")), 0o700);
        assert_eq!(mode(temp.path().join("run/logs")), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
}

#[cfg(unix)]
#[test]
fn atomic_replacement_name_uses_process_independent_uuid() {
    // Reproducing PID reuse requires two operating-system processes, so
    // validate the private naming invariant at its internal boundary.
    let name = replacement_name();
    let name = name.to_str().unwrap();
    let suffix = name.strip_prefix(".vm0-private-replacement-").unwrap();

    assert_eq!(
        Uuid::parse_str(suffix).unwrap().hyphenated().to_string(),
        suffix
    );
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_creates_private_paths_and_replaces_private_file() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("run");
    let path = parent.join("state.json");

    replace_private_atomic(
        &path,
        b"first",
        PrivateFileReplacementTarget::PrivateFileOrMissing,
    )
    .unwrap();
    replace_private_atomic(
        &path,
        b"second",
        PrivateFileReplacementTarget::PrivateFileOrMissing,
    )
    .unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"second");
    assert_eq!(mode(parent), 0o700);
    assert_eq!(mode(path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_policy_controls_permissive_file_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("run");
    std::fs::create_dir(&parent).unwrap();
    let path = parent.join("state.json");
    std::fs::write(&path, b"old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let error = replace_private_atomic(
        &path,
        b"strict",
        PrivateFileReplacementTarget::PrivateFileOrMissing,
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(std::fs::read(&path).unwrap(), b"old");

    replace_private_atomic(
        &path,
        b"replacement",
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    )
    .unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    assert_eq!(mode(path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_policy_controls_final_symlink_replacement() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("run");
    std::fs::create_dir(&parent).unwrap();
    let target = temp.path().join("target.json");
    std::fs::write(&target, b"target").unwrap();
    let path = parent.join("state.json");
    symlink(&target, &path).unwrap();

    let error = replace_private_atomic(
        &path,
        b"strict",
        PrivateFileReplacementTarget::PrivateFileOrMissing,
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"target");

    replace_private_atomic(
        &path,
        b"replacement",
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    )
    .unwrap();

    assert!(
        !std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    assert_eq!(std::fs::read(&target).unwrap(), b"target");
    assert_eq!(mode(path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_rejects_symlink_parent_for_both_policies() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let target_parent = temp.path().join("target");
    std::fs::create_dir(&target_parent).unwrap();
    let linked_parent = temp.path().join("linked");
    symlink(&target_parent, &linked_parent).unwrap();

    for target in [
        PrivateFileReplacementTarget::PrivateFileOrMissing,
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    ] {
        let error =
            replace_private_atomic(linked_parent.join("state.json"), b"new", target).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target_parent.join("state.json").exists());
    }
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_cleans_temp_after_directory_publish_failure() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("run");
    let path = parent.join("state.json");
    std::fs::create_dir_all(&path).unwrap();

    replace_private_atomic(
        &path,
        b"replacement",
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    )
    .unwrap_err();

    assert!(path.is_dir());
    let entries = std::fs::read_dir(&parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![OsString::from("state.json")]);
}

#[cfg(unix)]
fn assert_private_replacement_state(path: &Path, expected: Option<&[u8]>) {
    let parent = path.parent().unwrap();
    let expected_entries = if let Some(bytes) = expected {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(mode(path), 0o600);
        vec![path.file_name().unwrap().to_owned()]
    } else {
        assert_eq!(
            std::fs::read(path).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        Vec::new()
    };
    let entries = std::fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, expected_entries);
    assert_eq!(mode(parent), 0o700);
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_preserves_target_on_file_sync_failure() {
    for target in [
        PrivateFileReplacementTarget::PrivateFileOrMissing,
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    ] {
        for existing in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("run/state.json");
            if existing {
                write_private(&path, b"old private contents").unwrap();
            }

            let error = replace_private_atomic_unix(
                &path,
                b"complete new private contents",
                target,
                |_| Err(io::Error::other("injected file sync failure")),
                sync_private_replacement_directory,
            )
            .unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(error.to_string(), "injected file sync failure");
            let old_bytes = existing.then_some(b"old private contents".as_slice());
            assert_private_replacement_state(&path, old_bytes);

            replace_private_atomic(&path, b"healthy retry contents", target).unwrap();
            assert_private_replacement_state(&path, Some(b"healthy retry contents"));
        }
    }
}

#[cfg(unix)]
#[test]
fn private_atomic_replacement_keeps_published_target_on_directory_sync_failure() {
    for target in [
        PrivateFileReplacementTarget::PrivateFileOrMissing,
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    ] {
        for existing in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("run/state.json");
            if existing {
                write_private(&path, b"old private contents").unwrap();
            }

            let error = replace_private_atomic_unix(
                &path,
                b"complete new private contents",
                target,
                File::sync_all,
                |_| Err(io::Error::other("injected directory sync failure")),
            )
            .unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(
                error.to_string(),
                format!(
                    "sync atomic private replacement directory for {}: injected directory sync failure",
                    path.display()
                )
            );
            assert_private_replacement_state(&path, Some(b"complete new private contents"));

            replace_private_atomic(&path, b"healthy retry contents", target).unwrap();
            assert_private_replacement_state(&path, Some(b"healthy retry contents"));
        }
    }
}

#[test]
fn ensure_dir_chmods_existing_target_dir() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("run");
    std::fs::create_dir(&path).unwrap();

    #[cfg(unix)]
    {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();

        ensure_dir(&path).unwrap();

        assert_eq!(mode(&path), 0o700);
    }
}

#[test]
fn write_private_chmods_existing_final_parent_dir() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("run");
    std::fs::create_dir(&parent).unwrap();
    let path = parent.join("system.log");

    #[cfg(unix)]
    {
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        write_private(&path, b"hello").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert_eq!(mode(&parent), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn chmod_proc_fd_path_updates_o_path_directory() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("run");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let path_c = CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: `path_c` is NUL-terminated and points to the test directory.
    let raw_fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    assert!(raw_fd >= 0, "open O_PATH: {}", io::Error::last_os_error());
    // SAFETY: `raw_fd` is a fresh descriptor returned by `open`.
    let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };

    chmod_proc_fd_path(&fd, OsStr::new("run"), &path).unwrap();

    assert_eq!(mode(&path), 0o700);
}

#[test]
fn write_private_rejects_symlink_file() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    let link = temp.path().join("link");
    std::fs::write(&target, b"secret").unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(write_private(&link, b"new").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
    }
}

#[test]
fn open_private_append_rejects_symlink_file() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    let link = temp.path().join("link");
    std::fs::write(&target, b"secret").unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(open_private_append(&link).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
    }
}

#[test]
fn write_private_rejects_symlink_parent_without_touching_target() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    let link = temp.path().join("link");
    std::fs::create_dir(&target).unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = write_private(link.join("system.log"), b"new").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("system.log").exists());
    }
}

#[test]
fn create_private_rejects_symlink_parent_without_touching_target() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    let link = temp.path().join("link");
    std::fs::create_dir(&target).unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = create_private(link.join("agent.jsonl")).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("agent.jsonl").exists());
    }
}

#[test]
fn open_private_append_rejects_symlink_parent_without_touching_target() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    let link = temp.path().join("link");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("metrics.jsonl"), b"secret").unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = open_private_append(link.join("metrics.jsonl")).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            std::fs::read(target.join("metrics.jsonl")).unwrap(),
            b"secret"
        );
    }
}

#[test]
fn write_private_rejects_file_parent_as_not_a_directory() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("not-a-dir");
    std::fs::write(&parent, b"file").unwrap();
    let path = parent.join("system.log");

    #[cfg(unix)]
    {
        let error = write_private(&path, b"new").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotADirectory);
        assert!(parent.is_file());
        assert!(!path.exists());
    }
}

#[test]
fn ensure_dir_rejects_parent_segment_before_creating_missing_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("base");
    std::fs::create_dir(&base).unwrap();

    #[cfg(unix)]
    {
        let error = ensure_dir(base.join("missing").join("..").join("leaf")).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!base.join("missing").exists());
        assert!(!base.join("leaf").exists());
    }
}

#[test]
fn create_private_rejects_trailing_separator_without_touching_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("run").join("session-id");
    let path_with_trailing_separator = PathBuf::from(format!("{}/", path.display()));

    #[cfg(unix)]
    {
        let error = create_private(&path_with_trailing_separator).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!temp.path().join("run").exists());
        assert!(!path.exists());
    }
}

#[test]
fn create_private_rejects_trailing_current_dir_without_touching_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("run").join("session-id");
    let path_with_trailing_current_dir = path.join(".");

    #[cfg(unix)]
    {
        let error = create_private(&path_with_trailing_current_dir).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!temp.path().join("run").exists());
        assert!(!path.exists());
    }
}

#[test]
fn create_private_rejects_nul_file_name_without_creating_parent() {
    let temp = tempfile::tempdir().unwrap();

    #[cfg(unix)]
    {
        let path = temp
            .path()
            .join("run")
            .join(Path::new(OsStr::from_bytes(b"bad\0name")));

        let error = create_private(&path).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!temp.path().join("run").exists());
    }
}

#[test]
fn open_private_append_rejects_trailing_separator_without_touching_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("run").join("metrics.jsonl");
    let path_with_trailing_separator = PathBuf::from(format!("{}/", path.display()));

    #[cfg(unix)]
    {
        let error = open_private_append(&path_with_trailing_separator).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!temp.path().join("run").exists());
        assert!(!path.exists());
    }
}
