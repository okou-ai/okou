//! Exclusive custody of the supervisor's subscription, connect task or retry deadline.

use std::time::{Duration, Instant};

use ably_subscriber::{Event, SubscribeConfig, Subscription};
use tokio::task::JoinHandle;
use tracing::info;

use super::{ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX};

enum Phase {
    Subscribed(Subscription),
    Connecting(JoinHandle<Result<Subscription, ably_subscriber::Error>>),
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
            self.phase = Phase::Connecting(tokio::spawn(ably_subscriber::subscribe(config())));
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
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use tokio::sync::{Notify, Semaphore};
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    use super::*;

    struct TokenCall(Arc<AtomicBool>);

    impl Drop for TokenCall {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    fn blocked_token_config(
        started: Arc<Notify>,
        release: Arc<Semaphore>,
        retired: Arc<AtomicBool>,
    ) -> SubscribeConfig {
        SubscribeConfig::new(
            Box::new(move || {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                let retired = Arc::clone(&retired);
                Box::pin(async move {
                    let _call = TokenCall(retired);
                    started.notify_one();
                    let _permit = release.acquire().await.unwrap();
                    Err(std::io::Error::other("synthetic token failure").into())
                })
            }),
            "connection-custody-fixture",
        )
    }

    #[tokio::test]
    async fn cancelled_observation_preserves_connect_until_token_result() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let retired = Arc::new(AtomicBool::new(false));
        let mut connection = AblyConnection::new(None);
        connection.start_if_due(|| {
            blocked_token_config(
                Arc::clone(&started),
                Arc::clone(&release),
                Arc::clone(&retired),
            )
        });
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        {
            let observation = connection.next();
            tokio::pin!(observation);
            assert!(futures_util::poll!(&mut observation).is_pending());
        }
        assert!(!retired.load(Ordering::Acquire));
        release.add_permits(1);
        let result = tokio::time::timeout(Duration::from_secs(2), connection.next())
            .await
            .unwrap();
        assert!(
            matches!(result, ConnectionEvent::ConnectResult(Err(error)) if error.contains("synthetic token failure"))
        );
        assert!(retired.load(Ordering::Acquire));
        connection.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_retires_pending_token_call_before_returning() {
        let started = Arc::new(Notify::new());
        let retired = Arc::new(AtomicBool::new(false));
        let mut connection = AblyConnection::new(None);
        connection.start_if_due(|| {
            blocked_token_config(
                Arc::clone(&started),
                Arc::new(Semaphore::new(0)),
                Arc::clone(&retired),
            )
        });
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), connection.shutdown())
            .await
            .unwrap();
        assert!(retired.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn failed_connect_retries_after_its_deadline() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut connection = AblyConnection::new(None);
        for expected_attempts in 1..=2 {
            connection.start_if_due(|| {
                let attempts = Arc::clone(&attempts);
                SubscribeConfig::new(
                    Box::new(move || {
                        attempts.fetch_add(1, Ordering::AcqRel);
                        Box::pin(async {
                            Err(std::io::Error::other("synthetic retry failure").into())
                        })
                    }),
                    "retry-deadline-fixture",
                )
            });
            let result = tokio::time::timeout(Duration::from_secs(2), connection.next())
                .await
                .unwrap();
            assert!(
                matches!(result, ConnectionEvent::ConnectResult(Err(error)) if error.contains("synthetic retry failure"))
            );
            assert_eq!(attempts.load(Ordering::Acquire), expected_attempts);
            if expected_attempts == 1 {
                // The completed task has retired; the same observer now waits
                // for the production backoff before a second token request.
                let event = tokio::time::timeout(
                    ABLY_BACKOFF_INITIAL + Duration::from_secs(2),
                    connection.next(),
                )
                .await
                .unwrap();
                assert!(matches!(event, ConnectionEvent::RetryDue));
            }
        }
        connection.shutdown().await;
    }

    #[test]
    fn retryable_connect_failure_logs_info_with_retry_details() {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            let mut connection = AblyConnection::new(None);
            let error = "token exchange transport failed".to_string();
            assert_eq!(connection.complete_connect(Err(error.clone())), Err(error));
        });
        let events = captured.entries();
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("ably connect failed")
        );
        assert_eq!(
            event.fields.get("error").map(String::as_str),
            Some("token exchange transport failed")
        );
        assert_eq!(event.fields.get("failures").map(String::as_str), Some("1"));
        assert_eq!(
            event.fields.get("next_attempt_secs").map(String::as_str),
            Some("5")
        );
    }

    #[test]
    fn backoff_starts_at_initial_delay_without_failures() {
        let backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        assert_eq!(backoff.delay, Duration::from_secs(1));
        assert_eq!(backoff.failures, 0);
    }

    #[test]
    fn failure_uses_current_delay_then_doubles_it() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        assert_eq!(backoff.failed(), Duration::from_secs(1));
        assert_eq!(backoff.delay, Duration::from_secs(2));
        assert_eq!(backoff.failures, 1);
    }

    #[test]
    fn failure_caps_backoff_at_maximum() {
        let mut backoff = Backoff::new(Duration::from_secs(4), Duration::from_secs(4));
        assert_eq!(backoff.failed(), Duration::from_secs(4));
        assert_eq!(backoff.delay, Duration::from_secs(4));
    }

    #[test]
    fn success_resets_delay_and_failures() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        for _ in 0..5 {
            backoff.failed();
        }
        backoff.reset();
        assert_eq!(backoff.delay, Duration::from_secs(1));
        assert_eq!(backoff.failures, 0);
    }

    #[test]
    fn backoff_doubles_up_to_maximum() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(8));
        for seconds in [1, 2, 4, 8, 8] {
            assert_eq!(backoff.failed(), Duration::from_secs(seconds));
        }
    }

    #[test]
    fn repeated_failures_keep_retrying() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        for failure in 1..=100 {
            let delay = backoff.delay;
            assert_eq!(backoff.failed(), delay);
            assert_eq!(backoff.failures, failure);
        }
    }
}
