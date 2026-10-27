use std::io::{self, BufWriter, Write};
use std::process::ExitCode;

use super::super::SubmitPlan;
use super::support::submit_args_for_test;
use runner_host::paths::HomePaths;
use runner_provider::local_queue::{LocalClaimResult, LocalQueue};

fn completed_plan(exit_code: i32) -> (tempfile::TempDir, SubmitPlan, Vec<u8>) {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let plan = SubmitPlan::from_args(submit_args_for_test(), home).unwrap();
    plan.write_job_file().unwrap();
    assert!(
        LocalQueue::new(plan.queue.group_dir.clone()).write_result_sync(
            plan.queue.job_id,
            exit_code,
            None,
        )
    );
    let result = std::fs::read(&plan.queue.result).unwrap();
    (dir, plan, result)
}

struct FailingOutput {
    bytes: Vec<u8>,
    remaining: Option<usize>,
    fail_flush: bool,
}

impl Write for FailingOutput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let len = match self.remaining {
            Some(0) => return Err(io::Error::from_raw_os_error(libc::ENOSPC)),
            Some(remaining) => remaining.min(buf.len()),
            None => buf.len(),
        };
        self.bytes.extend_from_slice(&buf[..len]);
        if let Some(remaining) = &mut self.remaining {
            *remaining -= len;
        }
        Ok(len)
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.fail_flush {
            Err(io::Error::other("injected flush failure"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn completed_output_failures_retain_result_and_prevent_reexecution() {
    for exit_code in [0, 42] {
        let (_dir, plan, result) = completed_plan(exit_code);
        let mut expected_output = result.clone();
        expected_output.push(b'\n');

        // Fail before JSON, partway through JSON, at the newline, or only on flush.
        for (remaining, fail_flush) in [
            (Some(0), false),
            (Some(7), false),
            (Some(result.len()), false),
            (None, true),
        ] {
            let mut output = FailingOutput {
                bytes: Vec::new(),
                remaining,
                fail_flush,
            };
            let error = plan.finish_completed(&result, &mut output).unwrap_err();
            let message = error.to_string();

            assert!(message.contains("stdout"), "{message}");
            assert!(
                message.contains(&plan.queue.result.display().to_string()),
                "{message}"
            );
            if fail_flush {
                assert!(message.contains("injected flush failure"), "{message}");
            } else {
                assert!(message.contains("os error 28"), "{message}");
            }
            assert_eq!(
                output.bytes,
                expected_output[..remaining.unwrap_or(expected_output.len())]
            );
            assert_eq!(std::fs::read(&plan.queue.result).unwrap(), result);
            assert!(plan.queue.job.exists());
            assert!(matches!(
                LocalQueue::new(plan.queue.group_dir.clone()).claim_job_sync(
                    plan.queue.job_id,
                    &plan.profile,
                    &plan.queue.job,
                ),
                LocalClaimResult::NotClaimed
            ));
        }
    }
}

#[test]
fn completed_output_flushes_before_cleanup_and_preserves_job_status() {
    for (exit_code, expected_status) in [(0, ExitCode::SUCCESS), (42, ExitCode::FAILURE)] {
        let (_dir, plan, result) = completed_plan(exit_code);
        let mut output = BufWriter::new(Vec::new());

        let status = plan.finish_completed(&result, &mut output).unwrap();

        let mut expected_output = result;
        expected_output.push(b'\n');
        assert_eq!(output.get_ref(), &expected_output);
        assert_eq!(status, expected_status);
        assert!(!plan.queue.job.exists());
        assert!(!plan.queue.result.exists());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn completed_output_to_dev_full_retains_result() {
    for exit_code in [0, 42] {
        let (_dir, plan, result) = completed_plan(exit_code);
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .unwrap();

        let error = plan.finish_completed(&result, &mut output).unwrap_err();

        assert!(error.to_string().contains("os error 28"), "{error}");
        assert_eq!(std::fs::read(&plan.queue.result).unwrap(), result);
    }
}
