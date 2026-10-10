mod admission;
mod phases;
mod settlement;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use sandbox::{SandboxBackingProcess, SandboxFactory};
use sandbox_mock::{MockSandbox, MockSandboxFactory, MockSandboxOverrides};
use tokio::sync::oneshot;

use super::*;
use crate::home_promotion::test_support::{
    HomePromotionFixture, add_healthy_cache_preparation_matcher, test_home_image,
};
use crate::host_memory_operations::{
    MemoryObservationSource, MemoryOperationPolicy, MemoryOperationSnapshot,
};
use crate::host_memory_policy::HostMemoryBounds;
use crate::idle_pool::entry::{HomePromotionPolicy, IdleDestroyPayload, IdleSandboxResources};
use crate::resource_budget::ResourceBudget;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);

struct ReadGate {
    seen: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

struct FileSource {
    path: PathBuf,
    gate: Mutex<Option<ReadGate>>,
}

impl MemoryObservationSource for FileSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            let gate = self.gate.lock().unwrap().take();
            let observation = HostMemoryObservation::read_at(&self.path).await;
            if let Some(gate) = gate {
                gate.seen.send(()).unwrap();
                gate.release.await.unwrap();
            }
            observation
        })
    }
}

impl FileSource {
    async fn available(&self, mib: u64) {
        tokio::fs::write(&self.path, format!("MemAvailable: {} kB\n", mib * 1024))
            .await
            .unwrap();
    }

    fn gate_read(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (seen, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        assert!(
            self.gate
                .lock()
                .unwrap()
                .replace(ReadGate {
                    seen,
                    release: wait,
                })
                .is_none()
        );
        (observed, release)
    }
}

fn policy() -> MemoryOperationPolicy {
    // Synthetic measured-input fixtures, not production defaults/calibration.
    MemoryOperationPolicy {
        bounds: HostMemoryBounds {
            host_total_bytes: 64 * MIB,
            operating_floor_bytes: 2 * MIB,
            cleanup_reserve_bytes: 4 * MIB,
            critical_available_bytes: 2 * MIB,
            recovery_available_bytes: 8 * MIB,
        },
        max_sample_age: Duration::from_secs(10),
        max_operations: 16,
        max_cleanup_inflight: 4,
    }
}

fn envelope() -> IdleRetirementEnvelope {
    IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    }
}

struct Env {
    _dir: tempfile::TempDir,
    source: Arc<FileSource>,
    operations: HostMemoryOperations,
}

impl Env {
    async fn new(available: u64) -> Self {
        Self::with_policy(available, policy()).await
    }

    async fn with_policy(available: u64, policy: MemoryOperationPolicy) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = Arc::new(FileSource {
            path: dir.path().join("meminfo"),
            gate: Mutex::new(None),
        });
        source.available(available).await;
        let operations = HostMemoryOperations::new(policy, source.clone()).unwrap();
        Self {
            _dir: dir,
            source,
            operations,
        }
    }
}

struct JobFixture {
    _dir: Arc<tempfile::TempDir>,
    cache: crate::home_image_cache::HomeImageCache,
    active_image: PathBuf,
    reuse_key: String,
    overrides: Arc<MockSandboxOverrides>,
    budget: Arc<ResourceBudget>,
    job: Option<IdleDestroyJob>,
}

impl JobFixture {
    async fn new(key: &str, backing: Option<Arc<dyn SandboxBackingProcess>>) -> Self {
        let home = HomePromotionFixture::new(key).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_cache_preparation_matcher(&overrides);
        let mut sandbox =
            MockSandbox::with_overrides(home.sandbox_id.to_string(), Arc::clone(&overrides));
        if let Some(backing) = backing {
            sandbox = sandbox.with_backing_process(backing);
        }
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
        ));
        let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
        let active_image = home.cache.paths().active_home_image(&home.sandbox_id);
        Self {
            _dir: home._dir,
            cache: home.cache,
            active_image,
            reuse_key: home.reuse_key,
            overrides,
            budget,
            job: Some(IdleDestroyJob {
                payload: IdleDestroyPayload {
                    resources: IdleSandboxResources {
                        sandbox: Box::new(sandbox),
                        factory,
                        home_promotion: Some(home.promotion),
                    },
                    home_promotion_policy: HomePromotionPolicy::Promote,
                },
                budget_lease: lease,
                reuse_key: Some(key.to_owned()),
                profile_name: "vm0/default".into(),
            }),
        }
    }

    fn pending(&mut self, env: &Env) -> GuardedIdleRetirement {
        GuardedIdleRetirement::new(self.job.take().unwrap(), &env.operations, envelope()).unwrap()
    }

    async fn untouched(&self) {
        assert_eq!(self.budget.allocated(), (2, 8, 1));
        assert_eq!(self.overrides.unpark_call_count(), 0);
        assert!(self.overrides.exec_calls().is_empty());
        assert_eq!(self.overrides.kill_call_count(), 0);
        assert_eq!(self.overrides.destroy_call_count(), 0);
        assert_eq!(
            tokio::fs::read(&self.active_image).await.unwrap(),
            test_home_image()
        );
    }

    async fn saved(&self) {
        use crate::home_image_cache::{HomeImageLeaseIdentity, HomeImagePrepareRequest};
        let checkout = self
            .cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: runner_types::ids::RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    rootfs_hash: "test-rootfs",
                    reuse_key: Some(&self.reuse_key),
                    working_dir:
                        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                    image_size_bytes: MIB,
                },
                home_drive_required: true,
            })
            .await;
        assert!(checkout.is_cache_hit());
        let mut checkout = checkout;
        let source = match checkout.home_drive_config().unwrap().seed_image.unwrap() {
            sandbox::HomeDriveSeedImage::Copy(path) | sandbox::HomeDriveSeedImage::Move(path) => {
                path
            }
        };
        assert_eq!(tokio::fs::read(source).await.unwrap(), test_home_image());
    }
}

async fn admitted(fixture: &mut JobFixture, env: &Env) -> GuardedIdleRetirement {
    let mut pending = fixture.pending(env);
    pending.try_grant().await.unwrap();
    pending
}

async fn wait_snapshot(
    operations: &HostMemoryOperations,
    test: impl Fn(&MemoryOperationSnapshot) -> bool,
) -> MemoryOperationSnapshot {
    tokio::time::timeout(WAIT, async {
        loop {
            let snapshot = operations.snapshot().unwrap();
            if test(&snapshot) {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
