//! Sandbox factory creation and shutdown for `runner start`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use sandbox::{SandboxFactory, SandboxRuntime};
use tracing::{error, info};

use super::TeardownTimer;
use crate::config::{self, ProfileConfig};
use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

/// A sandbox factory shared across concurrent job executors.
///
/// The runner retains one owner while live jobs and idle sandboxes clone the
/// `Arc`. Shutdown begins only after the runner recovers exclusive mutable
/// access to every factory.
pub(super) type SharedFactory = Arc<Box<dyn SandboxFactory>>;

/// Build one sandbox factory per configured profile.
///
/// On failure, already-created factories are stopped, but shared runtime
/// resources remain owned by the caller so dependent services can stop before
/// the runtime removes their network isolation.
pub(super) async fn start_factories(
    profiles: &BTreeMap<String, ProfileConfig>,
    firecracker: &config::FirecrackerConfig,
    base_dir: &Path,
    home: &HomePaths,
    runtime: &mut dyn SandboxRuntime,
) -> RunnerResult<BTreeMap<String, (SharedFactory, bool)>> {
    let mut factories: BTreeMap<String, (Box<dyn SandboxFactory>, bool)> = BTreeMap::new();
    for (profile_name, profile_config) in profiles {
        let factory_config = config::RunnerConfig::build_factory_config(
            firecracker,
            base_dir,
            profile_name,
            profile_config,
            home,
        );
        let restore_guest_state = factory_config.snapshot.is_some();
        let factory_result = runtime.create_factory(factory_config).await;
        let factory = match factory_result {
            Ok(factory) => factory,
            Err(e) => {
                for (name, (mut factory, _)) in factories {
                    shutdown_factory_instance(&name, factory.as_mut(), None).await;
                }
                return Err(e.into());
            }
        };
        factories.insert(profile_name.clone(), (factory, restore_guest_state));
        info!(profile = %profile_name, "factory started");
    }
    Ok(factories
        .into_iter()
        .map(|(name, (factory, restore_guest_state))| {
            (name, (Arc::new(factory), restore_guest_state))
        })
        .collect())
}

async fn shutdown_factory_instance(
    name: &str,
    factory: &mut dyn SandboxFactory,
    teardown: Option<&TeardownTimer>,
) {
    let phase = teardown.map(|timer| {
        let phase_start = Instant::now();
        info!(
            phase = "factory_shutdown",
            profile = %name,
            elapsed_ms = timer.elapsed_ms(),
            "teardown phase started"
        );
        phase_start
    });
    factory.shutdown().await;
    if let (Some(timer), Some(phase)) = (teardown, phase) {
        info!(
            phase = "factory_shutdown",
            profile = %name,
            phase_ms = TeardownTimer::duration_ms(phase.elapsed()),
            elapsed_ms = timer.elapsed_ms(),
            "teardown phase complete"
        );
    }
}

/// Shut down all factories while retaining shared runtime resources.
///
/// Every factory must be exclusively mutable before any shutdown begins. On
/// failure, the complete map remains intact and no factory has been stopped.
pub(super) async fn shutdown_factory_instances(
    factories: &mut BTreeMap<String, (SharedFactory, bool)>,
    teardown: Option<&TeardownTimer>,
) -> RunnerResult<()> {
    let mut exclusive_factories = Vec::with_capacity(factories.len());
    let mut retained_profiles = Vec::new();
    for (name, (factory, _)) in factories.iter_mut() {
        let strong_count = Arc::strong_count(factory);
        let weak_count = Arc::weak_count(factory);
        match Arc::get_mut(factory) {
            Some(factory) => exclusive_factories.push((name.as_str(), factory.as_mut())),
            None => {
                retained_profiles.push(format!("{name} (strong={strong_count}, weak={weak_count})"))
            }
        }
    }

    if !retained_profiles.is_empty() {
        let retained_profiles = retained_profiles.join(", ");
        error!(
            retained_profiles = %retained_profiles,
            "factory shutdown requires exclusive ownership"
        );
        return Err(RunnerError::Internal(format!(
            "factory shutdown requires exclusive ownership: {retained_profiles}"
        )));
    }

    for (name, factory) in exclusive_factories {
        shutdown_factory_instance(name, factory, teardown).await;
    }
    factories.clear();
    Ok(())
}

