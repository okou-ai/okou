//! Generic backoff / retry state for restartable background tasks.

use std::time::{Duration, Instant};

/// Groups the backoff / retry state for a restartable background task.
pub(crate) struct RetryState<H> {
    pub(crate) handle: Option<H>,
    pub(crate) restart_at: Option<Instant>,
    pub(crate) backoff: Duration,
    backoff_initial: Duration,
    backoff_max: Duration,
    pub(crate) consecutive_failures: u32,
    /// `None` = retry forever (Ably), `Some(n)` = circuit breaker (mitm).
    max_failures: Option<u32>,
}

impl<H> RetryState<H> {
    pub(crate) fn new(initial: Duration, max: Duration, max_failures: Option<u32>) -> Self {
        Self {
            handle: None,
            restart_at: None,
            backoff: initial,
            backoff_initial: initial,
            backoff_max: max,
            consecutive_failures: 0,
            max_failures,
        }
    }

    /// Schedule a restart after the current backoff delay.
    pub(crate) fn schedule(&mut self) {
        self.restart_at = Some(Instant::now() + self.backoff);
    }

    /// Reset backoff and failure count after a successful restart.
    pub(crate) fn on_success(&mut self) {
        self.backoff = self.backoff_initial;
        self.consecutive_failures = 0;
    }

    /// Record a failure, double the backoff (capped), and schedule a retry.
    /// Returns `false` if the circuit breaker has tripped.
    #[must_use]
    pub(crate) fn on_failure(&mut self) -> bool {
        self.consecutive_failures += 1;
        if let Some(max) = self.max_failures
            && self.consecutive_failures >= max
        {
            return false;
        }
        self.schedule();
        self.backoff = (self.backoff * 2).min(self.backoff_max);
        true
    }

    /// Number of consecutive failures since the last success.
    pub(crate) fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    /// Current backoff duration (doubles on each failure, capped at max).
    pub(crate) fn backoff(&self) -> Duration {
        self.backoff
    }

    /// `true` if the restart timer has fired and no task is in flight.
    pub(crate) fn timer_ready(&self) -> bool {
        self.handle.is_none() && self.restart_at.is_some_and(|at| Instant::now() >= at)
    }

    /// Clear the timer after spawning a restart task.
    pub(crate) fn clear_timer(&mut self) {
        self.restart_at = None;
    }
}

/// Sleep until a restart timer fires, or pend forever if none is scheduled.
///
/// Free function (not a method) so the borrow on `restart_at` is disjoint
/// from `&mut retry.handle` inside `tokio::select!`.
pub(crate) async fn sleep_until_retry(restart_at: &Option<Instant>) {
    match restart_at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(*at)).await,
        None => std::future::pending().await,
    }
}

/// Await a background retry task, or pend forever if none is running.
pub(crate) async fn recv_retry<T, E: std::fmt::Display>(
    handle: &mut Option<tokio::task::JoinHandle<Result<T, E>>>,
) -> Result<T, String> {
    match handle {
        Some(h) => {
            let result = match h.await {
                Ok(Ok(val)) => Ok(val),
                Ok(Err(e)) => Err(e.to_string()),
                Err(e) => Err(format!("retry task panicked: {e}")),
            };
            *handle = None;
            result
        }
        None => std::future::pending().await,
    }
}

runner_test_group!(runtime_control; #[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_state_new_defaults() {
        let rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60), None);
        assert_eq!(rs.consecutive_failures, 0);
        assert!(rs.restart_at.is_none());
        assert!(rs.handle.is_none());
    }

    #[test]
    fn retry_state_on_failure_doubles_backoff() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60), None);
        let cont = rs.on_failure();
        assert!(cont);
        assert_eq!(rs.consecutive_failures, 1);
        assert_eq!(rs.backoff, Duration::from_secs(2));
        assert!(rs.restart_at.is_some());
    }

    #[test]
    fn retry_state_on_failure_caps_at_max() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(4), None);
        rs.backoff = Duration::from_secs(4);
        let _ = rs.on_failure();
        assert_eq!(rs.backoff, Duration::from_secs(4));
    }

    #[test]
    fn retry_state_circuit_breaker() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60), Some(3));
        rs.consecutive_failures = 2;
        let cont = rs.on_failure();
        assert!(!cont, "circuit breaker should trip at max_failures");
    }

    #[test]
    fn retry_state_on_success_resets() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60), None);
        rs.backoff = Duration::from_secs(32);
        rs.consecutive_failures = 10;
        rs.on_success();
        assert_eq!(rs.backoff, Duration::from_secs(1));
        assert_eq!(rs.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn timer_ready_requires_no_handle_and_past_restart() {
        let mut rs: RetryState<tokio::task::JoinHandle<()>> =
            RetryState::new(Duration::from_secs(0), Duration::from_secs(60), None);
        // No restart_at → not ready
        assert!(!rs.timer_ready());
        // Set restart_at to the past so it's immediately ready.
        rs.restart_at = Some(Instant::now() - Duration::from_secs(1));
        assert!(rs.timer_ready());

        rs.handle = Some(tokio::spawn(std::future::pending::<()>()));
        let ready_while_in_flight = rs.timer_ready();

        // Reap the task before asserting so a regression cannot detach it.
        let handle = rs.handle.take().unwrap();
        handle.abort();
        let error = handle.await.unwrap_err();
        assert!(error.is_cancelled());

        assert!(!ready_while_in_flight);
        assert!(rs.timer_ready());
    }

    #[test]
    fn clear_timer_clears_restart_at() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(0), Duration::from_secs(60), None);
        rs.schedule();
        assert!(rs.restart_at.is_some());
        rs.clear_timer();
        assert!(rs.restart_at.is_none());
        assert!(!rs.timer_ready());
    }

    #[test]
    fn backoff_doubles_up_to_max() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(8), None);
        assert_eq!(rs.backoff(), Duration::from_secs(1));
        let _ = rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(2));
        let _ = rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(4));
        let _ = rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(8));
        let _ = rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(8)); // capped
    }

    #[test]
    fn circuit_breaker_not_tripped_below_threshold() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60), Some(3));
        assert!(rs.on_failure()); // 1
        assert!(rs.on_failure()); // 2
        assert!(!rs.on_failure()); // 3 = max → trips
    }

    #[test]
    fn no_circuit_breaker_when_none() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60), None);
        for _ in 0..100 {
            assert!(rs.on_failure());
        }
    }
});
