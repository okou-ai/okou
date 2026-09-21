//! Process-local weighted admission for fresh pre-spawn work.
//!
//! Production has one Runner in `mode=running` accepting new jobs per host; older versions only
//! drain work claimed before cutover. Keeping this gate process-local matches that ownership and
//! avoids host lock files, polling, and cross-process fairness machinery. Exact reuse bypasses the
//! gate, and post-spawn execution releases its permit so steady-state capacity is unchanged.

use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::{RunnerError, RunnerResult};

#[derive(Clone)]
pub(crate) struct PreSpawnAdmission {
    semaphore: Arc<Semaphore>,
    total_tokens: u32,
    background: Arc<Mutex<BackgroundAdmissionState>>,
}

#[derive(Default)]
struct BackgroundAdmissionState {
    next_id: u64,
    real_waiters: usize,
    active: Option<ActiveBackgroundAdmission>,
}

struct ActiveBackgroundAdmission {
    id: u64,
    cancel: CancellationToken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PreSpawnAdmissionMetadata {
    pub(crate) requested_tokens: u32,
    pub(crate) effective_tokens: u32,
    pub(crate) total_tokens: u32,
    pub(crate) contended: bool,
}

pub(crate) struct PreSpawnAdmissionLease {
    _permit: OwnedSemaphorePermit,
    metadata: PreSpawnAdmissionMetadata,
}

pub(crate) struct BackgroundPreSpawnAdmissionLease {
    _permit: OwnedSemaphorePermit,
    background: Arc<Mutex<BackgroundAdmissionState>>,
    id: u64,
    cancel: CancellationToken,
}

struct RealWaiterGuard {
    background: Arc<Mutex<BackgroundAdmissionState>>,
}

impl PreSpawnAdmissionLease {
    pub(crate) fn metadata(&self) -> PreSpawnAdmissionMetadata {
        self.metadata
    }
}

impl BackgroundPreSpawnAdmissionLease {
    pub(crate) fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }
}

impl Drop for BackgroundPreSpawnAdmissionLease {
    fn drop(&mut self) {
        let mut state = lock_background(&self.background);
        if state.active.as_ref().map(|active| active.id) == Some(self.id) {
            state.active = None;
        }
    }
}

impl Drop for RealWaiterGuard {
    fn drop(&mut self) {
        let mut state = lock_background(&self.background);
        state.real_waiters -= 1;
    }
}

impl PreSpawnAdmission {
    pub(crate) fn new(total_tokens: u32) -> RunnerResult<Self> {
        if total_tokens == 0 {
            return Err(RunnerError::Internal(
                "pre-spawn admission capacity must be positive".into(),
            ));
        }
        Ok(Self {
            semaphore: Arc::new(Semaphore::new(total_tokens as usize)),
            total_tokens,
            background: Arc::new(Mutex::new(BackgroundAdmissionState::default())),
        })
    }

    pub(crate) fn total_tokens(&self) -> u32 {
        self.total_tokens
    }

    pub(crate) async fn acquire(
        &self,
        requested_tokens: u32,
        cancel: &CancellationToken,
    ) -> RunnerResult<PreSpawnAdmissionLease> {
        if requested_tokens == 0 {
            return Err(RunnerError::Internal(
                "pre-spawn admission request must be positive".into(),
            ));
        }

        let effective_tokens = requested_tokens.min(self.total_tokens);
        let immediate = {
            let mut background = lock_background(&self.background);
            match Arc::clone(&self.semaphore).try_acquire_many_owned(effective_tokens) {
                Ok(permit) => Ok(permit),
                Err(_) => {
                    background.real_waiters += 1;
                    if let Some(active) = background.active.as_ref() {
                        active.cancel.cancel();
                    }
                    Err(RealWaiterGuard {
                        background: Arc::clone(&self.background),
                    })
                }
            }
        };
        let (permit, contended) = match immediate {
            Ok(permit) => (permit, false),
            Err(waiter) => {
                let permit = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(RunnerError::Cancelled),
                    result = Arc::clone(&self.semaphore).acquire_many_owned(effective_tokens) => {
                        result.map_err(|error| RunnerError::Internal(format!(
                            "pre-spawn admission semaphore closed unexpectedly: {error}"
                        )))?
                    },
                };
                drop(waiter);
                (permit, true)
            }
        };

