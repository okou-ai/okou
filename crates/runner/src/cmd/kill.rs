//! Kill a running sandbox and clean up resources.
//!
//! When the parent runner daemon is alive, this command asks the owning runner
//! to terminate the sandbox via the local control socket. The owner still holds
//! the process monitor and `Child` handle, so it can kill the process group and
//! handle normal cleanup without reconstructing ownership from `/proc`.
//!
//! Manual cleanup (workspace + socket dir) is only performed for orphan
//! processes whose parent runner has already died.
//!
//! Resolution: the user must specify either `--run <ID>` or `--sandbox <ID>`.
//! `--run` consults each live runner's `status.json` to translate a `run_id`
//! prefix into the `sandbox_id` that identifies the Firecracker VM, then
//! locates the FC by that `sandbox_id`. `--sandbox` matches the prefix
//! directly against running FC processes — useful for orphan sandboxes
//! whose parent runner has already died and whose `status.json` is gone.

use std::path::Path;
use std::process::ExitCode;

use clap::Args;
use sandbox::{RemoteKillResult, SandboxControl};
use tracing::info;

use crate::error::RunnerResult;
use runner_host::process;

mod orphan;
mod target;
#[cfg(test)]
mod test_support;

use orphan::{OrphanExitFailure, Outcome as OrphanOutcome};
use target::{
    KillTarget, RediscoverTargetError, ResolvedKillTarget, discover_and_resolve_target,
    rediscover_same_sandbox_process, rediscover_same_target,
};

const RUN_ORPHAN_FALLBACK_REFUSAL: &str =
    "run target can no longer be verified; use --sandbox for explicit orphan cleanup";

#[derive(Args)]
#[command(group = clap::ArgGroup::new("target").required(true))]
pub struct KillArgs {
    /// Target by run ID (full UUID or prefix) — resolved to a sandbox
    /// via status.json.
    #[arg(long, group = "target")]
    run: Option<String>,

    /// Target by sandbox ID (full UUID or prefix) — matched directly
    /// against running firecracker processes.
    #[arg(long, group = "target")]
    sandbox: Option<String>,

    /// Skip confirmation prompt
    #[arg(long, short)]
    force: bool,
}

pub async fn run_kill(args: KillArgs, control: &dyn SandboxControl) -> RunnerResult<ExitCode> {
    let initial = discover_and_resolve_target(&args).await?;
    let is_initial_orphan = process::is_orphan(initial.target.pid, &initial.runner_pids).await;

    if !args.force {
        print_target_info(&initial.target, is_initial_orphan);
        if !confirm().await {
            println!("Aborted.");
            return Ok(ExitCode::SUCCESS);
        }
    }

    let current = match rediscover_same_target(&args, &initial.target).await {
        Ok(current) => current,
        Err(error) => {
            if error.allows_disappeared_orphan_cleanup() {
                if should_refuse_orphan_fallback(initial.target.run_id.as_deref()) {
                    println!(
                        "Refused to kill sandbox {} (PID {}) - {RUN_ORPHAN_FALLBACK_REFUSAL}",
                        initial.target.sandbox_id, initial.target.pid
                    );
                    return Ok(ExitCode::FAILURE);
                }
                if let Ok(refreshed) = rediscover_same_sandbox_process(&initial.target).await
                    && process::is_orphan(refreshed.target.pid, &refreshed.runner_pids).await
                {
                    let outcome =
                        kill_current_target(refreshed.target.clone(), true, control).await;
                    let exit_code =
                        finish_kill_outcome(&initial.target, &refreshed.target, &outcome, control)
                            .await;
                    info!(
                        sandbox_id = %refreshed.target.sandbox_id,
                        pid = refreshed.target.pid,
                        orphan = true,
                        rediscover_error = %error,
                        outcome = ?outcome,
                        "kill command fell back to owner-aware orphan handling after target rediscovery failed"
                    );
                    return Ok(exit_code);
                }

                if let Some(orphan_outcome) =
                    orphan::confirmed_disappeared_outcome(&initial.target, is_initial_orphan).await
                {
                    let outcome = KillOutcome::from(orphan_outcome);
                    let exit_code =
                        finish_kill_outcome(&initial.target, &initial.target, &outcome, control)
                            .await;
                    info!(
                        sandbox_id = %initial.target.sandbox_id,
                        pid = initial.target.pid,
                        orphan = true,
                        rediscover_error = %error,
                        outcome = ?outcome,
                        "kill command cleaned up orphan target that disappeared during rediscovery"
                    );
                    return Ok(exit_code);
                }
            }
            println!(
                "Refused to kill sandbox {} (PID {}) - {error}",
                initial.target.sandbox_id, initial.target.pid
            );
            return Ok(ExitCode::FAILURE);
        }
    };
    let is_orphan = process::is_orphan(current.target.pid, &current.runner_pids).await;
    let outcome = kill_current_target(current.target.clone(), is_orphan, control).await;
    let exit_code = finish_kill_outcome(&initial.target, &current.target, &outcome, control).await;

    info!(
        sandbox_id = %current.target.sandbox_id,
        pid = current.target.pid,
        orphan = is_orphan,
        outcome = ?outcome,
        "kill command completed"
    );

    Ok(exit_code)
}

