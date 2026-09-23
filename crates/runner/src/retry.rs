//! Generic backoff state for Runner-owned restartable background tasks.

use std::time::{Duration, Instant};

pub(crate) struct RetryState<H> {
    pub(crate) handle: Option<H>,
    pub(crate) restart_at: Option<Instant>,
    pub(crate) backoff: Duration,
    backoff_initial: Duration,
    backoff_max: Duration,
    pub(crate) consecutive_failures: u32,
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

    pub(crate) fn schedule(&mut self) {
        self.restart_at = Some(Instant::now() + self.backoff);
    }

    pub(crate) fn on_success(&mut self) {
        self.backoff = self.backoff_initial;
        self.consecutive_failures = 0;
    }

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

    pub(crate) fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    pub(crate) fn backoff(&self) -> Duration {
        self.backoff
    }

    pub(crate) fn timer_ready(&self) -> bool {
        self.handle.is_none() && self.restart_at.is_some_and(|at| Instant::now() >= at)
    }

    pub(crate) fn clear_timer(&mut self) {
        self.restart_at = None;
    }
}

pub(crate) async fn sleep_until_retry(restart_at: &Option<Instant>) {
    match restart_at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(*at)).await,
        None => std::future::pending().await,
    }
}