        if cancel.is_cancelled() {
            return Err(RunnerError::Cancelled);
        }

        Ok(PreSpawnAdmissionLease {
            _permit: permit,
            metadata: PreSpawnAdmissionMetadata {
                requested_tokens,
                effective_tokens,
                total_tokens: self.total_tokens,
                contended,
            },
        })
    }

    /// Reserve weighted pre-spawn capacity for best-effort background work.
    ///
    /// This never waits and admits at most one background owner. A real
    /// request that cannot acquire immediately cancels the returned token.
    pub(crate) fn try_acquire_background(
        &self,
        requested_tokens: u32,
    ) -> RunnerResult<Option<BackgroundPreSpawnAdmissionLease>> {
        if requested_tokens == 0 {
            return Err(RunnerError::Internal(
                "background pre-spawn admission request must be positive".into(),
            ));
        }

        let effective_tokens = requested_tokens.min(self.total_tokens);
        let mut background = lock_background(&self.background);
        if background.real_waiters > 0 || background.active.is_some() {
            return Ok(None);
        }
        let Ok(permit) = Arc::clone(&self.semaphore).try_acquire_many_owned(effective_tokens)
        else {
            return Ok(None);
        };
        let id = background.next_id;
        background.next_id = background.next_id.wrapping_add(1);
        let cancel = CancellationToken::new();
        background.active = Some(ActiveBackgroundAdmission {
            id,
            cancel: cancel.clone(),
        });
        drop(background);

        Ok(Some(BackgroundPreSpawnAdmissionLease {
            _permit: permit,
            background: Arc::clone(&self.background),
            id,
            cancel,
        }))
    }
}

fn lock_background(
    background: &Mutex<BackgroundAdmissionState>,
) -> MutexGuard<'_, BackgroundAdmissionState> {
    background
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

