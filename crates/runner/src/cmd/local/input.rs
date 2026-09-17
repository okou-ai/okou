//! `runner local input` — send active input to a running local job via file queue.

use std::process::ExitCode;

use clap::Args;

use crate::active_input::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, identified_active_input_payload_len,
};
use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{self, ActiveInputEntry};
use crate::paths::HomePaths;

/// The job must have been submitted with --active-input to enable forwarding.
/// Successful publication does not acknowledge delivery to the running agent.
#[derive(Args)]
pub struct InputArgs {
    /// Run ID of the claimed local job
    #[arg(long)]
    run: RunId,
    /// Runner group name
    #[arg(long)]
    group: String,
    /// Monotonically increasing active-input sequence number
    #[arg(long)]
    sequence: u64,
    /// Active-input text
    #[arg(long)]
    text: String,
}

pub fn run_input(args: InputArgs) -> RunnerResult<ExitCode> {
    run_input_with_home(args, HomePaths::new()?)
}

fn run_input_with_home(args: InputArgs, home: HomePaths) -> RunnerResult<ExitCode> {
    crate::group::validate_or_err(&args.group)?;
    if args.sequence == 0 {
        return Err(RunnerError::Config(
            "active-input sequence must be greater than zero".into(),
        ));
    }
    if args.text.is_empty() {
        return Err(RunnerError::Config(
            "active-input text must not be empty".into(),
        ));
    }
    let payload_len = identified_active_input_payload_len(&args.text).map_err(|e| {
        RunnerError::Internal(format!(
            "serialize active-input payload for validation: {e}"
        ))
    })?;
    if payload_len > ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES {
        return Err(RunnerError::Config(format!(
            "active-input serialized payload must be <= {ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES} bytes"
        )));
    }

    let group_dir = home.groups_dir().join(&args.group);
    if !group_dir.is_dir() {
        return Err(RunnerError::Config(format!(
            "group directory does not exist: {}",
            group_dir.display()
        )));
    }
    local_queue::validate_group_dir(&group_dir).map_err(|e| {
        RunnerError::Config(format!(
            "invalid group directory {}: {e}",
            group_dir.display()
        ))
    })?;

    let claim_path = local_queue::claim_path(&group_dir, args.run);
    let claimed = local_queue::marker_file_exists(&claim_path, "local claim marker")
        .map_err(|e| RunnerError::Config(e.to_string()))?;
    if !claimed {
        return Err(RunnerError::Config(format!(
            "no claimed local job found for {}",
            args.run
        )));
    }

    let queue = local_queue::LocalQueue::new(group_dir);
    let request = queue
        .read_job_request_sync(args.run)
        .map_err(|e| RunnerError::Config(format!("read claimed local job {}: {e}", args.run)))?;
    if request.active_input != Some(true) {
        return Err(RunnerError::Config(format!(
            "local job {} does not have active-input forwarding enabled; resubmit with --active-input to enable forwarding",
            args.run
        )));
    }

    #[cfg(test)]
    race_tests::pre_publication_checkpoint();

    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id: args.run,
            sequence: args.sequence,
            text: args.text,
        })
        .map_err(|e| RunnerError::Internal(format!("write local active input: {e}")))?;

    eprintln!("active input {} written for {}", args.sequence, args.run);
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
pub(crate) fn active_input_publication_locked_for_test() {
    race_tests::publication_locked_checkpoint();
}

#[cfg(test)]
pub(crate) fn active_input_lock_attempt_for_test(file: &std::fs::File) {
    race_tests::lock_attempt_checkpoint(file);
}

