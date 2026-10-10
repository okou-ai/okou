//! Process-local pending growth and cancellation-safe phase ownership.
//!
//! This component does not select calibrated bounds or change production
//! admission. One accepting Runner owns one instance. Whole-host observations
//! include existing occupancy, not future external growth or kernel reservations.
//! Logical full-profile leases and the physical work's existing owners remain
//! separate. No memory-specific state survives process death.

mod accounting;
mod request;
mod work;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use sandbox::SandboxBackingProcess;
use tokio::time::Instant;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use super::host_memory_policy::{HostMemoryBounds, HostMemoryBoundsError};
use accounting::{CapturedPlan, Ledger, Sample};
pub use request::{MemoryGrowthPermit, MemoryGrowthRequest};
pub use work::{MemoryOperation, MemoryOperationTask};

type Result<T> = std::result::Result<T, MemoryOperationError>;

/// Supplied current bounds, captured once; no production defaults or selectors.
#[derive(Clone, Copy, Debug)]
pub struct MemoryOperationPolicy {
    pub bounds: HostMemoryBounds,
    pub max_sample_age: Duration,
    /// Bounds registered queued/unused/started/uncertain operations, and also
    /// concurrently tracked work owners (including already-settled phase tails).
    pub max_operations: usize,
    /// Caps granted/started/uncertain cleanup, not just running exporters.
    pub max_cleanup_inflight: usize,
}

impl MemoryOperationPolicy {
    fn validate(self) -> Result<()> {
        self.bounds.validate()?;
        if self.max_sample_age.is_zero()
            || self.max_operations == 0
            || self.max_cleanup_inflight == 0
            || self.max_cleanup_inflight > self.max_operations
        {
            return Err(MemoryOperationError::InvalidLimits);
        }
        Ok(())
    }
}

/// Actual operation selection, not a Sandbox label, PID or predicted residency.
#[derive(Clone)]
pub enum MemoryOperationPlan {
    /// Full declared profile plus supplied measured preparation envelope.
    Fresh {
        memory_mib: u32,
        preparation_bytes: u64,
    },
    Resume {
        memory_mib: u32,
        preparation_bytes: u64,
        backing: Arc<dyn SandboxBackingProcess>,
    },
    /// Controlled export/retirement envelope; requires current evidence before use.
    Retire {
        growth_bytes: u64,
        backing: Arc<dyn SandboxBackingProcess>,
    },
    /// Joined host I/O with a supplied measured envelope, not a VM/None bypass.
    HostIo {
        growth_bytes: u64,
    },
    CleanupIo {
        growth_bytes: u64,
    },
}

/// Correlation only. Mutations require the exact owned request/permit/operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MemoryOperationId(Uuid);

impl MemoryOperationId {
    pub fn generation(self) -> Uuid {
        self.0
    }
}

/// A fresh read boundary; implementations must not return a cached observation.
/// Accepted read I/O remains owned by its real reader, not the accounting lock.
pub trait MemoryObservationSource: Send + Sync {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation>;
}

/// Host-owned bounded `/proc/meminfo` observation, with no configuration path.
pub struct ProcMemoryObservationSource;

