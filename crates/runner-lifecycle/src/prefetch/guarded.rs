//! Mandatory optional-read admission and physical producer custody.

use std::path::Path;
use std::sync::Arc;

use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

use crate::host_memory_operations::{
    MemoryOperationError, MemoryOperationPlan, MemoryOperationTask,
};
use crate::host_memory_pressure::{HostPressureState, OptionalPressureControl};

use super::outcome_accounting::ReaderAccounting;
use super::*;

pub struct GuardedPrefetchConfig {
    pub pressure: OptionalPressureControl,
    /// Positive supplied/measured overhead in addition to the complete declared
    /// snapshot bound. It must include at least the retained read buffer.
    pub overhead_bytes: u64,
}

/// Actual read/ownership outcomes, never resident cache or released-byte proof.
#[derive(Clone, Debug, Default)]
pub struct GuardedPrefetchSnapshot {
    pub accepted: usize,
    pub completed: usize,
    pub cancelled: usize,
    pub failed: usize,
    pub uncertain: usize,
    pub deferred: usize,
    /// Total consumed bytes, including partial cancelled and failed reads.
    pub read_bytes: u64,
    pub last_error: Option<String>,
    pub finished: bool,
}

struct ReadResult {
    outcome: PrefetchOutcome,
    settlement: Result<(), MemoryOperationError>,
}

impl MemoryPrefetchTasks {
    /// Same concrete lifecycle owner, with mandatory original-authority inputs.
    /// The production root installs complete policy separately in P4.
    pub fn spawn_guarded(
        candidates: impl IntoIterator<Item = MemoryPrefetchCandidate>,
        budget_mb: u64,
        config: GuardedPrefetchConfig,
    ) -> Result<(Self, watch::Receiver<GuardedPrefetchSnapshot>), MemoryOperationError> {
        Self::spawn_guarded_with(candidates, budget_mb, config, read_bounded)
    }

    pub(super) fn spawn_guarded_with<F>(
        candidates: impl IntoIterator<Item = MemoryPrefetchCandidate>,
        budget_mb: u64,
        config: GuardedPrefetchConfig,
        read: F,
    ) -> Result<(Self, watch::Receiver<GuardedPrefetchSnapshot>), MemoryOperationError>
    where
        F: Fn(&Path, u64, &CancellationToken, &OptionalPressureControl) -> PrefetchOutcome
            + Send
            + Sync
            + 'static,
    {
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| MemoryOperationError::NoRuntime)?;
        if config.overhead_bytes < MEMORY_PREFETCH_CHUNK_BYTES as u64 {
            return Err(MemoryOperationError::UnsupportedGrowth);
        }
        let selected = select_candidates(candidates, budget_mb, MEMORY_PREFETCH_CONCURRENCY);
        let cancel = CancellationToken::new();
        let physical_io = TaskTracker::new();
        let (publish, latest) = watch::channel(GuardedPrefetchSnapshot::default());
        let task_cancel = cancel.clone();
        let tracked = physical_io.clone();
        let producer = physical_io.token();
        let handles = vec![runtime.spawn(async move {
            let _producer = producer;
            run(
                selected,
                config,
                task_cancel,
                tracked,
                publish,
                Arc::new(read),
            )
            .await;
        })];
        Ok((
            Self {
                cancel,
                handles,
                physical_io,
                #[cfg(any(test, feature = "test-support"))]
                startup_observer: None,
            },
            latest,
        ))
    }
}

