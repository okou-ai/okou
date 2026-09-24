//! One-shot exact reclamation, independently scheduled from the reactor.

use std::sync::Arc;

use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::net::UnixStream;
use tokio::sync::OwnedSemaphorePermit;

use crate::idle_pool::DestroyOutcome;
use crate::idle_prune_control::{PruneIdleReport, PruneIdleResponse, read_request, write_response};
use crate::lifecycle::{LifecycleController, RunnerMode};
use crate::status::StatusTracker;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_supervisor::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool};

pub(super) struct PruneIdleContext {
    pub identity: RunnerProcessIdentity,
    pub pool: SharedIdlePool,
    pub status: Arc<StatusTracker>,
    pub lifecycle: LifecycleController,
    pub tracker: IdleDestroyTracker,
}

pub(super) async fn handle(
    mut stream: UnixStream,
    context: PruneIdleContext,
    _permit: OwnedSemaphorePermit,
) {
    let response = match read_request(&mut stream, context.identity).await {
        Err(error) => Err(error.to_string()),
        Ok(()) if context.lifecycle.current_mode() != RunnerMode::Running => {
            Err("runner is not running; idle pruning was not started".into())
        }
        Ok(()) => prune(&context).await,
    };
    if let Err(error) = write_response(&mut stream, &response).await {
        tracing::warn!(%error, "could not acknowledge idle pruning; admitted cleanup has finished");
    }
}

async fn prune(context: &PruneIdleContext) -> PruneIdleResponse {
    let (jobs, snapshot) = {
        let mut pool = context.pool.lock().await;
        let jobs = pool.drain_exact();
        (jobs, pool.status_snapshot())
    };
    let mut report = PruneIdleReport {
        selected: jobs.len(),
        completed: 0,
        uncertain: 0,
    };
    // Transfer every selected resource to an independent task before any I/O.
    // Neither a disconnected client nor a failed status write may drop jobs
    // without destruction or release their budget ahead of physical cleanup.
    let mut tasks: FuturesUnordered<_> = jobs
        .into_iter()
        .map(|job| {
            tokio::spawn(async move { job.run_retaining_lease("operator_prune_idle").await })
        })
        .collect();
    context.tracker.notify_reuse_state();
    let status_result = context.status.set_idle_snapshot(snapshot).await;
    while let Some(result) = tasks.next().await {
        match result {
            Ok(result) => {
                match result.outcome {
                    DestroyOutcome::Completed => report.completed += 1,
                    DestroyOutcome::Uncertain => report.uncertain += 1,
                }
                if result.workspace_cache_promoted {
                    context.tracker.notify_reuse_state();
                }
                drop(result.budget_lease);
            }
            Err(error) => {
                report.uncertain += 1;
                tracing::warn!(%error, "idle prune destruction task failed");
            }
        }
    }
    tracing::info!(
        selected = report.selected,
        completed = report.completed,
        uncertain = report.uncertain,
        "exact idle pruning finished"
    );
    status_result
        .map_err(|error| format!("idle pruning finished but status publication failed: {error}"))?;
    Ok(report)
}
