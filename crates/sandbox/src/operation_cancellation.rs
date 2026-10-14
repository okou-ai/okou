//! Diagnostic ownership of a future deliberately abandoned by its caller.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

tokio::task_local! {
    static OPERATION_OWNER: OperationCancellationContext;
}

/// Immutable attribution for an owner-selected cancellation.
///
/// This is diagnostic evidence, never operation admission or cleanup authority.
#[derive(Clone, Debug)]
pub struct CancelledOperationOwner {
    run_id: String,
    sandbox_id: String,
    phase: &'static str,
}

impl CancelledOperationOwner {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn sandbox_id(&self) -> &str {
        &self.sandbox_id
    }

    pub fn phase(&self) -> &'static str {
        self.phase
    }
}

struct Owner {
    attribution: CancelledOperationOwner,
    cancelled: AtomicBool,
}

/// One future's owner, captured by diagnostic guards created while it is polled.
///
/// Scope only the owned future, not concurrent work sharing its transport. Mark
/// cancellation after the owner selects it and before dropping the owned future.
/// Returned errors must be classified independently of this context.
#[derive(Clone)]
pub struct OperationCancellationContext(Arc<Owner>);

impl OperationCancellationContext {
    pub fn new(run_id: &str, sandbox_id: &str, phase: &'static str) -> Self {
        Self(Arc::new(Owner {
            attribution: CancelledOperationOwner {
                run_id: run_id.to_owned(),
                sandbox_id: sandbox_id.to_owned(),
                phase,
            },
            cancelled: AtomicBool::new(false),
        }))
    }

    /// Capture the current future's owner; spawned tasks do not inherit it.
    pub fn current() -> Option<Self> {
        OPERATION_OWNER.try_with(Clone::clone).ok()
    }

    pub fn scope<F: Future>(&self, future: F) -> tokio::task::futures::TaskLocalFuture<Self, F> {
        OPERATION_OWNER.scope(self.clone(), future)
    }

    /// Record the caller's selected cancellation before it releases its future.
    pub fn mark_cancelled(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }

    /// Snapshot attribution, so later cancellation cannot rewrite an earlier event.
    pub fn cancelled_owner(&self) -> Option<CancelledOperationOwner> {
        self.0
            .cancelled
            .load(Ordering::Acquire)
            .then(|| self.0.attribution.clone())
    }
}
