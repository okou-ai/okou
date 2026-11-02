use super::*;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::process::{Command, Output};

fn terminal_result(
    termination: guest_control_proto::ExecTermination,
    stdout: &[u8],
    stderr: &[u8],
) -> ExecOperationResult {
    ExecOperationResult {
        termination,
        duration_ms: 1,
        stdout: ExecOwnedCapturedOutput::Captured {
            bytes: stdout.to_vec(),
            truncated: false,
        },
        stderr: ExecOwnedCapturedOutput::Captured {
            bytes: stderr.to_vec(),
            truncated: false,
        },
        diagnostic: String::new(),
        stream_overflowed: false,
    }
}

fn run_shell(command: &str, extra_path: Option<&Path>) -> Output {
    let mut process = Command::new("sh");
    process.arg("-c").arg(command);
    if let Some(extra_path) = extra_path {
        let path = std::env::var_os("PATH").unwrap_or_default();
        process.env(
            "PATH",
            std::env::join_paths(
                std::iter::once(extra_path.to_path_buf()).chain(std::env::split_paths(&path)),
            )
            .unwrap(),
        );
    }
    process.output().unwrap()
}

fn command_paths(root: &Path) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let staging = root.join("staging");
    let parent = root.join("destination");
    fs::create_dir(&parent).unwrap();
    let destination = parent.join("history.jsonl");
    let sibling = parent.join(".vm0tmp-test");
    (staging, destination, sibling)
}

fn publish_for_test(staging: &Path, destination: &Path, sibling: &Path) -> String {
    publish_command(
        staging.to_str().unwrap(),
        destination.to_str().unwrap(),
        sibling.to_str().unwrap(),
    )
    .unwrap()
}

fn force_cross_device(command: String) -> String {
    let probe = "if test \"$src_dev\" = \"$parent_dev\"; then";
    assert!(command.contains(probe));
    command.replacen(probe, "if false; then", 1)
}

fn install_failing_command(bin: &Path, name: &str, body: &str) {
    fs::create_dir_all(bin).unwrap();
    let path = bin.join(name);
    fs::write(&path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn validates_normal_absolute_paths() {
    validate_absolute_normal_path("/home/user/.vm0/staged", "path").unwrap();

    for invalid in ["", "relative", "/home/user/../escape", "/home//user"] {
        assert!(validate_absolute_normal_path(invalid, "path").is_err());
    }
}

#[test]
fn accepts_only_proven_publication_tokens() {
    let elapsed = Duration::from_millis(7);
    let same = validate_terminal_result(
        terminal_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            PUBLISHED_SAME,
            b"",
        ),
        elapsed,
    )
    .unwrap();
    assert!(matches!(
        same,
        StagedFileFinalizeOutcome::Published {
            mode: StagedFilePublicationMode::SameDeviceRename,
            ..
        }
    ));

    let not_published = validate_terminal_result(
        terminal_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            b"not_published:copy_failed\n",
            b"",
        ),
        elapsed,
    )
    .unwrap();
    assert!(matches!(
        not_published,
        StagedFileFinalizeOutcome::NotPublished {
            reason: StagedFileNotPublishedReason::CopyFailed,
            ..
        }
    ));
}

#[test]
fn rejects_ambiguous_or_malformed_terminal_results() {
    let elapsed = Duration::from_millis(7);
    for result in [
        terminal_result(guest_control_proto::ExecTermination::TimedOut, b"", b""),
        terminal_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            b"unknown\n",
            b"",
        ),
        terminal_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            PUBLISHED_SAME,
            b"unexpected",
        ),
    ] {
        assert!(validate_terminal_result(result, elapsed).is_err());
    }
}

#[test]
fn publish_command_handles_cross_device_copy_before_rename() {
    let command = publish_command(
        "/home/user/.vm0/staged",
        "/home/user/.codex/sessions/final.jsonl",
        "/home/user/.codex/sessions/.vm0tmp-test",
    )
    .unwrap();

    assert!(command.contains("stat -c %d"));
    assert!(command.contains("cp --preserve=mode --no-target-directory"));
    assert!(command.contains("mv -fT"));
    assert!(command.contains("published_cross"));
}

#[test]
fn same_device_publish_atomically_replaces_complete_regular_file() {
    let temp = tempfile::tempdir().unwrap();
    let (staging, destination, sibling) = command_paths(temp.path());
    fs::write(&staging, b"new history").unwrap();
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&destination, b"old history").unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();

    let output = run_shell(&publish_for_test(&staging, &destination, &sibling), None);

    assert!(output.status.success());
    assert_eq!(output.stdout, PUBLISHED_SAME);
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read(&destination).unwrap(), b"new history");
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert!(!staging.exists());
    assert!(!sibling.exists());
}

#[test]
fn forced_cross_device_publish_copies_then_renames_and_cleans_source() {
    let temp = tempfile::tempdir().unwrap();
    let (staging, destination, sibling) = command_paths(temp.path());
    fs::write(&staging, b"cross-device history").unwrap();
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o640)).unwrap();
    let command = force_cross_device(publish_for_test(&staging, &destination, &sibling));

    let output = run_shell(&command, None);

    assert!(output.status.success());
    assert_eq!(output.stdout, PUBLISHED_CROSS);
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read(&destination).unwrap(), b"cross-device history");
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert!(!staging.exists());
    assert!(!sibling.exists());
}

