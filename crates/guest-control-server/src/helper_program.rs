//! Owned test executable configuration for readiness-gated helper operations.

use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;

#[derive(Clone)]
pub(crate) struct TestHelperProgram {
    path: PathBuf,
    timeout_gate: Option<SyncSender<u32>>,
}

impl TestHelperProgram {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            timeout_gate: None,
        }
    }

    pub(crate) fn with_timeout_gate(path: PathBuf, timeout_gate: SyncSender<u32>) -> Self {
        Self {
            path,
            timeout_gate: Some(timeout_gate),
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn await_timeout_gate(&self, child_id: u32) {
        if let Some(timeout_gate) = &self.timeout_gate {
            // A zero-capacity channel lets the test observe helper readiness
            // before the real timeout starts. Receiver loss permits cleanup.
            let _ = timeout_gate.send(child_id);
        }
    }
}
