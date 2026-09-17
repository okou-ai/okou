//! Bounded delivery wake admission and observations for one frozen addon launch.

use std::io;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::task::AbortOnDropHandle;
use tracing::{error, info};

use super::control::{self, ControlTarget};

const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
const BUSY_POLL: Duration = Duration::from_millis(200);

#[derive(Clone)]
pub(crate) struct DeliveryTarget(pub(super) ControlTarget);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Outcomes {
    success: u64,
    retryable_failure: u64,
    permanent_failure: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    flows: u64,
    buffered: u64,
    reports: u64,
    outcomes: Outcomes,
    worker_active: bool,
    wake_pending: bool,
    closed: bool,
    flush_failures: u64,
    drain_active: bool,
}

impl Snapshot {
    fn quiescent(&self) -> bool {
        self.flows == 0
            && self.buffered == 0
            && self.reports == 0
            && !self.worker_active
            && !self.wake_pending
            && !self.closed
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Drain {
    Quiescent { snapshot: Snapshot },
    Deadline { snapshot: Snapshot },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FlushAdmission {
    state: Admission,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Admission {
    Admitted,
    Coalesced,
}

/// One socket request and at most one queued wake, owned by the proxy lifecycle.
pub(super) struct FlushTask {
    sender: mpsc::Sender<ControlTarget>,
    _task: AbortOnDropHandle<()>,
}

impl FlushTask {
    pub fn new() -> Self {
        let (sender, mut receiver) = mpsc::channel::<ControlTarget>(1);
        let task = tokio::spawn(async move {
            while let Some(target) = receiver.recv().await {
                let result: io::Result<FlushAdmission> = control::exchange(
                    &target.directory,
                    &target.generation,
                    "delivery.flush",
                    serde_json::json!({}),
                    Instant::now() + CONNECTION_TIMEOUT,
                )
                .await;
                match result {
                    Ok(FlushAdmission {
                        state: Admission::Admitted | Admission::Coalesced,
                    }) => {}
                    Err(error) => error!(
                        r#type = "usage_underbilling",
                        reason = "usage_flush_request_failed",
                        underbilling_class = "risk",
                        component = "runner",
                        generation = %target.generation,
                        %error,
                        "delivery flush admission unconfirmed; request will not be replayed"
                    ),
                }
            }
        });
        Self {
            sender,
            _task: AbortOnDropHandle::new(task),
        }
    }

    pub fn request(&self, target: ControlTarget) -> bool {
        match self.sender.try_send(target) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => true,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
}

impl DeliveryTarget {
    pub async fn drain(&self) -> bool {
        match self.observe_drain(Instant::now() + DRAIN_TIMEOUT).await {
            Ok(snapshot) => {
                info!(
                    drain_active = snapshot.drain_active,
                    success = snapshot.outcomes.success,
                    retryable_failure = snapshot.outcomes.retryable_failure,
                    permanent_failure = snapshot.outcomes.permanent_failure,
                    flush_failures = snapshot.flush_failures,
                    "proxy delivery is quiescent; counters are not an all-delivered receipt"
                );
                true
            }
            Err(error) => {
                error!(
                    r#type = "usage_underbilling",
                    reason = "usage_flush_unconfirmed",
                    underbilling_class = "risk",
                    component = "runner",
                    generation = %self.0.generation,
                    %error,
                    "proxy delivery drain unconfirmed; proceeding with bounded proxy stop"
                );
                false
            }
        }
    }

    async fn observe_drain(&self, deadline: Instant) -> io::Result<Snapshot> {
        loop {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "delivery observation deadline",
                ));
            }
            let observation = control::exchange(
                &self.0.directory,
                &self.0.generation,
                "delivery.drain",
                serde_json::json!({}),
                deadline.min(Instant::now() + CONNECTION_TIMEOUT),
            )
            .await;
            match observation {
                Ok(Drain::Quiescent { snapshot }) if snapshot.quiescent() => return Ok(snapshot),
                Ok(Drain::Quiescent { .. }) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "inconsistent addon delivery quiescence",
                    ));
                }
                Ok(Drain::Deadline { snapshot }) => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("delivery observation deadline: {snapshot:?}"),
                        ));
                    }
                }
                Err(error) if control::is_busy(&error) && Instant::now() < deadline => {}
                Err(error) => return Err(error),
            }
            // Continue only after a correlated, known result, never reply loss.
            tokio::time::sleep_until(deadline.min(Instant::now() + BUSY_POLL)).await;
        }
    }
}

#[cfg(test)]
mod tests;