#[test]
fn forced_cross_device_publish_preserves_existing_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let (staging, destination, sibling) = command_paths(temp.path());
    fs::write(&staging, b"new history").unwrap();
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&destination, b"old history").unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
    let previous = fs::metadata(&destination).unwrap();
    let command = force_cross_device(publish_for_test(&staging, &destination, &sibling));

    let output = run_shell(&command, None);

    assert!(output.status.success());
    assert_eq!(output.stdout, PUBLISHED_CROSS);
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read(&destination).unwrap(), b"new history");
    let published = fs::metadata(&destination).unwrap();
    assert_eq!(published.permissions().mode() & 0o777, 0o640);
    assert_eq!(published.uid(), previous.uid());
    assert_eq!(published.gid(), previous.gid());
    assert!(!staging.exists());
    assert!(!sibling.exists());
}

#[test]
fn cross_device_source_cleanup_failure_keeps_proven_publication() {
    let temp = tempfile::tempdir().unwrap();
    let (staging, destination, sibling) = command_paths(temp.path());
    fs::write(&staging, b"history").unwrap();
    let fake_bin = temp.path().join("fake-bin");
    install_failing_command(&fake_bin, "rm", "#!/bin/sh\nexit 1\n");
    let command = force_cross_device(publish_for_test(&staging, &destination, &sibling));

    let output = run_shell(&command, Some(&fake_bin));

    assert!(output.status.success());
    assert_eq!(output.stdout, PUBLISHED_CROSS);
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read(&destination).unwrap(), b"history");
    assert!(staging.exists());
    assert!(!sibling.exists());
}

#[test]
fn publish_rejects_symlink_destination_and_parent() {
    let temp = tempfile::tempdir().unwrap();
    let (staging, destination, sibling) = command_paths(temp.path());
    let target = temp.path().join("target");
    fs::write(&staging, b"history").unwrap();
    fs::write(&target, b"target").unwrap();
    symlink(&target, &destination).unwrap();

    let output = run_shell(&publish_for_test(&staging, &destination, &sibling), None);
    assert_eq!(output.stdout, b"not_published:invalid_destination\n");
    assert_eq!(fs::read(&target).unwrap(), b"target");
    assert!(staging.exists());

    fs::remove_file(&destination).unwrap();
    let real_parent = temp.path().join("real-parent");
    let linked_parent = temp.path().join("linked-parent");
    fs::create_dir(&real_parent).unwrap();
    symlink(&real_parent, &linked_parent).unwrap();
    let linked_destination = linked_parent.join("history.jsonl");
    let linked_sibling = linked_parent.join(".vm0tmp-test");
    let output = run_shell(
        &publish_for_test(&staging, &linked_destination, &linked_sibling),
        None,
    );
    assert_eq!(output.stdout, b"not_published:invalid_parent\n");
    assert!(!real_parent.join("history.jsonl").exists());
    assert!(staging.exists());
}

#[test]
fn publish_creates_missing_destination_parents_after_staging() {
    let temp = tempfile::tempdir().unwrap();
    let staging = temp.path().join("staging");
    let parent = temp.path().join("missing").join("nested");
    let destination = parent.join("history.jsonl");
    let sibling = parent.join(".vm0tmp-test");
    fs::write(&staging, b"history").unwrap();

    let output = run_shell(&publish_for_test(&staging, &destination, &sibling), None);

    assert!(output.status.success());
    assert_eq!(output.stdout, PUBLISHED_SAME);
    assert_eq!(fs::read(destination).unwrap(), b"history");
    assert!(!staging.exists());
    assert!(!sibling.exists());
}

#[test]
fn cross_device_copy_and_rename_failures_remove_partial_sibling() {
    for failing_command in ["cp", "mv"] {
        let temp = tempfile::tempdir().unwrap();
        let (staging, destination, sibling) = command_paths(temp.path());
        fs::write(&staging, b"history").unwrap();
        let fake_bin = temp.path().join("fake-bin");
        let body = if failing_command == "cp" {
            "#!/bin/sh\nfor arg do last=$arg; done\nprintf partial > \"$last\"\nexit 1\n"
        } else {
            "#!/bin/sh\nexit 1\n"
        };
        install_failing_command(&fake_bin, failing_command, body);
        let command = force_cross_device(publish_for_test(&staging, &destination, &sibling));

        let output = run_shell(&command, Some(&fake_bin));

        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            if failing_command == "cp" {
                b"not_published:copy_failed\n".as_slice()
            } else {
                b"not_published:rename_failed\n".as_slice()
            }
        );
        assert!(staging.exists());
        assert!(!destination.exists());
        assert!(!sibling.exists());
    }
}

#[test]
fn discard_removes_staging_file() {
    let temp = tempfile::tempdir().unwrap();
    let staging = temp.path().join("staging");
    fs::write(&staging, b"history").unwrap();

    let output = run_shell(discard_command(staging.to_str().unwrap()).as_str(), None);

    assert!(output.status.success());
    assert_eq!(output.stdout, DISCARDED);
    assert!(!staging.exists());
}