#[derive(Debug)]
enum KillOutcome {
    OwnerAccepted(RemoteKillResult),
    OrphanKilled(KillTarget),
    OrphanAlreadyExited(KillTarget),
    OrphanTerminationUnconfirmed {
        target: KillTarget,
        failure: OrphanExitFailure,
    },
    AlreadyExitedOrChanged(KillTarget),
    SignalFailed(KillTarget),
    RefusedManagedIdle,
    RefusedManagedControlFailed(String),
    RefusedTargetChanged(String),
}

impl From<OrphanOutcome> for KillOutcome {
    fn from(outcome: OrphanOutcome) -> Self {
        match outcome {
            OrphanOutcome::Killed(target) => Self::OrphanKilled(target),
            OrphanOutcome::AlreadyExited(target) => Self::OrphanAlreadyExited(target),
            OrphanOutcome::TerminationUnconfirmed { target, failure } => {
                Self::OrphanTerminationUnconfirmed { target, failure }
            }
            OrphanOutcome::AlreadyExitedOrChanged(target) => Self::AlreadyExitedOrChanged(target),
            OrphanOutcome::SignalFailed(target) => Self::SignalFailed(target),
        }
    }
}

fn should_refuse_orphan_fallback(run_id: Option<&str>) -> bool {
    run_id.is_some()
}

async fn kill_current_target(
    current: KillTarget,
    is_orphan: bool,
    control: &dyn SandboxControl,
) -> KillOutcome {
    let rediscovery_target = current.clone();
    kill_current_target_with_orphan_fallback(
        current,
        is_orphan,
        control,
        move || async move { rediscover_same_sandbox_process(&rediscovery_target).await },
        |pid, runner_pids| async move { process::is_orphan(pid, &runner_pids).await },
        |target| async move { orphan::terminate(&target).await },
        process::discover_all_with_status,
    )
    .await
}

async fn kill_current_target_with_orphan_fallback<
    Rediscover,
    RediscoverFuture,
    IsOrphan,
    IsOrphanFuture,
    Terminate,
    TerminateFuture,
    Discover,
    DiscoverFuture,
>(
    current: KillTarget,
    is_orphan: bool,
    control: &dyn SandboxControl,
    rediscover: Rediscover,
    classify_orphan: IsOrphan,
    terminate: Terminate,
    discover: Discover,
) -> KillOutcome
where
    Rediscover: FnOnce() -> RediscoverFuture,
    RediscoverFuture:
        std::future::Future<Output = Result<ResolvedKillTarget, RediscoverTargetError>>,
    IsOrphan: FnOnce(u32, Vec<u32>) -> IsOrphanFuture,
    IsOrphanFuture: std::future::Future<Output = bool>,
    Terminate: FnOnce(KillTarget) -> TerminateFuture,
    TerminateFuture: std::future::Future<Output = OrphanOutcome>,
    Discover: FnOnce() -> DiscoverFuture,
    DiscoverFuture: std::future::Future<Output = process::ProcessDiscovery>,
{
    let owner_error = match control.kill_remote(current.control_target()).await {
        Ok(RemoteKillResult::RefusedIdle) => return KillOutcome::RefusedManagedIdle,
        Ok(result) => return KillOutcome::OwnerAccepted(result),
        Err(error) => error,
    };
    let refreshed = match rediscover().await {
        Ok(refreshed) => refreshed,
        Err(error) => {
            if should_refuse_orphan_fallback(current.run_id.as_deref()) {
                return KillOutcome::RefusedTargetChanged(RUN_ORPHAN_FALLBACK_REFUSAL.into());
            }
            if is_orphan && error.allows_disappeared_orphan_cleanup() {
                let outcome = orphan::confirmed_disappeared_outcome_with_discovery(
                    &current, is_orphan, discover,
                )
                .await
                .unwrap_or_else(|| OrphanOutcome::AlreadyExitedOrChanged(current.clone()));
                return KillOutcome::from(outcome);
            }
            return KillOutcome::RefusedTargetChanged(error.to_string());
        }
    };
    let ResolvedKillTarget {
        target: refreshed,
        runner_pids,
    } = refreshed;
    if !classify_orphan(refreshed.pid, runner_pids).await {
        return KillOutcome::RefusedManagedControlFailed(owner_error.to_string());
    }
    if should_refuse_orphan_fallback(current.run_id.as_deref()) {
        return KillOutcome::RefusedTargetChanged(RUN_ORPHAN_FALLBACK_REFUSAL.into());
    }

    KillOutcome::from(terminate(refreshed).await)
}

