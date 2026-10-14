//! Required cleanup must not wait forever behind fully retained CPU custody.

use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

use crate::error::{LifecycleError, LifecycleResult};

pub(super) struct IdleHomeReclamation {
    pub permits: Arc<Semaphore>,
    capacity: usize,
    retained: watch::Sender<usize>,
}

impl IdleHomeReclamation {
    pub fn new(capacity: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity)),
            capacity,
            retained: watch::channel(0).0,
        }
    }

    pub async fn acquire_required(self: &Arc<Self>) -> LifecycleResult<IdleHomeReclamationPermit> {
        let mut retained = self.retained.subscribe();
        let acquisition = self.permits.clone().acquire_owned();
        tokio::pin!(acquisition);
        loop {
            // Subscribe before checking. Healthy in-flight holders can release
            // capacity; fully retained failed owners require reconciliation.
            let fully_retained = *retained.borrow_and_update() == self.capacity;
            if fully_retained {
                return Err(LifecycleError::Internal(
                    "idle home reclamation capacity is retained by required cleanup recovery"
                        .into(),
                ));
            }
            tokio::select! {
                result = &mut acquisition => {
                    let permit = result.map_err(|error| LifecycleError::Internal(
                        format!("idle home reclamation admission closed: {error}")
                    ))?;
                    return Ok(IdleHomeReclamationPermit {
                        permit: Some(permit),
                        admission: self.clone(),
                        retained: false,
                    });
                }
                changed = retained.changed() => {
                    changed.map_err(|error| LifecycleError::Internal(
                        format!("idle home reclamation recovery observation closed: {error}")
                    ))?;
                }
            }
        }
    }
}

/// CPU custody remains with an unresolved required-saving resource. Waiting
/// cleanup observes retained saturation without releasing that custody.
#[must_use]
pub struct IdleHomeReclamationPermit {
    permit: Option<OwnedSemaphorePermit>,
    admission: Arc<IdleHomeReclamation>,
    retained: bool,
}

impl IdleHomeReclamationPermit {
    pub(crate) fn retain_for_recovery(&mut self) {
        if !self.retained {
            self.admission.retained.send_modify(|count| *count += 1);
            self.retained = true;
        }
    }
}

impl Drop for IdleHomeReclamationPermit {
    fn drop(&mut self) {
        if self.retained {
            // Keep the count update and actual permit release under the same
            // short watch write so readers cannot observe stale saturation.
            self.admission.retained.send_modify(|count| {
                drop(self.permit.take());
                *count -= 1;
            });
        }
    }
}