async fn run<F>(
    candidates: Vec<MemoryPrefetchCandidate>,
    config: GuardedPrefetchConfig,
    cancel: CancellationToken,
    physical_io: TaskTracker,
    publish: watch::Sender<GuardedPrefetchSnapshot>,
    read: Arc<F>,
) where
    F: Fn(&Path, u64, &CancellationToken, &OptionalPressureControl) -> PrefetchOutcome
        + Send
        + Sync
        + 'static,
{
    let mut pending = candidates.into_iter().peekable();
    let pressure = config.pressure;
    let stopped = pressure.stopped();
    let operations = pressure.operations();
    let mut ticks = tokio::time::interval(pressure.policy().optional_start_interval);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut report = GuardedPrefetchSnapshot::default();
    while let Some(candidate) = pending.peek() {
        let changed = pressure.changed();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if cancel.is_cancelled() || stopped.is_cancelled() {
            break;
        }
        let max_bytes = u64::from(candidate.memory_mb) * 1024 * 1024;
        let Some(growth_bytes) = max_bytes
            .checked_add(config.overhead_bytes)
            .filter(|_| max_bytes > 0)
        else {
            report.failed += 1;
            report.last_error = Some(MemoryOperationError::UnsupportedGrowth.to_string());
            publish.send_replace(report.clone());
            pending.next();
            continue;
        };
        let opportunity = match pressure.take_optional_start() {
            Ok(Some(opportunity)) => opportunity,
            Ok(None) => {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => break,
                    () = stopped.cancelled() => break,
                    _ = &mut changed => {},
                    _ = ticks.tick() => {},
                }
                continue;
            }
            Err(error) => {
                report.last_error = Some(error.to_string());
                break;
            }
        };
        let grant = async {
            let mut request = operations.request(MemoryOperationPlan::HostIo { growth_bytes })?;
            let mut permit = request.try_grant().await?;
            permit.refresh().await?;
            if !opportunity.revalidate()? {
                return Err(MemoryOperationError::ResourceChanged);
            }
            Ok(permit)
        };
        let permit = tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            () = stopped.cancelled() => break,
            result = grant => match result {
                Ok(permit) => permit,
                Err(error) => {
                    if error == MemoryOperationError::UnsupportedGrowth {
                        report.failed += 1;
                        pending.next();
                    } else {
                        report.deferred += 1;
                    }
                    report.last_error = Some(error.to_string());
                    publish.send_replace(report.clone());
                    continue;
                }
            },
        };
        let current = match opportunity.revalidate() {
            Ok(current) => current,
            Err(error) => {
                report.last_error = Some(error.to_string());
                break;
            }
        };
        if cancel.is_cancelled() || !current {
            continue;
        }
        let Some(candidate) = pending.next() else {
            break;
        };
        let child_cancel = cancel.child_token();
        let physical = Arc::new(physical_io.token());
        let reader_token = physical.clone();
        let reader_cancel = child_cancel.clone();
        let reader_pressure = pressure.clone();
        let reader = read.clone();
        let task = permit.spawn(move |operation| async move {
            let _accepted = physical;
            let result = tokio::task::spawn_blocking(move || {
                let _physical = reader_token;
                // Blocking submission can itself wait. A recovered Ready state
                // cannot revive an offer revoked before its physical start.
                let outcome =
                    if reader_cancel.is_cancelled() || !opportunity.revalidate().unwrap_or(false) {
                        PrefetchOutcome::Cancelled { bytes: 0 }
                    } else {
                        reader(&candidate.path, max_bytes, &reader_cancel, &reader_pressure)
                    };
                (operation, outcome)
            })
            .await;
            let (mut operation, outcome) =
                result.map_err(|_| MemoryOperationError::ProducerLost)?;
            let settlement = operation.complete_phase().await;
            Ok::<_, MemoryOperationError>(ReadResult {
                outcome,
                settlement,
            })
        });
        let task = match task {
            Ok(task) => task,
            Err(error) => {
                report.failed += 1;
                report.last_error = Some(error.to_string());
                publish.send_replace(report.clone());
                continue;
            }
        };
        report.accepted += 1;
        publish.send_replace(report.clone());
        let result = join_read(task, &pressure, &child_cancel, &cancel, &stopped).await;
        match result {
            Ok(Ok(result)) => {
                if let Err(error) = result.settlement {
                    report.uncertain += 1;
                    report.last_error = Some(error.to_string());
                }
                ReaderAccounting {
                    completed: &mut report.completed,
                    cancelled: &mut report.cancelled,
                    failed: &mut report.failed,
                    read_bytes: &mut report.read_bytes,
                    last_error: &mut report.last_error,
                }
                .record(&result.outcome);
            }
            Ok(Err(error)) | Err(error) => {
                report.uncertain += 1;
                report.last_error = Some(error.to_string());
            }
        }
        publish.send_replace(report.clone());
    }
    report.finished = true;
    publish.send_replace(report);
}

async fn join_read(
    task: MemoryOperationTask<Result<ReadResult, MemoryOperationError>>,
    pressure: &OptionalPressureControl,
    child_cancel: &CancellationToken,
    cancel: &CancellationToken,
    stopped: &CancellationToken,
) -> Result<Result<ReadResult, MemoryOperationError>, MemoryOperationError> {
    let joined = task.join();
    tokio::pin!(joined);
    loop {
        let changed = pressure.changed();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if suppressed(pressure) {
            child_cancel.cancel();
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                child_cancel.cancel();
                return joined.await;
            }
            () = stopped.cancelled() => {
                child_cancel.cancel();
                return joined.await;
            }
            result = &mut joined => return result,
            _ = &mut changed => {},
        }
    }
}

fn suppressed(pressure: &OptionalPressureControl) -> bool {
    matches!(
        pressure.decision().state,
        HostPressureState::Critical | HostPressureState::Unknown
    )
}

fn read_bounded(
    path: &Path,
    max_bytes: u64,
    cancel: &CancellationToken,
    pressure: &OptionalPressureControl,
) -> PrefetchOutcome {
    read_bounded_observed(
        path,
        max_bytes,
        cancel,
        pressure,
        #[cfg(any(test, feature = "test-support"))]
        None,
    )
}

pub(super) fn read_bounded_observed(
    path: &Path,
    max_bytes: u64,
    cancel: &CancellationToken,
    pressure: &OptionalPressureControl,
    #[cfg(any(test, feature = "test-support"))] checkpoint: Option<&PrefetchReadCheckpoint>,
) -> PrefetchOutcome {
    super::bounded::read(
        path,
        max_bytes,
        || cancel.is_cancelled() || suppressed(pressure),
        #[cfg(any(test, feature = "test-support"))]
        checkpoint,
    )
}

#[cfg(test)]
mod tests;