runner_test_group!(runtime_control; #[cfg(test)]
mod tests {
    use std::future::Future;
    use std::panic::AssertUnwindSafe;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    fn assert_pending<T>(future: Pin<&mut impl Future<Output = T>>) {
        let waker = futures_util::task::noop_waker();
        let mut context = Context::from_waker(&waker);
        assert!(matches!(future.poll(&mut context), Poll::Pending));
    }

    #[tokio::test]
    async fn clones_share_weighted_capacity() {
        let admission = PreSpawnAdmission::new(3).unwrap();
        let other = admission.clone();
        let cancel = CancellationToken::new();
        let first_lease = admission.acquire(2, &cancel).await.unwrap();
        let second_lease = other.acquire(1, &cancel).await.unwrap();
        let mut blocked = Box::pin(admission.acquire(1, &cancel));

        assert_pending(blocked.as_mut());
        drop(second_lease);
        let acquired = tokio::time::timeout(TEST_TIMEOUT, blocked)
            .await
            .unwrap()
            .unwrap();

        assert!(acquired.metadata().contended);
        drop(first_lease);
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_leak_capacity() {
        let admission = PreSpawnAdmission::new(2).unwrap();
        let holder_cancel = CancellationToken::new();
        let holder = admission.acquire(1, &holder_cancel).await.unwrap();
        let waiter_cancel = CancellationToken::new();
        let mut waiter = Box::pin(admission.acquire(2, &waiter_cancel));

        assert_pending(waiter.as_mut());
        waiter_cancel.cancel();
        assert!(matches!(
            tokio::time::timeout(TEST_TIMEOUT, waiter).await.unwrap(),
            Err(RunnerError::Cancelled)
        ));
        drop(holder);

        let full = tokio::time::timeout(TEST_TIMEOUT, admission.acquire(2, &holder_cancel))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(full.metadata().effective_tokens, 2);
    }

    #[tokio::test]
    async fn mixed_weight_waiters_keep_fifo_order() {
        let admission = PreSpawnAdmission::new(2).unwrap();
        let cancel = CancellationToken::new();
        let holder = admission.acquire(1, &cancel).await.unwrap();
        let mut first = Box::pin(admission.acquire(2, &cancel));
        assert_pending(first.as_mut());
        let mut second = Box::pin(admission.acquire(1, &cancel));
        assert_pending(second.as_mut());

        drop(holder);
        let first_lease = tokio::time::timeout(TEST_TIMEOUT, first)
            .await
            .unwrap()
            .unwrap();
        assert_pending(second.as_mut());

        drop(first_lease);
        tokio::time::timeout(TEST_TIMEOUT, second)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn oversized_request_runs_alone() {
        let admission = PreSpawnAdmission::new(2).unwrap();
        let cancel = CancellationToken::new();
        let oversized = admission.acquire(8, &cancel).await.unwrap();
        assert_eq!(
            oversized.metadata(),
            PreSpawnAdmissionMetadata {
                requested_tokens: 8,
                effective_tokens: 2,
                total_tokens: 2,
                contended: false,
            }
        );
        let mut blocked = Box::pin(admission.acquire(1, &cancel));
        assert_pending(blocked.as_mut());

        drop(oversized);
        tokio::time::timeout(TEST_TIMEOUT, blocked)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn drop_and_unwind_release_capacity() {
        let admission = PreSpawnAdmission::new(1).unwrap();
        let cancel = CancellationToken::new();

        let lease = admission.acquire(1, &cancel).await.unwrap();
        drop(lease);
        admission.acquire(1, &cancel).await.unwrap();

        let lease = admission.acquire(1, &cancel).await.unwrap();
        let panic = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _lease = lease;
            panic!("release admission lease during unwind");
        }));
        assert!(panic.is_err());
        admission.acquire(1, &cancel).await.unwrap();
    }

    #[tokio::test]
    async fn background_admission_is_immediate_and_single_flight() {
        let admission = PreSpawnAdmission::new(3).unwrap();
        let background = admission.try_acquire_background(2).unwrap().unwrap();

        assert!(admission.try_acquire_background(1).unwrap().is_none());
        let cancel = CancellationToken::new();
        let real = admission.acquire(1, &cancel).await.unwrap();
        assert!(!real.metadata().contended);
        drop(real);
        drop(background);
        assert!(admission.try_acquire_background(3).unwrap().is_some());
    }

    #[tokio::test]
    async fn real_waiter_cancels_background_admission() {
        let admission = PreSpawnAdmission::new(2).unwrap();
        let background = admission.try_acquire_background(2).unwrap().unwrap();
        let background_cancel = background.cancellation_token();
        let cancel = CancellationToken::new();
        let mut real = Box::pin(admission.acquire(1, &cancel));

        assert_pending(real.as_mut());
        assert!(background_cancel.is_cancelled());
        assert!(admission.try_acquire_background(1).unwrap().is_none());

        drop(background);
        let real = tokio::time::timeout(TEST_TIMEOUT, real)
            .await
            .unwrap()
            .unwrap();
        assert!(real.metadata().contended);
    }

    #[tokio::test]
    async fn cancelled_real_waiter_reopens_background_admission() {
        let admission = PreSpawnAdmission::new(1).unwrap();
        let holder_cancel = CancellationToken::new();
        let holder = admission.acquire(1, &holder_cancel).await.unwrap();
        let waiter_cancel = CancellationToken::new();
        let mut waiter = Box::pin(admission.acquire(1, &waiter_cancel));

        assert_pending(waiter.as_mut());
        waiter_cancel.cancel();
        assert!(matches!(waiter.await, Err(RunnerError::Cancelled)));
        drop(holder);

        assert!(admission.try_acquire_background(1).unwrap().is_some());
    }
});
