use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use ::sandbox::*;
use async_trait::async_trait;

use crate::lifecycle::{DestroyBehavior, wait_lifecycle_gate};
use crate::overrides::MockSandboxOverrides;
use crate::sandbox::MockSandbox;
use crate::support::LockIgnoringPoison;

/// A mock [`SandboxFactory`] that creates [`MockSandbox`] instances.
///
/// Queue custom `create` results with [`push_create_result`](Self::push_create_result).
/// When the factory-local queue is empty, `create` checks shared
/// [`MockSandboxOverrides`] create results. When both queues are empty,
/// `create` returns a default `MockSandbox`.
///
/// Factories built with shared overrides record create configs in that override
/// set and pass the same overrides to every sandbox they create.
pub struct MockSandboxFactory {
    create_results: Mutex<VecDeque<Result<()>>>,
    overrides: Option<Arc<MockSandboxOverrides>>,
    create_backings: Mutex<VecDeque<Arc<dyn SandboxBackingProcess>>>,
}

impl MockSandboxFactory {
    /// Create a factory without shared overrides.
    ///
    /// Sandboxes produced by this factory keep only sandbox-local queues and
    /// observations.
    pub fn new() -> Self {
        Self {
            create_results: Mutex::new(VecDeque::new()),
            overrides: None,
            create_backings: Mutex::new(VecDeque::new()),
        }
    }

    /// Create a factory that shares one override set across all created
    /// sandboxes.
    ///
    /// Create configs and selected sandbox calls are recorded on the supplied
    /// [`MockSandboxOverrides`] instance.
    pub fn with_overrides(overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            create_results: Mutex::new(VecDeque::new()),
            overrides: Some(overrides),
            create_backings: Mutex::new(VecDeque::new()),
        }
    }

    /// Queue a factory-local create result. `Ok(())` creates a normal
    /// `MockSandbox`; `Err(...)` makes `create` return that error.
    /// Results are consumed in FIFO order before shared override results.
    pub fn push_create_result(&self, result: Result<()>) {
        self.create_results.lock_ignoring_poison().push_back(result);
    }

    /// Attach one explicit provider-owned generation to the next created mock.
    /// Generic stop/destroy calls do not invent its terminal wait result.
    pub fn push_create_backing(&self, backing: Arc<dyn SandboxBackingProcess>) {
        self.create_backings
            .lock_ignoring_poison()
            .push_back(backing);
    }
}

impl Default for MockSandboxFactory {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SandboxFactory for MockSandboxFactory {
    fn name(&self) -> &str {
        "mock"
    }

    fn config_hash(&self) -> String {
        "mock-config-hash".into()
    }

    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>> {
        if let Some(overrides) = &self.overrides {
            overrides
                .factory
                .create_configs
                .lock_ignoring_poison()
                .push(config.clone());
            wait_lifecycle_gate(&overrides.factory.create_gate).await;
        }
        if let Some(result) = self.create_results.lock_ignoring_poison().pop_front() {
            result?;
        } else if let Some(overrides) = &self.overrides
            && let Some(result) = overrides
                .factory
                .create_results
                .lock_ignoring_poison()
                .pop_front()
        {
            result?;
        }
        let sandbox = match &self.overrides {
            Some(o) => MockSandbox::with_overrides(config.id.to_string(), Arc::clone(o)),
            None => MockSandbox::new(config.id.to_string()),
        };
        let backing = self
            .create_backings
            .lock_ignoring_poison()
            .pop_front()
            .or_else(|| {
                self.overrides
                    .as_ref()?
                    .factory
                    .create_backings
                    .lock_ignoring_poison()
                    .pop_front()
            });
        let sandbox = match backing {
            Some(backing) => sandbox.with_backing_process(backing),
            None => sandbox,
        };
        Ok(Box::new(sandbox))
    }

    async fn create_with_custody(
        &self,
        config: SandboxConfig,
        custody: SandboxCreateCustody,
    ) -> Result<Box<dyn Sandbox>> {
        let _custody = custody;
        // This provider has no detached physical allocation/rollback work.
        self.create(config).await
    }

    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
        if let Some(o) = &self.overrides {
            *o.lifecycle.destroy_calls.lock_ignoring_poison() += 1;
            wait_lifecycle_gate(&o.lifecycle.destroy_gate).await;
            match o
                .lifecycle
                .destroy_behaviors
                .lock_ignoring_poison()
                .pop_front()
            {
                #[allow(clippy::panic)]
                Some(DestroyBehavior::Panic(message)) => panic!("{message}"),
                None => {}
            }
        }
    }

    async fn shutdown(&mut self) {}
}

// ---------------------------------------------------------------------------
// MockSandboxRuntime
// ---------------------------------------------------------------------------

/// A mock [`SandboxRuntime`] that creates [`MockSandboxFactory`] instances.
pub struct MockSandboxRuntime {
    overrides: Option<Arc<MockSandboxOverrides>>,
}

impl MockSandboxRuntime {
    /// Create a runtime whose factories do not share overrides.
    pub fn new() -> Self {
        Self { overrides: None }
    }

    /// Create a runtime that propagates one shared override set to every
    /// factory it creates.
    ///
    /// Factories created by this runtime pass the same overrides to their
    /// sandboxes, so shared queues and observations span the whole runtime.
    pub fn with_overrides(overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            overrides: Some(overrides),
        }
    }
}

impl Default for MockSandboxRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SandboxRuntime for MockSandboxRuntime {
    async fn create_factory(&self, _config: FactoryConfig) -> Result<Box<dyn SandboxFactory>> {
        let factory = match &self.overrides {
            Some(o) => MockSandboxFactory::with_overrides(Arc::clone(o)),
            None => MockSandboxFactory::new(),
        };
        Ok(Box::new(factory))
    }

    async fn shutdown(&mut self) {}
}

// ---------------------------------------------------------------------------
// MockRuntimeProvider
// ---------------------------------------------------------------------------

/// A mock [`RuntimeProvider`] that creates [`MockSandboxRuntime`] instances.
pub struct MockRuntimeProvider;

#[async_trait]
impl RuntimeProvider for MockRuntimeProvider {
    async fn create_runtime(&self, _config: RuntimeConfig) -> Result<Box<dyn SandboxRuntime>> {
        Ok(Box::new(MockSandboxRuntime::new()))
    }
}
