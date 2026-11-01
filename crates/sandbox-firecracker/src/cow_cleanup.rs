use std::time::Duration;

use nbd_cow::{DestroyRetryPolicy, PooledDestroyError, PooledNbdCowDevice};
use tracing::warn;

/// Maximum attempts to destroy a COW device after killing Firecracker.
/// After kill_process_group + child.wait(), the kernel may still be
/// releasing file descriptors (particularly the NBD device fd).
const DESTROY_RETRIES: u32 = 5;

/// Delay between COW device destroy retries.
const DESTROY_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CowCleanupOutcome {
    BackingFilesSafeToDelete,
    DeviceMayStillReferenceBackingFiles,
}

impl CowCleanupOutcome {
    pub(crate) fn backing_files_safe_to_delete(self) -> bool {
        matches!(self, Self::BackingFilesSafeToDelete)
    }
}

pub(crate) trait CowDestroyErrorSafety {
    fn backing_files_safe_to_delete(&self) -> bool;
}

impl CowDestroyErrorSafety for PooledDestroyError {
    fn backing_files_safe_to_delete(&self) -> bool {
        self.backing_files_safe_to_delete()
    }
}

pub(crate) fn cow_destroy_retry_policy() -> DestroyRetryPolicy {
    DestroyRetryPolicy {
        attempts: DESTROY_RETRIES,
        delay: DESTROY_RETRY_DELAY,
    }
}

pub(crate) fn classify_cow_destroy_result<E>(
    result: &std::result::Result<(), E>,
) -> CowCleanupOutcome
where
    E: CowDestroyErrorSafety,
{
    match result {
        Ok(()) => CowCleanupOutcome::BackingFilesSafeToDelete,
        Err(e) if e.backing_files_safe_to_delete() => CowCleanupOutcome::BackingFilesSafeToDelete,
        Err(_) => CowCleanupOutcome::DeviceMayStillReferenceBackingFiles,
    }
}

pub(crate) async fn destroy_cow_device_with_retries(
    id: &str,
    cow_device: PooledNbdCowDevice,
) -> CowCleanupOutcome {
    let result = cow_device
        .destroy_with_retries_detailed(cow_destroy_retry_policy())
        .await;
    let outcome = classify_cow_destroy_result(&result);

    match (result, outcome) {
        (Ok(()), outcome) => outcome,
        (Err(e), CowCleanupOutcome::BackingFilesSafeToDelete) => {
            warn!(
                id = %id,
                error = %e,
                "COW device released but file cleanup failed; continuing directory cleanup"
            );
            outcome
        }
        (Err(e), CowCleanupOutcome::DeviceMayStillReferenceBackingFiles) => {
            warn!(id = %id, error = %e, "destroy failed after retries — abandoned device");
            outcome
        }
    }
}

#[cfg(test)]
mod tests;
