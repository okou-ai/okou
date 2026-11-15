//! `runner local` — subcommands for the local file-queue provider.

pub(crate) mod cancel;
pub(crate) mod input;
pub(crate) mod submit;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Subcommand};

use runner_host::paths::HomePaths;
use runner_provider::local_queue;

use crate::error::{RunnerError, RunnerResult};

/// Arguments for the `runner local` subcommand group.
#[derive(Args)]
pub struct LocalArgs {
    #[command(subcommand)]
    command: LocalCommand,
}

#[derive(Subcommand)]
enum LocalCommand {
    /// Submit a job to a locally running runner
    Submit(submit::SubmitArgs),
    /// Send active input to a running local job
    Input(input::InputArgs),
    /// Cancel a running job
    Cancel(cancel::CancelArgs),
}

/// Dispatch `runner local` to the selected local file-queue subcommand.
pub async fn run_local(args: LocalArgs) -> RunnerResult<ExitCode> {
    match args.command {
        LocalCommand::Submit(args) => submit::run_submit(args).await,
        LocalCommand::Input(args) => input::run_input(args),
        LocalCommand::Cancel(args) => cancel::run_cancel(args).await,
    }
}

/// Resolve an already validated group for a control command without creating it.
fn existing_group_dir(home: &HomePaths, group: &str) -> RunnerResult<PathBuf> {
    let group_dir = home.groups_dir().join(group);
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
    Ok(group_dir)
}
