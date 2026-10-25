//! Bounded producer for connected, one-shot COW slots used by Firecracker VMs.
//!
//! Pre-creating the COW file and its NBD device removes that work from the
//! sandbox creation path. Every [`CowPoolHandle`] clone communicates with one
//! background actor, which exclusively owns [`state::CowPool`] and serializes
//! its state transitions.
//!
//! # Ownership
//!
//! The actor distinguishes these ownership states:
//!
//! - the ready queue owns completed [`PreparedCowSlot`] values available for
//!   acquisition;
//! - pending tasks own in-flight slot creations;
//! - teardown tasks own completed slots that no longer belong in the ready
//!   pipeline;
//! - the waiter queue owns FIFO acquisition requests, not slots.
//!
//! A successful response transfers its slot out of producer ownership and
//! accounting. The caller consumes it through [`PreparedCowSlot::checkout_to`];
//! the slot is never returned to this producer. A receiver that closes before
//! the transfer is skipped without losing the slot.
//!
//! # Scheduling and bounds
//!
//! Pipeline inventory is the ready queue plus pending creations. Its target is
//! the warm buffer plus live acquisition waiters, capped by the global slot
//! limit. Creation and steady-state teardown tasks share bounded task capacity.
//! Ready slots and waiters are matched FIFO.
//!
//! A scheduled warm retry delays background-only replenishment, but live demand
//! may still start creation. One creation failure is delivered to one live
//! waiter; any remaining demand is repumped subject to the normal bounds. A
//! completed slot that is no longer needed enters explicit teardown instead of
//! increasing ready inventory.
//!
//! # Shutdown
//!
//! The actor's biased polling order considers cleanup, creation completions,
//! teardown completions, and due warm retries before ordinary queued commands
//! when multiple branches are ready. Cleanup deactivates the producer, rejects
//! acquisition waiters, completes warmup waiters, and drains ready slots,
//! in-flight creations, and existing teardowns. Successful late creations
//! remain pool-owned and enter the cleanup teardown queue.
//!
//! Cleanup acknowledges shutdown only after pending creations have drained and
//! all ready, late, and already-running [`destroy_prepared_slot_async`] teardown
//! work has finished. Finalization can preserve backing files when the NBD
//! device lifecycle cannot prove that deletion is safe.

mod actor;
mod create;
mod slot;
mod state;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

pub(crate) use actor::CowPoolHandle;
#[cfg(test)]
use slot::destroy_slot_sync;
pub(crate) use slot::{PreparedCowSlot, destroy_prepared_slot_async};
use slot::{PrewarmedSlot, destroy_slot_async};

/// Number of ready COW slots to keep warm in steady state.
const BUFFER_SIZE: usize = 4;

/// Maximum simultaneous slot creation tasks.
const MAX_CONCURRENT_SLOT_CREATIONS: usize = 4;

/// Maximum simultaneous prepared-slot teardowns during producer shutdown.
const MAX_CONCURRENT_SLOT_TEARDOWNS: usize = MAX_CONCURRENT_SLOT_CREATIONS;

/// Maximum slots still owned by the producer pipeline (ready + pending).
const MAX_SLOTS: usize = 256;

/// Backoff for warm-buffer retries after background creation failures.
const WARM_RETRY_BACKOFF: Duration = Duration::from_secs(1);

type AcquireResult = Result<PreparedCowSlot, CowPoolError>;
type SlotSpawner =
    Arc<dyn Fn(CowPoolConfig) -> JoinHandle<Result<PreparedCowSlot, CowPoolError>> + Send + Sync>;

#[cfg(test)]
#[derive(Debug)]
struct CowPoolSnapshot {
    ready: usize,
    pending: usize,
    teardowns: usize,
    waiters: usize,
    pipeline_slots: usize,
    warm_retry_scheduled: bool,
}

/// Configuration for creating a [`CowPoolHandle`].
#[derive(Clone)]
pub(crate) struct CowPoolConfig {
    /// Base directory for workspaces (for example, `{base_dir}/workspaces`).
    pub workspaces_dir: PathBuf,
    /// Read-only base image used by every prepared COW device.
    pub base_image: PathBuf,
    /// Base image size in bytes (for creating sparse COW files in fresh mode).
    pub base_size: u64,
    /// Snapshot golden COW file path (`None` = fresh mode).
    pub golden_cow: Option<PathBuf>,
    /// Shared pool of validated host NBD devices.
    pub device_pool: nbd_cow::pool::DevicePoolHandle,
}

/// Pool error type.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CowPoolError {
    #[error("COW file creation failed: {0}")]
    CowFileCreation(String),
    #[error("COW device creation failed: {0}")]
    CowDeviceCreation(String),
    #[error("slot limit reached (max {max})")]
    SlotLimitReached { max: usize },
    #[error("pool actor stopped")]
    ActorStopped,
    #[error("pool is not active")]
    NotActive,
}
