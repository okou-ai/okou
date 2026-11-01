//! Process-local weighted admission for fresh pre-spawn work.
//!
//! This gate bounds weighted fresh pre-spawn work within one Runner process. Promotion starts the
//! new Runner in `mode=running` before draining older services, so versions can accept jobs through
//! independent gates during that overlap. Failed drains can prolong the overlap; admission is not
//! coordinated across processes.
//!
//! Exact reuse bypasses the gate, and post-spawn execution releases its permit so steady-state
//! capacity is unchanged.

use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::{RunnerError, RunnerResult};

#[derive(Clone)]
pub struct PreSpawnAdmission {
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
pub struct PreSpawnAdmissionMetadata {
    pub requested_tokens: u32,
    pub effective_tokens: u32,
    pub total_tokens: u32,
    pub contended: bool,
}

pub struct PreSpawnAdmissionLease {
    _permit: OwnedSemaphorePermit,
    metadata: PreSpawnAdmissionMetadata,
}

pub struct BackgroundPreSpawnAdmissionLease {
    _permit: OwnedSemaphorePermit,
    background: Arc<Mutex<BackgroundAdmissionState>>,
    id: u64,
    cancel: CancellationToken,
}

struct RealWaiterGuard {
    background: Arc<Mutex<BackgroundAdmissionState>>,
}

impl PreSpawnAdmissionLease {
    pub fn metadata(&self) -> PreSpawnAdmissionMetadata {
        self.metadata
    }
}

impl BackgroundPreSpawnAdmissionLease {
    pub fn cancellation_token(&self) -> CancellationToken {
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
    pub fn new(total_tokens: u32) -> RunnerResult<Self> {
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

    pub fn total_tokens(&self) -> u32 {
        self.total_tokens
    }

    pub async fn acquire(
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
    pub fn try_acquire_background(
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

#[cfg(test)]
mod tests;
