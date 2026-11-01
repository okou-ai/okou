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

    async fn create(&self, _config: sandbox::SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
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

fn profile(
    name: &str,
    rootfs_hash: &str,
    snapshot_hash: &str,
    binary_kernel: &(std::path::PathBuf, std::path::PathBuf),
    base_dir: &Path,
    home: &HomePaths,
) -> ProfileConfig {
    let rootfs = runner_host::paths::RootfsPaths::new(home, rootfs_hash);
    ProfileConfig {
        vcpu: 2,
        memory_mb: 4096,
        rootfs_hash: rootfs_hash.into(),
        rootfs_disk_mb: 12288,
        home_disk_mb: 10240,
        factory_config: sandbox::FactoryConfig {
            home_drive_pressure: None,
            profile: name.into(),
            binary_path: binary_kernel.0.clone(),
            kernel_path: binary_kernel.1.clone(),
            rootfs_path: rootfs.rootfs(),
            base_dir: base_dir.to_path_buf(),
            snapshot: Some(sandbox::SnapshotRef {
                output_dir: rootfs.snapshot_dir(snapshot_hash),
                hash: snapshot_hash.into(),
            }),
        },
    }
}

#[tokio::test]
async fn start_factories_creates_each_configured_profile() {
    let temp = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(temp.path().join("home"));
    let base_dir = temp.path().join("base");
    let binary_kernel = (temp.path().join("firecracker"), temp.path().join("vmlinux"));
    let mut profiles = BTreeMap::new();
    let default = runner_types::profile_name::DEFAULT_PROFILE;
    profiles.insert(
        default.into(),
        profile(
            default,
            "rootfs-1",
            "snapshot-1",
            &binary_kernel,
            &base_dir,
            &home,
        ),
    );
    profiles.insert(
        "vm0/large".into(),
        profile(
            "vm0/large",
            "rootfs-2",
            "snapshot-2",
            &binary_kernel,
            &base_dir,
            &home,
        ),
    );
    let mut runtime = RecordingRuntime::new(usize::MAX);

    let cache = crate::home_image_cache::HomeImageCache::shared(
        runner_host::paths::RunnerPaths::new(base_dir.clone()),
        &home,
        "group-a",
    );
    let factories = start_factories(&profiles, &mut runtime, Some(&cache))
        .await
        .unwrap();

    assert_eq!(runtime.create_calls.load(Ordering::SeqCst), 2);
    assert!(
        runtime
            .factory_configs
            .lock()
            .unwrap()
            .iter()
            .all(|config| config.home_drive_pressure.is_some())
    );
    assert_eq!(
        factories.keys().cloned().collect::<Vec<_>>(),
        vec![
            runner_types::profile_name::DEFAULT_PROFILE.to_string(),
            "vm0/large".to_string()
        ]
    );
}

#[tokio::test]
async fn start_factories_shuts_down_started_factories_after_create_error() {
    let temp = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(temp.path().join("home"));
    let base_dir = temp.path().join("base");
    let binary_kernel = (temp.path().join("firecracker"), temp.path().join("vmlinux"));
    let mut profiles = BTreeMap::new();
    profiles.insert(
        "vm0/first".into(),
        profile(
            "vm0/first",
            "rootfs-1",
            "snapshot-1",
            &binary_kernel,
            &base_dir,
            &home,
        ),
    );
    profiles.insert(
        "vm0/second".into(),
        profile(
            "vm0/second",
            "rootfs-2",
            "snapshot-2",
            &binary_kernel,
            &base_dir,
            &home,
        ),
    );
    let mut runtime = RecordingRuntime::new(2);

    let result = start_factories(&profiles, &mut runtime, None).await;

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
    let binary_kernel = (temp.path().join("firecracker"), temp.path().join("vmlinux"));
    let mut profiles = BTreeMap::new();
    profiles.insert(
        "vm0/first".into(),
        profile(
            "vm0/first",
            "rootfs-1",
            "snapshot-1",
            &binary_kernel,
            &base_dir,
            &home,
        ),
    );
    profiles.insert(
        "vm0/second".into(),
        profile(
            "vm0/second",
            "rootfs-2",
            "snapshot-2",
            &binary_kernel,
            &base_dir,
            &home,
        ),
    );
    let mut runtime = RecordingRuntime::new(1);

    let result = start_factories(&profiles, &mut runtime, None).await;

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
