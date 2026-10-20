//! Runner composition seams with supplied synthetic policy and external providers.

use std::{error::Error, io, path::PathBuf, sync::Arc, time::Duration};

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::home_image_cache::HomeCacheCheckoutResult;
use runner_lifecycle::home_promotion::test_support::{
    HomePromotionFixture, add_healthy_cache_preparation_matcher,
};
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPlan, MemoryOperationPolicy,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdleActivationOwner, IdlePool, IdlePoolConfig,
    IdleRetirementEnvelope, ParkResult, test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_supervisor::idle_lifecycle::IdleDestroyTracker;
use runner_types::ids::RunId;
use sandbox::{Sandbox, SandboxFactory};
use sandbox_mock::{
    ExecMatcher, MockBackingProcess, MockLifecycleGate, MockSandbox, MockSandboxFactory,
    MockSandboxOverrides,
};
use tokio::sync::Notify;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);
type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

struct Source(PathBuf);
impl MemoryObservationSource for Source {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

async fn operations(dir: &std::path::Path) -> TestResult<HostMemoryOperations> {
    let path = dir.join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n").await?;
    Ok(HostMemoryOperations::new(
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
        },
        Arc::new(Source(path)),
    )?)
}

fn envelope() -> IdleRetirementEnvelope {
    IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    }
}

fn owner(
    home: HomePromotionFixture,
    budget: &Arc<ResourceBudget>,
    overrides: Arc<MockSandboxOverrides>,
    backing: Arc<dyn sandbox::SandboxBackingProcess>,
) -> TestResult<IdleActivationOwner> {
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(overrides.clone()),
    ));
    let lease = ResourceBudget::try_reserve_lease(budget, 2, 8)
        .ok_or_else(|| io::Error::other("ordinary fixture full lease unavailable"))?;
    let candidate = ParkedIdleCandidateBuilder::new(&home.reuse_key, lease)
        .with_source_run_id(home.promotion.run_id())
        .with_sandbox_id(home.sandbox_id)
        .with_sandbox(Box::new(
            MockSandbox::with_overrides(home.sandbox_id.to_string(), overrides)
                .with_backing_process(backing),
        ))
        .with_factory(factory)
        .with_home_promotion(home.promotion)
        .build();
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let reservation = pool
        .take_reserved(&home.reuse_key)
        .ok_or_else(|| io::Error::other("ordinary parked fixture disappeared"))?;
    IdleActivationOwner::new(reservation)
        .map_err(|_| io::Error::other("ordinary fixture received running handoff").into())
}

#[tokio::test]
async fn runner_composes_covered_replacement_before_old_exit_and_returns_original_full_lease() {
    let dir = tempfile::tempdir().unwrap();
    let operations = operations(dir.path()).await.unwrap();
    let home = HomePromotionFixture::new("thread:runner-owned-caller").await;
    let home_dir = home._dir.clone();
    // Account for host CPU reservation while admitting both full two-vCPU leases.
    let budget = Arc::new(ResourceBudget::new(5, 16, 1.0, 0));
    let overrides = Arc::new(MockSandboxOverrides::new());
    add_healthy_cache_preparation_matcher(&overrides);
    let (exit, backing) = MockBackingProcess::channel();
    let mut owner = owner(home, &budget, overrides.clone(), backing).unwrap();
    overrides.push_unpark_result(Err(sandbox::SandboxError::Start {
        message: "partial ordinary activation failure".into(),
    }));
    assert!(owner.activate(RunId::new_v4()).await.is_err());
    let kill = MockLifecycleGate::new();
    overrides.set_kill_lifecycle_gate(kill.clone());
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    let mut cleanup = tracker
        .retire_activation_owner(
            &mut Some(owner),
            &operations,
            envelope(),
            "runner_caller_replacement",
        )
        .await
        .unwrap();
    kill.wait_entered(1, WAIT).await.unwrap();
    let mut request = operations
        .request(MemoryOperationPlan::Fresh {
            memory_mib: 8,
            preparation_bytes: MIB,
        })
        .unwrap();
    let permit = request.try_grant().await.unwrap();
    let new_lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
    let fresh = permit
        .spawn(move |mut operation| async move {
            // The external provider launch and readiness occur under the separate
            // replacement allowance, without observing or joining the old exit.
            let (_, backing) = MockBackingProcess::channel();
            let mut sandbox =
                MockSandbox::new("replacement-owned-generation").with_backing_process(backing);
            operation
                .bind_backing(sandbox.backing_process().unwrap())
                .unwrap();
            sandbox.start().await.unwrap();
            operation.complete_phase().await.unwrap();
            (sandbox, new_lease)
        })
        .unwrap();
    let (mut replacement, replacement_lease) = tokio::time::timeout(WAIT, fresh.join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(budget.allocated(), (4, 16, 2));
    assert_eq!(overrides.destroy_call_count(), 0);
    assert_eq!(operations.snapshot().unwrap().cleanup_growth_bytes, 9 * MIB);
    exit.confirm_exit();
    kill.release_one();
    assert!(matches!(
        tokio::time::timeout(WAIT, cleanup.join())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    let original = cleanup.take_completed_lease().unwrap();
    assert_eq!((original.vcpu(), original.memory_mb()), (2, 8));
    assert_eq!(budget.allocated(), (4, 16, 2));
    replacement.kill().await.unwrap();
    drop(replacement_lease);
    drop(original);
    tracker.close_and_wait().await;
    assert!(
        tracker
            .take_retained_activation_owners()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
    assert_eq!(budget.allocated(), (0, 0, 0));
    drop(home_dir);
}

#[tokio::test]
async fn runner_shutdown_recovers_required_saving_owner_after_result_consumer_is_lost() {
    let dir = tempfile::tempdir().unwrap();
    let operations = operations(dir.path()).await.unwrap();
    let home = HomePromotionFixture::new("thread:runner-retained-saving").await;
    let home_dir = home._dir.clone();
    let cache = home.cache.clone();
    let key = home.reuse_key.clone();
    let id = home.sandbox_id;
    let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
    let overrides = Arc::new(MockSandboxOverrides::new());
    add_healthy_cache_preparation_matcher(&overrides);
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "--freeze".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"required freeze rejected".to_vec(),
    });
    let (_, backing) = MockBackingProcess::channel();
    let owner = owner(home, &budget, overrides.clone(), backing).unwrap();
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    drop(
        tracker
            .retire_activation_owner(
                &mut Some(owner),
                &operations,
                envelope(),
                "runner_retained_saving",
            )
            .await
            .unwrap(),
    );
    tokio::time::timeout(WAIT, tracker.close_and_wait())
        .await
        .unwrap();
    let mut retained = tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].sandbox_id(), id);
    assert!(retained[0].cleanup_error().is_some());
    assert!(retained[0].take_completed_lease().is_err());
    assert_eq!(budget.allocated(), (2, 8, 1));
    assert_eq!(overrides.kill_call_count(), 0);
    assert_eq!(overrides.destroy_call_count(), 0);
    assert_eq!(
        HomePromotionFixture::checkout_result(&cache, &key).await,
        HomeCacheCheckoutResult::LockBusy
    );
    assert_eq!(operations.close_and_wait().await.unwrap().uncertain, 2);
    drop(home_dir);
}
