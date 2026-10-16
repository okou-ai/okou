//! Invocation-owned acceptance checkpoint, absent from default production builds.

use super::*;

/// Test-only observation after actual home preparation, before network/COW creation.
///
/// The callback owns the real create transaction for its entire blocking lifetime.
pub type HomeCreateCheckpoint = Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

pub(super) async fn run(
    tx: SandboxCreateTransaction,
    path: std::path::PathBuf,
    checkpoint: Option<HomeCreateCheckpoint>,
) -> sandbox::Result<(SandboxCreateTransaction, sandbox::Result<()>)> {
    let Some(checkpoint) = checkpoint else {
        return Ok((tx, Ok(())));
    };
    tokio::task::spawn_blocking(move || {
        let result = checkpoint(&path).map_err(|error| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("test home preparation checkpoint: {error}"),
        });
        (tx, result)
    })
    .await
    .map_err(|error| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("test home preparation checkpoint producer: {error}"),
    })
}

#[cfg(feature = "test-support")]
pub(crate) struct CheckpointFactory {
    inner: FirecrackerFactory,
    checkpoint: HomeCreateCheckpoint,
}

#[cfg(feature = "test-support")]
#[async_trait]
impl SandboxFactory for CheckpointFactory {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }
    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }
    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        observer: &mut dyn SandboxCreateObserver,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create_with_observer(config, observer).await
    }
    async fn create_with_custody(
        &self,
        config: SandboxConfig,
        custody: sandbox::SandboxCreateCustody,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner
            .create_inner(config, None, Some(custody), Some(self.checkpoint.clone()))
            .await
    }
    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }
    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

#[cfg(feature = "test-support")]
pub(crate) fn wrap(
    inner: FirecrackerFactory,
    checkpoint: HomeCreateCheckpoint,
) -> Box<dyn SandboxFactory> {
    Box::new(CheckpointFactory { inner, checkpoint })
}
