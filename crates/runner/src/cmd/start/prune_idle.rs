//! One-shot exact reclamation, independently scheduled from the reactor.

use std::sync::Arc;

use tokio::net::UnixStream;
use tokio::sync::OwnedSemaphorePermit;

use crate::idle_prune_control::{read_request, write_response};
use crate::lifecycle::{LifecycleController, RunnerMode};
use crate::status::StatusTracker;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_supervisor::idle_lifecycle::{
    IdleDestroyTracker, SharedIdlePool, prune_exact_idle_pool,
};

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
        Ok(()) => prune_exact_idle_pool(&context.pool, &context.status, &context.tracker).await,
    };
    if let Err(error) = write_response(&mut stream, &response).await {
        tracing::warn!(%error, "could not acknowledge idle pruning; admitted cleanup has finished");
    }
}
