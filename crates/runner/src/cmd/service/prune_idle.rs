use std::time::Duration;

use clap::Args;
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};
use crate::idle_prune_control;
use runner_host::paths::HomePaths;
use runner_host::runner_process_identity::RunnerProcessIdentity;

use super::{RunnerServiceUnit, read_unit_config_path, selected_config_live_instance};

#[derive(Args)]
pub(super) struct PruneIdleArgs {
    /// Exact service suffix; never selects other Runner services
    #[arg(long)]
    name: String,
    /// Runner UUID captured when the target deployment became ready
    #[arg(long)]
    expected_runner_id: Uuid,
    /// Process generation captured with --expected-runner-id
    #[arg(long)]
    expected_heartbeat_generation: u64,
    /// Whole-command deadline; admitted cleanup continues after client timeout
    #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(1..=3600))]
    timeout_secs: u64,
}

pub(super) async fn run(args: PruneIdleArgs) -> RunnerResult<()> {
    run_with_home(args, &HomePaths::new()?).await
}

async fn run_with_home(args: PruneIdleArgs, home: &HomePaths) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let identity =
        RunnerProcessIdentity::new(args.expected_runner_id, args.expected_heartbeat_generation)
            .map_err(|error| RunnerError::Config(error.to_string()))?;
    let report = tokio::time::timeout(Duration::from_secs(args.timeout_secs), async {
        let config = read_unit_config_path(&unit).await?.ok_or_else(|| {
            RunnerError::Internal("service has no Runner config; nothing was pruned".into())
        })?;
        let instance = selected_config_live_instance(&unit, &config, home).await?.ok_or_else(|| {
            RunnerError::Internal("service has no live Runner process; nothing was pruned".into())
        })?;
        idle_prune_control::request(home, &instance.base_dir, identity, instance.pid).await
            .map_err(|error| RunnerError::Internal(format!(
                "could not prune the expected Runner generation: {error}; verify the deployment identity and command support"
            )))?
            .map_err(RunnerError::Internal)
    }).await.map_err(|_| RunnerError::Internal(
        "idle prune command timed out; admitted cleanup may still be running".into()
    ))??;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|error| RunnerError::Internal(error.to_string()))?
    );
    if report.uncertain > 0 {
        return Err(RunnerError::Internal(
            "idle pruning could not confirm all destructions; inspect Runner logs".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
