//! Retained provider identity shared by lifecycle owners, without admission authority.

use std::sync::Arc;

use sandbox::{BackingProcessIdentity, SandboxBackingProcess};

#[derive(Clone)]
pub(crate) struct CapturedBacking {
    pub(crate) identity: BackingProcessIdentity,
    pub(crate) process: Arc<dyn SandboxBackingProcess>,
}

impl CapturedBacking {
    /// Capture at the caller's existing provider boundary, outside owner locks.
    /// Panic handling and all admission/exit validation remain with that caller.
    pub(crate) fn capture(process: Arc<dyn SandboxBackingProcess>) -> Self {
        Self {
            identity: process.identity(),
            process,
        }
    }
}
