//! Fixed, non-destructive inventory selection for guarded prune and drain.

use sandbox::SandboxId;

use crate::host_memory_operations::MemoryOperationError;

use super::{IdlePool, IdleRetirementCandidate, IdleSandboxIdentity};

/// The caller chooses which original inventory belongs to this batch.
#[derive(Clone, Copy, Debug)]
pub enum IdleRetirementBatchScope {
    Exact,
    All,
}

/// Original identity and insertion proof, or its required-proof refusal.
/// This owns no sandbox, home data or logical lease and cannot detach inventory.
pub struct IdleRetirementSelection {
    identity: IdleSandboxIdentity,
    sandbox_id: SandboxId,
    candidate: Result<IdleRetirementCandidate, MemoryOperationError>,
}

impl IdleRetirementSelection {
    pub fn into_parts(
        self,
    ) -> (
        IdleSandboxIdentity,
        SandboxId,
        Result<IdleRetirementCandidate, MemoryOperationError>,
    ) {
        (self.identity, self.sandbox_id, self.candidate)
    }
}

impl IdlePool {
    /// Capture the original batch using cached metadata only. Admission happens
    /// after releasing the pool borrow; no provider callback or removal runs here.
    /// A later reservation, restore or replacement invalidates the captured
    /// insertion proof rather than selecting the new inventory in its place.
    pub fn retirement_batch(
        &self,
        scope: IdleRetirementBatchScope,
    ) -> Vec<IdleRetirementSelection> {
        let mut entries: Vec<_> = self.exact_entries.values().collect();
        if matches!(scope, IdleRetirementBatchScope::All) {
            entries.extend(self.blank_entries.values());
        }
        entries.sort_by(|a, b| a.metadata.identity.cmp(&b.metadata.identity));
        entries
            .into_iter()
            .map(|entry| IdleRetirementSelection {
                identity: entry.metadata.identity.clone(),
                sandbox_id: entry.metadata.sandbox_id,
                candidate: self.retirement_candidate(&entry.metadata.identity),
            })
            .collect()
    }
}
