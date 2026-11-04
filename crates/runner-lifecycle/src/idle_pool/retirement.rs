//! Shared supplied coverage and phase settlement for guarded idle owners.

use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;

use crate::host_memory_operations::{
    MemoryGrowthPermit, MemoryGrowthRequest, MemoryOperation, MemoryOperationError,
};

/// Positive measured/supplied growth, not guessed residency or eviction yield.
/// Both phases consume cleanup slots and bytes in the same P2 authority.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IdleRetirementEnvelope {
    pub live_growth_bytes: u64,
    pub tail_growth_bytes: u64,
}

pub(super) enum Allowance {
    Queued(MemoryGrowthRequest),
    Granted(MemoryGrowthPermit),
}

impl Allowance {
    pub(super) async fn try_grant(&mut self) -> Result<(), MemoryOperationError> {
        if let Self::Queued(request) = self {
            let permit = request.try_grant().await?;
            *self = Self::Granted(permit);
        }
        Ok(())
    }
}

pub(super) async fn settle(operation: &mut MemoryOperation, context: &'static str) -> bool {
    loop {
        match AssertUnwindSafe(operation.complete_phase())
            .catch_unwind()
            .await
        {
            Ok(Ok(())) => return true,
            Ok(Err(MemoryOperationError::AccountingChanged)) => {
                // Concurrent independent owners must not manufacture uncertainty
                // just by finishing together. Every retry takes a new real read.
                tokio::task::yield_now().await;
            }
            Ok(Err(error)) => {
                tracing::warn!(context, %error, "idle retirement phase remains uncertain");
                return false;
            }
            Err(_) => {
                tracing::warn!(context, "idle retirement phase observer panicked");
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests;
