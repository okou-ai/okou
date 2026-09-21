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
         if ! test -f \"$src\" || test -L \"$src\"; then printf '%s\\n' not_published:invalid_source; exit 0; fi; \
         if ! mkdir -p -- \"$parent\" >/dev/null 2>&1; then printf '%s\\n' not_published:invalid_parent; exit 0; fi; \
         resolved_parent=$(realpath -e -- \"$parent\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_parent; exit 0; }}; \
         if test \"$resolved_parent\" != \"$parent\"; then printf '%s\\n' not_published:invalid_parent; exit 0; fi; \
         if test -e \"$dest\" || test -L \"$dest\"; then if test -L \"$dest\" || ! test -f \"$dest\"; then printf '%s\\n' not_published:invalid_destination; exit 0; fi; fi; \
         src_dev=$(stat -c %d -- \"$src\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_source; exit 0; }}; \
         parent_dev=$(stat -c %d -- \"$parent\" 2>/dev/null) || {{ printf '%s\\n' not_published:invalid_parent; exit 0; }}; \
         if test \"$src_dev\" = \"$parent_dev\"; then \
           if mv -fT -- \"$src\" \"$dest\" >/dev/null 2>&1; then printf '%s\\n' published_same; else printf '%s\\n' not_published:rename_failed; fi; \
         else \
           if test -e \"$tmp\" || test -L \"$tmp\"; then printf '%s\\n' not_published:copy_failed; exit 0; fi; \
           if cp --preserve=mode --no-target-directory -- \"$src\" \"$tmp\" >/dev/null 2>&1; then \
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
}
