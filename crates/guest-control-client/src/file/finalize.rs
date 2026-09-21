use std::io;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

use sandbox::{
    StagedFileDisposition, StagedFileFinalizeMeasurements, StagedFileFinalizeOutcome,
    StagedFileFinalizeRequest, StagedFileNotPublishedReason, StagedFilePublicationMode,
};
use shell_quote::quote_shell_arg;

use crate::{
    CompositeNormalOperation, ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput,
    FrameWriteObserver, GuestControlClient, exec_operation,
    exec_operation::ExecOperationWaitOutcome,
};

const FINALIZE_TIMEOUT_MS: u32 = 60_000;
const PATH_MAX_BYTES: usize = 4096;

const PUBLISHED_SAME: &[u8] = b"published_same\n";
const PUBLISHED_CROSS: &[u8] = b"published_cross\n";
const DISCARDED: &[u8] = b"discarded\n";

fn validate_absolute_normal_path(path: &str, label: &str) -> io::Result<()> {
    if path.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} must not be empty"),
        ));
    }
    if path.len() > PATH_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} exceeds {PATH_MAX_BYTES} bytes"),
        ));
    }
    if path.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} contains NUL bytes"),
        ));
    }
    let parsed = Path::new(path);
    let has_non_normal_segment = path != "/"
        && path
            .split('/')
            .skip(1)
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."));
    if !parsed.is_absolute()
        || has_non_normal_segment
        || parsed
            .components()
            .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} must be an absolute normalized path"),
        ));
    }
    Ok(())
}

fn discard_command(staging_path: &str) -> String {
    let staging_path = quote_shell_arg(staging_path);
    format!(
        "if rm -f -- {staging_path} >/dev/null 2>&1; then printf '%s\\n' discarded; else printf '%s\\n' not_published:discard_failed; fi"
    )
}

fn publish_command(staging_path: &str, destination: &str, sibling: &str) -> io::Result<String> {
    let parent = Path::new(destination).parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "staged-file destination must have a parent",
        )
    })?;
    if parent == Path::new("/") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "staged-file destination parent must not be root",
        ));
    }
    let parent = parent.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "staged-file destination parent must be UTF-8",
        )
    })?;
    let source = quote_shell_arg(staging_path);
    let destination = quote_shell_arg(destination);
    let parent = quote_shell_arg(parent);
    let sibling = quote_shell_arg(sibling);
    Ok(format!(
        "src={source}; dest={destination}; parent={parent}; tmp={sibling}; \
         expected_owner=; \
         if ! test -f \"$src\" || test -L \"$src\"; then printf '%s\\n' not_published:invalid_source; exit 0; fi; \
         if ! mkdir -p -- \"$parent\" >/dev/null 2>&1; then printf '%s\\n' not_published:invalid_parent; exit 0; fi; \
         resolved_parent=$(realpath -e -- \"$parent\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_parent; exit 0; }}; \
         if test \"$resolved_parent\" != \"$parent\"; then printf '%s\\n' not_published:invalid_parent; exit 0; fi; \
         if test -e \"$dest\" || test -L \"$dest\"; then \
           if test -L \"$dest\" || ! test -f \"$dest\"; then printf '%s\\n' not_published:invalid_destination; exit 0; fi; \
           src_owner=$(stat -c %u:%g -- \"$src\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_source; exit 0; }}; \
           dest_owner=$(stat -c %u:%g -- \"$dest\" 2>/dev/null) || {{ printf '%s\\n' not_published:metadata_failed; exit 0; }}; \
           dest_mode=$(stat -c %a -- \"$dest\" 2>/dev/null) || {{ printf '%s\\n' not_published:metadata_failed; exit 0; }}; \
           if test \"$src_owner\" != \"$dest_owner\" || ! chmod \"$dest_mode\" -- \"$src\" >/dev/null 2>&1; then printf '%s\\n' not_published:metadata_failed; exit 0; fi; \
           expected_owner=$dest_owner; \
         fi; \
         src_dev=$(stat -c %d -- \"$src\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_source; exit 0; }}; \
         parent_dev=$(stat -c %d -- \"$parent\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_parent; exit 0; }}; \
         if test \"$src_dev\" = \"$parent_dev\"; then \
           if mv -fT -- \"$src\" \"$dest\" >/dev/null 2>&1; then printf '%s\\n' published_same; else printf '%s\\n' not_published:rename_failed; fi; \
         else \
           if test -e \"$tmp\" || test -L \"$tmp\"; then printf '%s\\n' not_published:copy_failed; exit 0; fi; \
           if cp --preserve=mode --no-target-directory -- \"$src\" \"$tmp\" >/dev/null 2>&1; then \
             if test -n \"$expected_owner\"; then \
               tmp_owner=$(stat -c %u:%g -- \"$tmp\" 2>/dev/null) || {{ rm -f -- \"$tmp\" >/dev/null 2>&1 || true; printf '%s\\n' not_published:metadata_failed; exit 0; }}; \
               if test \"$tmp_owner\" != \"$expected_owner\"; then rm -f -- \"$tmp\" >/dev/null 2>&1 || true; printf '%s\\n' not_published:metadata_failed; exit 0; fi; \
             fi; \
             if mv -fT -- \"$tmp\" \"$dest\" >/dev/null 2>&1; then rm -f -- \"$src\" >/dev/null 2>&1 || true; printf '%s\\n' published_cross; \
             else rm -f -- \"$tmp\" >/dev/null 2>&1 || true; printf '%s\\n' not_published:rename_failed; fi; \
           else rm -f -- \"$tmp\" >/dev/null 2>&1 || true; printf '%s\\n' not_published:copy_failed; fi; \
         fi"
    ))
}