/// Release runtime-owned shared resources after their dependent services stop.
pub(super) async fn shutdown_runtime(
    runtime: &mut dyn SandboxRuntime,
    teardown: Option<&TeardownTimer>,
) {
    // Clean up runtime-owned shared resources (netns and NBD device pools).
    let phase = teardown.map(|timer| timer.phase_start("runtime_shutdown"));
    runtime.shutdown().await;
    if let (Some(timer), Some(phase)) = (teardown, phase) {
        timer.phase_complete("runtime_shutdown", phase);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use sandbox::{Sandbox, SandboxError, SandboxInitializationPhase};

    struct RecordingRuntime {
        create_calls: AtomicUsize,
        factory_shutdowns: Arc<Mutex<Vec<String>>>,
        factory_configs: Mutex<Vec<sandbox::FactoryConfig>>,
        runtime_shutdowns: AtomicUsize,
        fail_at: usize,
    }

    impl RecordingRuntime {
        fn new(fail_at: usize) -> Self {
            Self {
                create_calls: AtomicUsize::new(0),
                factory_shutdowns: Arc::new(Mutex::new(Vec::new())),
                factory_configs: Mutex::new(Vec::new()),
                runtime_shutdowns: AtomicUsize::new(0),
                fail_at,
            }
        }

        fn factory_shutdowns(&self) -> Vec<String> {
            self.factory_shutdowns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    #[async_trait]
    impl SandboxRuntime for RecordingRuntime {
        async fn create_factory(
            &self,
            config: sandbox::FactoryConfig,
        ) -> sandbox::Result<Box<dyn SandboxFactory>> {
            let call = self.create_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == self.fail_at {
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::Factory,
                    message: "factory failed".into(),
                });
            }
            let profile = config.profile.clone();
            self.factory_configs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(config);
            Ok(Box::new(RecordingFactory {
                profile,
                shutdowns: Arc::clone(&self.factory_shutdowns),
            }))
        }

        async fn shutdown(&mut self) {
            self.runtime_shutdowns.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct RecordingFactory {
        profile: String,
        shutdowns: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl SandboxFactory for RecordingFactory {
        fn name(&self) -> &str {
            &self.profile
        }

        fn config_hash(&self) -> String {
            "recording".into()
        }

        async fn create(
            &self,
            _config: sandbox::SandboxConfig,
        ) -> sandbox::Result<Box<dyn Sandbox>> {
            panic!("factory lifecycle tests do not create sandboxes")
        }

        async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {}

        async fn shutdown(&mut self) {
            self.shutdowns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(self.profile.clone());
        }
    }

    fn profile(rootfs_hash: &str, snapshot_hash: &str) -> ProfileConfig {
        ProfileConfig {
            rootfs_hash: rootfs_hash.into(),
            snapshot_hash: snapshot_hash.into(),
            vcpu: 2,
            memory_mb: 4096,
            rootfs_disk_mb: 8192,
            workspace_disk_mb: 10240,
        }
    }

    #[tokio::test]
    async fn start_factories_creates_each_configured_profile() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let base_dir = temp.path().join("base");
        let firecracker = config::FirecrackerConfig {
            binary: temp.path().join("firecracker"),
            kernel: temp.path().join("vmlinux"),
        };
        let mut profiles = BTreeMap::new();
        profiles.insert(
            crate::profile::DEFAULT_PROFILE.into(),
            profile("rootfs-1", "snapshot-1"),
        );
        profiles.insert("vm0/large".into(), profile("rootfs-2", "snapshot-2"));
        let mut runtime = RecordingRuntime::new(usize::MAX);

        let factories = start_factories(&profiles, &firecracker, &base_dir, &home, &mut runtime)
            .await
            .unwrap();

        assert_eq!(runtime.create_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            factories.keys().cloned().collect::<Vec<_>>(),
            vec![
                crate::profile::DEFAULT_PROFILE.to_string(),
                "vm0/large".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn start_factories_shuts_down_started_factories_after_create_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let base_dir = temp.path().join("base");
        let firecracker = config::FirecrackerConfig {
            binary: temp.path().join("firecracker"),
            kernel: temp.path().join("vmlinux"),
        };
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/first".into(), profile("rootfs-1", "snapshot-1"));
        profiles.insert("vm0/second".into(), profile("rootfs-2", "snapshot-2"));
        let mut runtime = RecordingRuntime::new(2);

        let result = start_factories(&profiles, &firecracker, &base_dir, &home, &mut runtime).await;

        match result {
            Err(RunnerError::Sandbox(SandboxError::Initialization { phase, message })) => {
                assert_eq!(phase, SandboxInitializationPhase::Factory);
                assert_eq!(message, "factory failed");
            }
            Err(other) => panic!("expected factory creation error, got {other:?}"),
            Ok(_) => panic!("expected factory creation error"),
        }
        assert_eq!(runtime.create_calls.load(Ordering::SeqCst), 2);
        assert_eq!(runtime.factory_shutdowns(), vec!["vm0/first"]);
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn start_factories_retains_runtime_after_first_factory_create_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let base_dir = temp.path().join("base");
        let firecracker = config::FirecrackerConfig {
            binary: temp.path().join("firecracker"),
            kernel: temp.path().join("vmlinux"),
        };
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/first".into(), profile("rootfs-1", "snapshot-1"));
        profiles.insert("vm0/second".into(), profile("rootfs-2", "snapshot-2"));
        let mut runtime = RecordingRuntime::new(1);

        let result = start_factories(&profiles, &firecracker, &base_dir, &home, &mut runtime).await;

        match result {
            Err(RunnerError::Sandbox(SandboxError::Initialization { phase, message })) => {
                assert_eq!(phase, SandboxInitializationPhase::Factory);
                assert_eq!(message, "factory failed");
            }
            Err(other) => panic!("expected factory creation error, got {other:?}"),
            Ok(_) => panic!("expected factory creation error"),
        }
        assert_eq!(runtime.create_calls.load(Ordering::SeqCst), 1);
        assert!(runtime.factory_shutdowns().is_empty());
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn split_shutdown_preserves_all_factories_until_every_reference_is_released() {
        let mut runtime = RecordingRuntime::new(usize::MAX);
        let factory_shutdowns = Arc::clone(&runtime.factory_shutdowns);
        let unique_factory: SharedFactory = Arc::new(Box::new(RecordingFactory {
            profile: "vm0/first".into(),
            shutdowns: Arc::clone(&factory_shutdowns),
        }));
        let retained_factory: SharedFactory = Arc::new(Box::new(RecordingFactory {
            profile: "vm0/second".into(),
            shutdowns: Arc::clone(&factory_shutdowns),
        }));
        let weakly_referenced_factory: SharedFactory = Arc::new(Box::new(RecordingFactory {
            profile: "vm0/third".into(),
            shutdowns: Arc::clone(&factory_shutdowns),
        }));
        let retained_weak_factory = Arc::downgrade(&weakly_referenced_factory);
        let mut factories = BTreeMap::new();
        factories.insert("vm0/first".into(), (unique_factory, false));
        factories.insert("vm0/second".into(), (Arc::clone(&retained_factory), false));
        factories.insert("vm0/third".into(), (weakly_referenced_factory, false));

        let error = shutdown_factory_instances(&mut factories, None)
            .await
            .unwrap_err();

        let RunnerError::Internal(message) = error else {
            panic!("expected internal ownership error, got {error:?}");
        };
        assert!(
            message.contains("vm0/second (strong=2, weak=0)"),
            "got: {message}"
        );
        assert!(
            message.contains("vm0/third (strong=1, weak=1)"),
            "got: {message}"
        );
        assert_eq!(factories.len(), 3);
        assert!(runtime.factory_shutdowns().is_empty());
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 0);

        drop(retained_factory);
        drop(retained_weak_factory);

        shutdown_factory_instances(&mut factories, None)
            .await
            .unwrap();

        assert!(factories.is_empty());
        assert_eq!(
            runtime.factory_shutdowns(),
            vec!["vm0/first", "vm0/second", "vm0/third"]
        );
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 0);

        shutdown_runtime(&mut runtime, None).await;

        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 1);
    }
}
