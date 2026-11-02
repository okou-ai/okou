//! One independently owned passive host observer. Its cache never grants growth.

use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use tokio::sync::watch;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::heartbeat::HEARTBEAT_PERIOD;

// Reporting/read bounds only, not calibrated actuator cadence or permission freshness.
const DIAGNOSTIC_MAX_AGE: Duration = HEARTBEAT_PERIOD.saturating_mul(2);

pub struct HostMemoryObserver {
    latest: watch::Receiver<HostMemoryObservation>,
    cancel: CancellationToken,
    task: AbortOnDropHandle<()>,
}

impl HostMemoryObserver {
    pub fn spawn() -> Self {
        Self::spawn_reader(|| Box::pin(HostMemoryObservation::read()))
    }

    fn spawn_reader(
        mut reader: impl FnMut() -> BoxFuture<'static, HostMemoryObservation> + Send + 'static,
    ) -> Self {
        let (sender, latest) = watch::channel(HostMemoryObservation::unknown(
            HostMemoryUnknown::NotObserved,
        ));
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(HEARTBEAT_PERIOD);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    () = task_cancel.cancelled() => break,
                    _ = ticks.tick() => {}
                }
                let mut reading = reader();
                let observation = tokio::select! {
                    biased;
                    () = task_cancel.cancelled() => break,
                    observation = &mut reading => observation,
                    () = tokio::time::sleep(HEARTBEAT_PERIOD) => {
                        sender.send_replace(HostMemoryObservation::unknown(HostMemoryUnknown::ReadTimeout));
                        tracing::info!(valid = false, pressure = "unknown", unknown_reason = "read_timeout", "host memory observation");
                        // Keep the same accepted read. A timeout invalidates the cache,
                        // but must not queue another procfs read behind blocked I/O.
                        tokio::select! {
                            biased;
                            () = task_cancel.cancelled() => break,
                            observation = reading => observation,
                        }
                    }
                };
                let now = Instant::now();
                let available = observation.available_bytes_at(now, DIAGNOSTIC_MAX_AGE);
                let pressure = match &available {
                    Ok(0) => "critical_zero",
                    Ok(_) => "uncalibrated",
                    Err(_) => "unknown",
                };
                tracing::info!(
                    mem_available_bytes = ?available.as_ref().ok(),
                    valid = available.is_ok(),
                    sample_age_ms = ?observation.age_at(now).map(|age| age.as_millis()),
                    read_duration_ms = observation.read_duration().as_millis(),
                    unknown_reason = ?available.as_ref().err(),
                    pressure,
                    "host memory observation"
                );
                sender.send_replace(observation);
            }
            sender.send_replace(HostMemoryObservation::unknown(
                HostMemoryUnknown::ObserverStopped,
            ));
            tracing::info!("host memory observer stopped");
        });
        Self {
            latest,
            cancel,
            task: AbortOnDropHandle::new(task),
        }
    }

    pub fn available_bytes(&self) -> Result<u64, HostMemoryUnknown> {
        if self.latest.has_changed().is_err() {
            return Err(HostMemoryUnknown::ObserverStopped);
        }
        self.latest
            .borrow()
            .available_bytes_at(Instant::now(), DIAGNOSTIC_MAX_AGE)
    }

    /// Observe actual reader completions without replacing the production reader.
    #[cfg(any(test, feature = "test-support"))]
    pub fn subscribe_for_test(&self) -> watch::Receiver<HostMemoryObservation> {
        self.latest.clone()
    }

    /// Every ordinary startup/reactor return cancels and positively joins this owner.
    pub async fn shutdown(self) -> Result<(), tokio::task::JoinError> {
        self.cancel.cancel();
        self.task.await
    }
}

#[cfg(test)]
mod tests;
