//! Exclusive custody of the supervisor's subscription, connect task or retry deadline.

use std::time::{Duration, Instant};

use ably_subscriber::{Event, SubscribeConfig, Subscription};
use tokio_util::task::AbortOnDropHandle;
use tracing::info;

use super::{ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX};

enum Phase {
    Subscribed(Subscription),
    // Retain abort custody when the owner or its consuming shutdown is dropped.
    Connecting(AbortOnDropHandle<Result<Subscription, ably_subscriber::Error>>),
    WaitingUntil(Instant),
}

pub(super) struct AblyConnection {
    phase: Phase,
    backoff: Backoff,
}

pub(super) enum ConnectionEvent {
    Subscription(Option<Event>),
    ConnectResult(Result<(), String>),
    RetryDue,
}

impl AblyConnection {
    pub(super) fn new(subscription: Option<Subscription>) -> Self {
        Self {
            phase: match subscription {
                Some(subscription) => Phase::Subscribed(subscription),
                None => Phase::WaitingUntil(Instant::now()),
            },
            backoff: Backoff::new(ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX),
        }
    }

    pub(super) fn start_if_due(&mut self, config: impl FnOnce() -> SubscribeConfig) {
        if matches!(self.phase, Phase::WaitingUntil(at) if Instant::now() >= at) {
            self.phase = Phase::Connecting(AbortOnDropHandle::new(tokio::spawn(
                ably_subscriber::subscribe(config()),
            )));
        }
    }

    /// Observe in place so losing an outer select preserves the active resource.
    pub(super) async fn next(&mut self) -> ConnectionEvent {
        let result = match &mut self.phase {
            Phase::Subscribed(subscription) => {
                return ConnectionEvent::Subscription(subscription.next().await);
            }
            Phase::WaitingUntil(at) => {
                tokio::time::sleep_until(tokio::time::Instant::from_std(*at)).await;
                return ConnectionEvent::RetryDue;
            }
            Phase::Connecting(task) => match task.await {
                Ok(Ok(subscription)) => Ok(subscription),
                Ok(Err(error)) => Err(error.to_string()),
                Err(error) => Err(format!("retry task panicked: {error}")),
            },
        };
        // Retire the completed handle synchronously before another observation.
        ConnectionEvent::ConnectResult(self.complete_connect(result))
    }

    pub(super) fn retry(&mut self) {
        self.phase = Phase::WaitingUntil(Instant::now() + self.backoff.delay);
    }

    fn complete_connect(&mut self, result: Result<Subscription, String>) -> Result<(), String> {
        match result {
            Ok(subscription) => {
                if self.backoff.failures > 0 {
                    info!(
                        target: "runner_provider::provider::api_ably_supervisor",
                        attempts = self.backoff.failures,
                        "ably connected after failures"
                    );
                } else {
                    info!(target: "runner_provider::provider::api_ably_supervisor", "ably connected");
                }
                self.phase = Phase::Subscribed(subscription);
                self.backoff.reset();
                Ok(())
            }
            Err(error) => {
                let delay = self.backoff.failed();
                self.phase = Phase::WaitingUntil(Instant::now() + delay);
                info!(
                    target: "runner_provider::provider::api_ably_supervisor",
                    error = %error,
                    failures = self.backoff.failures,
                    next_attempt_secs = delay.as_secs(),
                    "ably connect failed"
                );
                Err(error)
            }
        }
    }

    pub(super) async fn shutdown(self) {
        match self.phase {
            Phase::Subscribed(subscription) => subscription.close(),
            Phase::Connecting(task) => {
                task.abort();
                let _ = task.await;
            }
            Phase::WaitingUntil(_) => {}
        }
    }
}

struct Backoff {
    delay: Duration,
    initial: Duration,
    max: Duration,
    failures: u32,
}

impl Backoff {
    fn new(initial: Duration, max: Duration) -> Self {
        Self {
            delay: initial,
            initial,
            max,
            failures: 0,
        }
    }

    fn failed(&mut self) -> Duration {
        let delay = self.delay;
        self.failures += 1;
        self.delay = (delay * 2).min(self.max);
        delay
    }

    fn reset(&mut self) {
        self.delay = self.initial;
        self.failures = 0;
    }
}

#[cfg(test)]
mod tests;
