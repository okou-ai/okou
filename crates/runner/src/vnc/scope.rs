use super::Failure;
use std::{future::Future, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct Scope {
    pub(super) cancelled: CancellationToken,
    pub(super) sandbox: CancellationToken,
    pub(super) session: CancellationToken,
    pub(super) deadline: Instant,
}

impl Scope {
    pub(super) fn check(&self) -> Result<(), Failure> {
        if self.cancelled.is_cancelled()
            || self.sandbox.is_cancelled()
            || self.session.is_cancelled()
        {
            Err(Failure::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(Failure::TimedOut)
        } else {
            Ok(())
        }
    }

    pub(super) async fn wait<T>(&self, future: impl Future<Output = T>) -> Result<T, Failure> {
        self.check()?;
        tokio::select! { biased;
            () = self.cancelled.cancelled() => Err(Failure::Cancelled),
            () = self.sandbox.cancelled() => Err(Failure::Cancelled),
            () = self.session.cancelled() => Err(Failure::Cancelled),
            () = tokio::time::sleep_until(self.deadline) => Err(Failure::TimedOut),
            value = future => Ok(value),
        }
    }

    /// Waits for a future that independently enforces this scope's deadline.
    ///
    /// Polling the future before the fallback timer lets it preserve a richer
    /// deadline error when both become ready together. Callers must ensure the
    /// future cannot succeed after `self.deadline`.
    pub(super) async fn wait_deadline_aware<T>(
        &self,
        future: impl Future<Output = T>,
    ) -> Result<T, Failure> {
        self.check()?;
        tokio::select! { biased;
            () = self.cancelled.cancelled() => Err(Failure::Cancelled),
            () = self.sandbox.cancelled() => Err(Failure::Cancelled),
            () = self.session.cancelled() => Err(Failure::Cancelled),
            value = future => Ok(value),
            () = tokio::time::sleep_until(self.deadline) => Err(Failure::TimedOut),
        }
    }

    pub(super) fn terminal(&self) -> Self {
        Self {
            cancelled: CancellationToken::new(),
            session: CancellationToken::new(),
            deadline: (self.deadline + Duration::from_secs(1))
                .min(Instant::now() + Duration::from_secs(1)),
            sandbox: self.sandbox.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn deadline_aware_error_wins_when_both_deadlines_are_ready() {
        let deadline = Instant::now() + Duration::from_secs(1);
        let scope = Scope {
            cancelled: CancellationToken::new(),
            sandbox: CancellationToken::new(),
            session: CancellationToken::new(),
            deadline,
        };

        let result = scope
            .wait_deadline_aware(async {
                tokio::time::sleep_until(deadline).await;
                Err::<(), _>("staged timeout")
            })
            .await;

        assert_eq!(result, Ok(Err("staged timeout")));
    }
}