async fn finish_kill_outcome(
    initial: &KillTarget,
    current: &KillTarget,
    outcome: &KillOutcome,
    control: &dyn SandboxControl,
) -> ExitCode {
    if report_kill_outcome(initial, current, outcome, control).await {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn report_kill_outcome(
    initial: &KillTarget,
    current: &KillTarget,
    outcome: &KillOutcome,
    control: &dyn SandboxControl,
) -> bool {
    match outcome {
        KillOutcome::OwnerAccepted(RemoteKillResult::Accepted) => {
            println!(
                "Owning runner accepted kill for sandbox {} (PID {}).",
                current.sandbox_id, current.pid
            );
            println!("Owning runner will handle cleanup.");
            true
        }
        KillOutcome::OwnerAccepted(RemoteKillResult::AlreadyStopped) => {
            println!(
                "Sandbox {} is already stopping or stopped.",
                current.sandbox_id
            );
            println!("Owning runner will handle cleanup.");
            true
        }
        KillOutcome::OrphanKilled(target) => {
            println!(
                "Killed orphan sandbox {} (PID {})",
                target.sandbox_id, target.pid
            );
            cleanup_validated_orphan(target, control).await
        }
        KillOutcome::OrphanAlreadyExited(target) => {
            println!(
                "Orphan sandbox {} (PID {}) already exited before signal.",
                target.sandbox_id, target.pid
            );
            cleanup_validated_orphan(target, control).await
        }
        KillOutcome::OrphanTerminationUnconfirmed { target, failure } => {
            println!(
                "Failed to confirm termination of orphan sandbox {} (PID {}) - {failure}",
                target.sandbox_id, target.pid
            );
            println!("Preserved orphan workspace and runtime state for recovery.");
            false
        }
        KillOutcome::AlreadyExitedOrChanged(target) => {
            println!(
                "Refused to kill sandbox {} (PID {}) - process already exited or changed identity",
                target.sandbox_id, target.pid
            );
            false
        }
        KillOutcome::SignalFailed(target) => {
            println!(
                "Failed to kill sandbox {} (PID {})",
                target.sandbox_id, target.pid
            );
            false
        }
        KillOutcome::RefusedManagedControlFailed(error) => {
            println!(
                "Refused direct kill for managed sandbox {} (PID {}) - owning runner control failed: {error}",
                current.sandbox_id, current.pid
            );
            false
        }
        KillOutcome::OwnerAccepted(RemoteKillResult::RefusedIdle)
        | KillOutcome::RefusedManagedIdle => {
            println!(
                "Refused to kill managed idle sandbox {} (PID {}) - owning runner still owns its resources",
                current.sandbox_id, current.pid
            );
            println!(
                "Use runner drain/shutdown or wait for idle eviction so the owner can destroy it cleanly."
            );
            false
        }
        KillOutcome::RefusedTargetChanged(error) => {
            println!(
                "Refused to kill sandbox {} (PID {}) - {error}",
                initial.sandbox_id, initial.pid
            );
            false
        }
    }
}

async fn cleanup_validated_orphan(target: &KillTarget, control: &dyn SandboxControl) -> bool {
    if let Some(base_dir) = target.base_dir.as_deref() {
        let results = cleanup_orphan(&target.sandbox_id, base_dir, control).await;
        print_cleanup_results(&results)
    } else {
        println!("Skipped orphan cleanup because sandbox workspace identity is unavailable.");
        false
    }
}

fn print_cleanup_results(results: &[(String, bool)]) -> bool {
    if results.is_empty() {
        return true;
    }

    println!("Orphan cleanup:");
    for (step, success) in results {
        let icon = if *success { "ok" } else { "FAIL" };
        println!("  [{icon}] {step}");
    }
    results.iter().all(|(_, success)| *success)
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

async fn cleanup_orphan(
    sandbox_id: &str,
    base_dir: &Path,
    control: &dyn SandboxControl,
) -> Vec<(String, bool)> {
    let mut results = Vec::new();

    // Workspace dir
    let workspace = base_dir.join("workspaces").join(sandbox_id);
    let label = format!("Workspace: {}", workspace.display());
    let success = remove_dir_if_exists(&workspace).await;
    results.push((label, success));

    // Socket dir
    let sock_dir = control.runtime_dir(sandbox_id);
    let label = format!("Socket dir: {}", sock_dir.display());
    let success = remove_dir_if_exists(&sock_dir).await;
    results.push((label, success));

    results
}

/// Remove a directory, treating `NotFound` as success.
async fn remove_dir_if_exists(path: &Path) -> bool {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "failed to remove directory");
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

fn print_target_info(fc: &KillTarget, is_orphan: bool) {
    println!("Kill sandbox {}?", fc.sandbox_id);
    println!("  PID:    {}", fc.pid);
    if is_orphan {
        println!("  Status: orphan (parent runner not running)");
    } else {
        let ppid_str = fc.ppid.map_or("unknown".into(), |p| p.to_string());
        println!("  Status: managed by runner (PID {ppid_str})");
    }
    println!();
}

async fn confirm() -> bool {
    tokio::task::spawn_blocking(|| {
        use std::io::Write;
        print!("Proceed? [y/N] ");
        let _ = std::io::stdout().flush();
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_err() {
            return false;
        }
        let trimmed = input.trim().to_lowercase();
        trimmed == "y" || trimmed == "yes"
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!(error = %e, "confirmation prompt failed");
        false
    })
}

#[cfg(test)]
mod tests;
