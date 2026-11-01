//! `runner local input` — send active input to a running local job via file queue.

use std::process::ExitCode;

use clap::Args;

use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;
use runner_provider::local_queue::{self, ActiveInputEntry};
use runner_provider::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, identified_active_input_payload_len,
};
use runner_types::ids::RunId;

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
mod race_tests;

#[cfg(test)]
mod tests;