impl MemoryObservationSource for ProcMemoryObservationSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read())
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum MemoryOperationError {
    #[error(transparent)]
    Bounds(#[from] HostMemoryBoundsError),
    #[error("sample-age and operation/wave limits must be positive and ordered")]
    InvalidLimits,
    #[error("controlled growth must be positive and fit the supplied capacity")]
    UnsupportedGrowth,
    #[error("registered memory operation limit reached")]
    OperationLimit,
    #[error("tracked memory work-owner limit reached")]
    TaskLimit,
    #[error("memory operation admission is closed")]
    Closed,
    #[error("accounting changed during observation; defer and read again")]
    AccountingChanged,
    #[error("required cleanup is queued")]
    CleanupWaiting,
    #[error("cleanup wave is full")]
    CleanupWaveFull,
    #[error("available {available} bytes do not cover required {required} bytes")]
    InsufficientHeadroom { available: u64, required: u64 },
    #[error(transparent)]
    UnknownObservation(#[from] HostMemoryUnknown),
    #[error("observation exceeds supplied host total")]
    ObservationExceedsTotal,
    #[error("accounting arithmetic/revision overflowed")]
    AccountingOverflow,
    #[error("accounting mutex is poisoned")]
    AccountingPoisoned,
    #[error("memory operation ownership invariant failed")]
    OwnershipInvariant,
    #[error("operation has already transferred or settled")]
    Consumed,
    #[error("rebind must preserve the operation's purpose and priority class")]
    PurposeChanged,
    #[error("fresh backing must be captured exactly once, before phase completion")]
    BackingAlreadyCaptured,
    #[error("fresh preparation has no confirmed captured backing capability")]
    MissingBacking,
    #[error("exact provider backing exit is unconfirmed")]
    UnconfirmedBacking,
    #[error("owned execution requires an active Tokio runtime")]
    NoRuntime,
    #[error("owned work producer was lost; allowance is not settled")]
    ProducerLost,
}

/// Bounded aggregate diagnostics, never per-VM residency or released-byte credit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryOperationSnapshot {
    pub registered_operations: usize,
    pub queued: usize,
    pub granted: usize,
    pub started: usize,
    pub uncertain: usize,
    pub ordinary_growth_bytes: u64,
    pub cleanup_growth_bytes: u64,
    /// Tracked owners, not just callback tasks: includes required settled-phase
    /// tails and physical guards surviving their async producer.
    pub tracked_tasks: usize,
    pub closed: bool,
}

/// The accepting process's single bounded authority, shared among its owners.
#[derive(Clone)]
pub struct HostMemoryOperations {
    shared: Arc<Shared>,
}

struct Shared {
    policy: MemoryOperationPolicy,
    source: Arc<dyn MemoryObservationSource>,
    ledger: Mutex<Ledger>,
    tasks: TaskTracker,
}

impl HostMemoryOperations {
    pub fn new(
        policy: MemoryOperationPolicy,
        source: Arc<dyn MemoryObservationSource>,
    ) -> Result<Self> {
        policy.validate()?;
        Ok(Self {
            shared: Arc::new(Shared {
                policy,
                source,
                ledger: Mutex::new(Ledger::new()),
                tasks: TaskTracker::new(),
            }),
        })
    }

    /// Register a bounded request. Queued cleanup has owned, bounded priority.
    /// No physical growth starts here, even if the request's read is cancelled.
    pub fn request(&self, plan: MemoryOperationPlan) -> Result<MemoryGrowthRequest> {
        let plan = CapturedPlan::capture(plan, self.shared.policy)?;
        // Entropy acquisition is outside the short accounting section too.
        let id = MemoryOperationId(Uuid::new_v4());
        self.shared
            .lock()?
            .register(id, plan.clone(), self.shared.policy)?;
        Ok(MemoryGrowthRequest {
            shared: Arc::clone(&self.shared),
            id: Some(id),
            plan,
        })
    }

    pub fn snapshot(&self) -> Result<MemoryOperationSnapshot> {
        self.shared.lock()?.snapshot(self.shared.tasks.len())
    }

    /// Atomically reject new work and join every accepted owner, including tails.
    /// Cancellation of this wait never aborts those tasks. A returned snapshot
    /// with remaining rows is uncertainty, not saved-data/physical-relief proof.
    /// Join still occurs if accounting is unhealthy.
    pub async fn close_and_wait(&self) -> Result<MemoryOperationSnapshot> {
        let close = self.shared.lock().and_then(|mut ledger| ledger.close());
        let _ = self.shared.tasks.close();
        self.shared.tasks.wait().await;
        close?;
        self.snapshot()
    }
}

impl Shared {
    fn lock(&self) -> Result<MutexGuard<'_, Ledger>> {
        self.ledger
            .lock()
            .map_err(|_| MemoryOperationError::AccountingPoisoned)
    }

    async fn sample(&self) -> Result<Sample> {
        let revision = {
            let ledger = self.lock()?;
            ledger.ensure_healthy()?;
            ledger.revision()
        };
        let observation = self.source.observe().await;
        Ok(Sample {
            revision,
            observation,
        })
    }

    fn abandon(&self, id: MemoryOperationId) {
        // Poisoned accounting must retain its claims, never become an empty ledger.
        if let Ok(mut ledger) = self.lock() {
            ledger.abandon(id);
        }
    }
}

impl Sample {
    fn available(&self, policy: MemoryOperationPolicy) -> Result<u64> {
        let available = self
            .observation
            .available_bytes_at(Instant::now(), policy.max_sample_age)?;
        if available > policy.bounds.host_total_bytes {
            return Err(MemoryOperationError::ObservationExceedsTotal);
        }
        Ok(available)
    }
}
