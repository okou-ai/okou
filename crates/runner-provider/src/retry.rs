//! Backoff and retry task state for the Ably control-plane supervisor.

use std::time::{Duration, Instant};

/// Groups the backoff and retry state for an Ably connection attempt.
pub struct RetryState<H> {
    pub handle: Option<H>,
    pub restart_at: Option<Instant>,
    pub backoff: Duration,
    backoff_initial: Duration,
    backoff_max: Duration,
    pub consecutive_failures: u32,
}

impl<H> RetryState<H> {
    pub fn new(initial: Duration, max: Duration) -> Self {
        Self {
            handle: None,
            restart_at: None,
            backoff: initial,
            backoff_initial: initial,
            backoff_max: max,
            consecutive_failures: 0,
        }
    }

    /// Schedule a restart after the current backoff delay.
    pub fn schedule(&mut self) {
        self.restart_at = Some(Instant::now() + self.backoff);
    }

    /// Reset backoff and failure count after a successful restart.
    pub fn on_success(&mut self) {
        self.backoff = self.backoff_initial;
        self.consecutive_failures = 0;
    }

    /// Record a failure, double the backoff (capped), and schedule a retry.
    pub fn on_failure(&mut self) {
        self.consecutive_failures += 1;
        self.schedule();
        self.backoff = (self.backoff * 2).min(self.backoff_max);
    }

    /// Number of consecutive failures since the last success.
    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    /// Current backoff duration (doubles on each failure, capped at max).
    pub fn backoff(&self) -> Duration {
        self.backoff
    }

    /// `true` if the restart timer has fired and no task is in flight.
    pub fn timer_ready(&self) -> bool {
        self.handle.is_none() && self.restart_at.is_some_and(|at| Instant::now() >= at)
    }

    /// Clear the timer after spawning a restart task.
    pub fn clear_timer(&mut self) {
        self.restart_at = None;
    }
}

/// Sleep until a restart timer fires, or pend forever if none is scheduled.
///
/// Free function (not a method) so the borrow on `restart_at` is disjoint
/// from `&mut retry.handle` inside `tokio::select!`.
pub async fn sleep_until_retry(restart_at: &Option<Instant>) {
    match restart_at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(*at)).await,
        None => std::future::pending().await,
    }
}

/// Await a background retry task, or pend forever if none is running.
pub async fn recv_retry<T, E: std::fmt::Display>(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_state_new_defaults() {
        let rs: RetryState<()> = RetryState::new(Duration::from_secs(1), Duration::from_secs(60));
        assert_eq!(rs.consecutive_failures, 0);
        assert!(rs.restart_at.is_none());
        assert!(rs.handle.is_none());
    }

    #[test]
    fn retry_state_on_failure_doubles_backoff() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60));
        rs.on_failure();
        assert_eq!(rs.consecutive_failures, 1);
        assert_eq!(rs.backoff, Duration::from_secs(2));
        assert!(rs.restart_at.is_some());
    }

    #[test]
    fn retry_state_on_failure_caps_at_max() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(4));
        rs.backoff = Duration::from_secs(4);
        rs.on_failure();
        assert_eq!(rs.backoff, Duration::from_secs(4));
    }

    #[test]
    fn retry_state_on_success_resets() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60));
        rs.backoff = Duration::from_secs(32);
        rs.consecutive_failures = 10;
        rs.on_success();
        assert_eq!(rs.backoff, Duration::from_secs(1));
        assert_eq!(rs.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn timer_ready_requires_no_handle_and_past_restart() {
        let mut rs: RetryState<tokio::task::JoinHandle<()>> =
            RetryState::new(Duration::from_secs(0), Duration::from_secs(60));
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
            RetryState::new(Duration::from_secs(0), Duration::from_secs(60));
        rs.schedule();
        assert!(rs.restart_at.is_some());
        rs.clear_timer();
        assert!(rs.restart_at.is_none());
        assert!(!rs.timer_ready());
    }

    #[test]
    fn backoff_doubles_up_to_max() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(8));
        assert_eq!(rs.backoff(), Duration::from_secs(1));
        rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(2));
        rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(4));
        rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(8));
        rs.on_failure();
        assert_eq!(rs.backoff(), Duration::from_secs(8)); // capped
    }

    #[test]
    fn repeated_failures_keep_scheduling_retries() {
        let mut rs: RetryState<()> =
            RetryState::new(Duration::from_secs(1), Duration::from_secs(60));
        for failure in 1..=100 {
            let earliest = Instant::now() + rs.backoff();
            rs.on_failure();
            assert_eq!(rs.consecutive_failures(), failure);
            assert!(rs.restart_at.is_some_and(|at| at >= earliest));
        }
    }
}