#[cfg(test)]
mod race_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use clap::Parser;

    struct InputFixture {
        dir: tempfile::TempDir,
        queue: local_queue::LocalQueue,
        run_id: RunId,
    }

    impl InputFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let home = HomePaths::with_root(dir.path().to_path_buf());
            let group_dir = home.groups_dir().join("test/group");
            local_queue::ensure_claims_dir(&group_dir).unwrap();
            Self {
                dir,
                queue: local_queue::LocalQueue::new(group_dir),
                run_id: RunId::new_v4(),
            }
        }

        fn write_job(&self, active_input: Option<bool>, profile: &str) -> PathBuf {
            local_queue::ensure_profile_jobs_dir(self.queue.group_dir(), profile).unwrap();
            let path = local_queue::job_path(self.queue.group_dir(), profile, self.run_id).unwrap();
            let request = local_queue::JobRequest {
                job_id: self.run_id,
                prompt: "initial prompt".into(),
                cli_agent_type: "claude-code".into(),
                vars: None,
                environment: None,
                secret_environment: None,
                user_timezone: None,
                profile: Some(profile.into()),
                reuse_key: None,
                session_id: None,
                feature_flags: None,
                active_input,
            };
            local_queue::write_private_file(
                &path,
                &serde_json::to_vec(&request).unwrap(),
                "test job request",
            )
            .unwrap();
            path
        }

        fn claim_job(&self, active_input: Option<bool>, profile: &str) -> PathBuf {
            let path = self.write_job(active_input, profile);
            assert!(matches!(
                self.queue.claim_job_sync(self.run_id, profile, &path),
                local_queue::LocalClaimResult::Claimed { .. }
            ));
            path
        }

        fn input(&self) -> RunnerResult<ExitCode> {
            let cli = crate::Cli::try_parse_from([
                "runner",
                "local",
                "input",
                "--group",
                "test/group",
                "--run",
                &self.run_id.to_string(),
                "--sequence",
                "5",
                "--text",
                "pressure-finish",
            ])
            .unwrap();
            let crate::Command::Local(local) = cli.command else {
                panic!("expected local command");
            };
            let crate::cmd::local::LocalCommand::Input(args) = local.command else {
                panic!("expected input command");
            };
            run_input_with_home(args, HomePaths::with_root(self.dir.path().to_path_buf()))
        }

        fn assert_rejected(&self, message: &str) {
            let error = self.input().unwrap_err();
            assert!(error.to_string().contains(message), "got: {error}");
            assert!(!local_queue::run_inputs_dir(self.queue.group_dir(), self.run_id).exists());
        }
    }

    #[test]
    fn writes_active_input_for_claimed_job() {
        for profile in [crate::profile::DEFAULT_PROFILE, "test/custom"] {
            let fixture = InputFixture::new();
            fixture.claim_job(Some(true), profile);

            assert_eq!(fixture.input().unwrap(), ExitCode::SUCCESS);
            let input_path =
                local_queue::active_input_path(fixture.queue.group_dir(), fixture.run_id, 5);
            let entry: ActiveInputEntry =
                serde_json::from_slice(&std::fs::read(&input_path).unwrap()).unwrap();
            assert_eq!(
                entry,
                ActiveInputEntry {
                    run_id: fixture.run_id,
                    sequence: 5,
                    text: "pressure-finish".into(),
                }
            );
            assert_eq!(
                std::fs::metadata(input_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rejects_input_when_claimed_job_has_forwarding_disabled() {
        for active_input in [None, Some(false)] {
            let fixture = InputFixture::new();
            fixture.claim_job(active_input, crate::profile::DEFAULT_PROFILE);

            fixture.assert_rejected("resubmit with --active-input");
        }
    }

    #[test]
    fn rejects_input_when_claim_marker_has_no_job_request() {
        let fixture = InputFixture::new();
        local_queue::write_private_marker(
            &local_queue::claim_path(fixture.queue.group_dir(), fixture.run_id),
            "test claim marker",
        )
        .unwrap();

        fixture.assert_rejected("no local job request found");
    }

    #[test]
    fn rejects_input_when_run_has_multiple_job_requests() {
        let fixture = InputFixture::new();
        fixture.claim_job(Some(true), crate::profile::DEFAULT_PROFILE);
        fixture.write_job(Some(false), "test/custom");

        fixture.assert_rejected("multiple local job requests found");
    }

    #[test]
    fn rejects_input_when_job_scan_fails() {
        let fixture = InputFixture::new();
        local_queue::write_private_marker(
            &local_queue::claim_path(fixture.queue.group_dir(), fixture.run_id),
            "test claim marker",
        )
        .unwrap();
        std::fs::write(
            local_queue::jobs_dir(fixture.queue.group_dir()),
            b"not a directory",
        )
        .unwrap();

        fixture.assert_rejected("cannot scan local job requests");
    }

    #[test]
    fn rejects_input_when_job_request_is_invalid() {
        let fixture = InputFixture::new();
        let path = fixture.claim_job(Some(true), crate::profile::DEFAULT_PROFILE);
        local_queue::write_private_file(&path, b"{", "test job request").unwrap();

        fixture.assert_rejected("invalid local job request");
    }

    #[test]
    fn rejects_input_when_job_request_has_different_run_id() {
        let fixture = InputFixture::new();
        let path = fixture.claim_job(Some(true), crate::profile::DEFAULT_PROFILE);
        let mut request: local_queue::JobRequest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        request.job_id = RunId::new_v4();
        local_queue::write_private_file(
            &path,
            &serde_json::to_vec(&request).unwrap(),
            "test job request",
        )
        .unwrap();

        fixture.assert_rejected("job id mismatch");
    }

    #[test]
    fn rejects_input_when_job_request_is_a_symlink() {
        let fixture = InputFixture::new();
        let path = fixture.claim_job(Some(true), crate::profile::DEFAULT_PROFILE);
        let target = fixture.dir.path().join("request.json");
        std::fs::rename(&path, &target).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        fixture.assert_rejected("read claimed local job");
    }

    #[test]
    fn rejects_input_when_job_request_exceeds_size_limit() {
        let fixture = InputFixture::new();
        let path = fixture.claim_job(Some(true), crate::profile::DEFAULT_PROFILE);
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(local_queue::LOCAL_JOB_MAX_BYTES as u64 + 1)
            .unwrap();

        fixture.assert_rejected("exceeds");
    }

    #[test]
    fn rejects_input_for_unclaimed_job() {
        let fixture = InputFixture::new();
        fixture.write_job(Some(true), crate::profile::DEFAULT_PROFILE);

        fixture.assert_rejected("no claimed local job found");
    }
}
