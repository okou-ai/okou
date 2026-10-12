//! Explicitly gated support for executable boot/signal composition regressions.
//! No runtime observer, provider polling fixture or production defaults live here.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

pub use crate::reactor::signals::SignalController;

/// Shared shutdown recorder used by both runtime and root boot-entry tests.
/// Factory creation is intentionally rejected: these cases only own shutdown.
pub struct ShutdownRecordingRuntime {
    shutdowns: Arc<AtomicUsize>,
    factory_creates: Arc<AtomicUsize>,
}

impl ShutdownRecordingRuntime {
    /// Record shutdown and rejected factory calls against explicit counters.
    /// Callers assert zero factory calls rather than relying on a panic in a
    /// non-test dependency build of this deliberately gated fixture.
    pub fn new(shutdowns: Arc<AtomicUsize>, factory_creates: Arc<AtomicUsize>) -> Self {
        Self {
            shutdowns,
            factory_creates,
        }
    }
}

#[async_trait]
impl sandbox::SandboxRuntime for ShutdownRecordingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        self.factory_creates.fetch_add(1, Ordering::SeqCst);
        Err(sandbox::SandboxError::Initialization {
            phase: sandbox::SandboxInitializationPhase::Factory,
            message: "publish failure cleanup test does not create factories".into(),
        })
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}
