//! Cancellation-safe joins for provider-owned unit workers.

use tokio::sync::Mutex;
use tokio::task::{JoinError, JoinHandle};

/// Retain join custody until the worker has terminated, including on panic.
///
/// Cancelling a waiter leaves the handle in its slot for another caller or the
/// owner's Drop policy. Clear it without suspending after completion so only
/// one caller observes a join error; later callers see an already-retired worker.
pub(super) async fn join_retained_worker(
    task: &Mutex<Option<JoinHandle<()>>>,
) -> Result<(), JoinError> {
    let mut slot = task.lock().await;
    let Some(task) = slot.as_mut() else {
        return Ok(());
    };
    let result = task.await;
    *slot = None;
    result
}
