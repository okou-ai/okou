//! Non-default observation after positive actual File bytes, before cancellation.

use std::{io, sync::Arc};

use tokio::sync::watch;

use super::*;

/// Receives cumulative actual bytes. Blocking here retains the same physical
/// producer and original ownership; it does not model a stalled storage read.
pub type PrefetchReadCheckpoint = Arc<dyn Fn(u64) -> io::Result<()> + Send + Sync>;

impl MemoryPrefetchTasks {
    /// The unadmitted baseline coordinator and File loop, with a fixture checkpoint.
    pub fn spawn_with_read_checkpoint_for_test(
        candidates: impl IntoIterator<Item = MemoryPrefetchCandidate>,
        budget_mb: u64,
        checkpoint: PrefetchReadCheckpoint,
    ) -> Self {
        Self::spawn_startup(candidates, budget_mb, Some(checkpoint))
    }

    /// The production guarded coordinator/File loop and original P2 custody.
    pub fn spawn_guarded_with_read_checkpoint_for_test(
        candidates: impl IntoIterator<Item = MemoryPrefetchCandidate>,
        budget_mb: u64,
        config: GuardedPrefetchConfig,
        checkpoint: PrefetchReadCheckpoint,
    ) -> Result<
        (Self, watch::Receiver<GuardedPrefetchSnapshot>),
        crate::host_memory_operations::MemoryOperationError,
    > {
        Self::spawn_guarded_with(
            candidates,
            budget_mb,
            config,
            move |path, max, cancel, pressure| {
                guarded::read_bounded_observed(path, max, cancel, pressure, Some(&checkpoint))
            },
        )
    }
}

#[cfg(test)]
mod tests;