fn captured_bytes(output: ExecOwnedCapturedOutput, stream: &str) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("staged-file finalizer discarded {stream}"),
        )),
    }
}

fn validate_terminal_result(
    result: ExecOperationResult,
    elapsed: Duration,
) -> io::Result<StagedFileFinalizeOutcome> {
    if result.stream_overflowed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "staged-file finalizer overflowed an output stream",
        ));
    }
    let (stdout, stdout_truncated) = captured_bytes(result.stdout, "stdout")?;
    let (stderr, stderr_truncated) = captured_bytes(result.stderr, "stderr")?;
    if stdout_truncated || stderr_truncated {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "staged-file finalizer output was truncated",
        ));
    }
    match result.termination {
        guest_control_proto::ExecTermination::Exited { exit_code: 0 } => {}
        guest_control_proto::ExecTermination::Exited { exit_code } => {
            return Err(io::Error::other(format!(
                "staged-file finalizer exited with code {exit_code}"
            )));
        }
        guest_control_proto::ExecTermination::TimedOut => {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "staged-file finalizer timed out with publication outcome unproven",
            ));
        }
        guest_control_proto::ExecTermination::Cancelled
        | guest_control_proto::ExecTermination::StartFailed
        | guest_control_proto::ExecTermination::WaitFailed => {
            return Err(io::Error::other(
                "staged-file finalizer ended without a proven publication outcome",
            ));
        }
    }
    if !stderr.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "staged-file finalizer returned unexpected stderr",
        ));
    }

    let measurements = StagedFileFinalizeMeasurements {
        elapsed,
        copy_elapsed: Duration::ZERO,
        publication_elapsed: Duration::ZERO,
    };
    if stdout == PUBLISHED_SAME {
        return Ok(StagedFileFinalizeOutcome::Published {
            mode: StagedFilePublicationMode::SameDeviceRename,
            measurements,
        });
    }
    if stdout == PUBLISHED_CROSS {
        return Ok(StagedFileFinalizeOutcome::Published {
            mode: StagedFilePublicationMode::CrossDeviceCopyRename,
            measurements,
        });
    }
    if stdout == DISCARDED {
        return Ok(StagedFileFinalizeOutcome::Discarded { measurements });
    }
    let reason = match stdout.as_slice() {
        b"not_published:invalid_source\n" => StagedFileNotPublishedReason::InvalidSource,
        b"not_published:invalid_parent\n" => StagedFileNotPublishedReason::InvalidDestinationParent,
        b"not_published:invalid_destination\n" => StagedFileNotPublishedReason::InvalidDestination,
        b"not_published:metadata_failed\n" => {
            StagedFileNotPublishedReason::MetadataPreparationFailed
        }
        b"not_published:rename_failed\n" => StagedFileNotPublishedReason::RenameFailed,
        b"not_published:copy_failed\n" => StagedFileNotPublishedReason::CopyFailed,
        b"not_published:discard_failed\n" => StagedFileNotPublishedReason::DiscardFailed,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "staged-file finalizer returned an invalid result token",
            ));
        }
    };
    Ok(StagedFileFinalizeOutcome::NotPublished {
        reason,
        measurements,
    })
}

impl GuestControlClient {
    /// Publish or discard one completed guest staging file.
    ///
    /// Only a normally exited helper with a validated result token returns a
    /// terminal value. Every unproven operation remains an error so callers
    /// cannot mistake an ambiguous publication for a retry-safe failure.
    pub async fn finalize_staged_file(
        &self,
        request: &StagedFileFinalizeRequest<'_>,
    ) -> io::Result<StagedFileFinalizeOutcome> {
        validate_absolute_normal_path(request.staging_path, "staging path")?;
        let (command, destination) = match request.disposition {
            StagedFileDisposition::Discard => (discard_command(request.staging_path), None),
            StagedFileDisposition::Publish { destination } => {
                validate_absolute_normal_path(destination, "destination path")?;
                if request.staging_path == destination {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "staging and destination paths must differ",
                    ));
                }
                let sibling = Path::new(destination)
                    .with_file_name(format!(".vm0tmp-{}", uuid::Uuid::new_v4().simple()));
                let sibling = sibling.to_str().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "destination sibling path must be UTF-8",
                    )
                })?;
                (
                    publish_command(request.staging_path, destination, sibling)?,
                    Some(destination),
                )
            }
        };

        let paths = std::iter::once(request.staging_path).chain(destination);
        let _path_guards = self
            .file_write_path_locks
            .acquire_exclusive_many(paths)
            .await;
        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;
        let started = Instant::now();
        let outcome = exec_operation::exec_operation_capture_with_composite_on_shared_and_observer(
            &self.shared,
            ExecCaptureRequest {
                command: &command,
                timeout_ms: FINALIZE_TIMEOUT_MS,
                env: &[],
                sudo: false,
                label: "finalize-staged-file",
                stdout_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                stderr_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                expected_exit_codes: &[],
                stdin_bytes: None,
                wait_timeout: Duration::from_millis(FINALIZE_TIMEOUT_MS as u64 + 5_000),
            },
            &mut normal_operation,
            FrameWriteObserver::default(),
        )
        .await;
        match outcome {
            ExecOperationWaitOutcome::Terminal(result) => {
                let validated =
                    result.and_then(|result| validate_terminal_result(result, started.elapsed()));
                normal_operation.complete()?;
                validated
            }
            ExecOperationWaitOutcome::Unproven(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
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
}
