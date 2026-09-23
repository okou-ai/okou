use std::sync::Arc;

use async_trait::async_trait;
use sandbox::{
    Sandbox, SandboxConfig, SandboxError, SandboxFactory, SandboxInitializationPhase,
    SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::MockSandboxFactory;

pub(in crate::executor::tests) struct DestroyPanicFactory {
    pub(in crate::executor::tests) inner: MockSandboxFactory,
}

#[async_trait]
impl SandboxFactory for DestroyPanicFactory {
    fn name(&self) -> &str {
        "destroy-panic"
    }

    fn config_hash(&self) -> String {
        "destroy-panic".into()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }

    #[allow(clippy::panic)]
    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
        panic!("simulated destroy panic");
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

pub(in crate::executor::tests) fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

pub(in crate::executor::tests) fn sandbox_read_file_error(
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::ReadFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

pub(in crate::executor::tests) fn sandbox_copy_file_error(
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::CopyFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

pub(in crate::executor::tests) fn sandbox_write_file_error(
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

pub(in crate::executor::tests) fn sandbox_create_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: message.into(),
    }
}

pub(in crate::executor::tests) async fn create_overridden_sandbox(
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
) -> Box<dyn Sandbox> {
    sandbox_mock::MockSandboxFactory::with_overrides(overrides)
        .create(SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .unwrap()
}
