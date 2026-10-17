//! Test-only File producer and shared physical-custody assertions.

use std::time::Duration;

use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, GuardedPrefetchSnapshot, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::*;

pub(super) const CHUNK: u64 = 1024 * 1024;

pub(super) struct Reader {
    pub(super) owner: MemoryPrefetchTasks,
    pub(super) latest: watch::Receiver<GuardedPrefetchSnapshot>,
}

impl Reader {
    pub(super) fn spawn(
        path: std::path::PathBuf,
        config: GuardedPrefetchConfig,
        gate: Arc<foreground_io::Gate>,
    ) -> TestResult<Self> {
        let (owner, latest) = MemoryPrefetchTasks::spawn_guarded_with_read_checkpoint_for_test(
            [MemoryPrefetchCandidate {
                path,
                memory_mb: 4096,
            }],
            4096,
            config,
            Arc::new(move |bytes| {
                if bytes == CHUNK {
                    gate.blocking_wait()?;
                }
                Ok(())
            }),
        )?;
        Ok(Self { owner, latest })
    }

    pub(super) fn evidence(&self) -> Value {
        critical::read_evidence(&self.latest.borrow())
    }

    pub(super) fn require(&self, completed: bool, cancelled: bool, bytes: u64) -> TestResult<()> {
        let value = self.latest.borrow();
        if value.accepted != 1
            || value.completed != usize::from(completed)
            || value.cancelled != usize::from(cancelled)
            || value.read_bytes != bytes
            || value.failed != 0
            || value.uncertain != 0
            || value.finished != (completed || cancelled)
        {
            return Err(io::Error::other(format!(
                "shared actual reader outcome changed: {value:?}"
            ))
            .into());
        }
        Ok(())
    }
}

pub(super) fn accounting(
    context: &transitions::Context,
    readers: usize,
    growth: u64,
) -> TestResult<Value> {
    let value = context.operations.snapshot()?;
    if value.registered_operations != readers
        || value.started != readers
        || value.ordinary_growth_bytes != readers as u64 * growth
        || value.cleanup_growth_bytes != 0
        || value.uncertain != 0
        || value.tracked_tasks < readers
        || (readers == 0 && value.tracked_tasks != 0)
    {
        return Err(io::Error::other(format!(
            "shared actual readers lost aggregate custody: {value:?}"
        ))
        .into());
    }
    Ok(
        json!({"registered_operations": value.registered_operations, "started": value.started,
        "ordinary_growth_bytes": value.ordinary_growth_bytes, "tracked_tasks": value.tracked_tasks,
        "cleanup_growth_bytes": value.cleanup_growth_bytes, "uncertain": value.uncertain}),
    )
}

pub(super) async fn join_accounting(context: &transitions::Context) -> TestResult<()> {
    // Readers have positively drained. Result delivery can precede the last
    // P2 callback-tracking drop, which must finish before zero-custody evidence.
    tokio::time::timeout(Duration::from_secs(5), async {
        while context.operations.snapshot()?.tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
        Ok::<(), MemoryOperationError>(())
    })
    .await
    .map_err(io::Error::other)??;
    Ok(())
}
