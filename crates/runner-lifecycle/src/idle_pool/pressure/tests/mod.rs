use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use sandbox::SandboxId;
use sandbox_mock::{MockSandbox, MockSandboxFactory};
use tokio::sync::Notify;

use crate::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPlan, MemoryOperationPolicy,
};
use crate::host_memory_policy::HostMemoryBounds;
use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
use crate::idle_pool::{
    IdlePool, IdlePoolConfig, IdleSandboxIdentity, ParkResult, ParkedIdleCandidate,
    RestoreReservedIdleResult,
};
use crate::resource_budget::ResourceBudget;

fn budget() -> Arc<ResourceBudget> {
    Arc::new(ResourceBudget::new(128, 1024, 1.0, 0))
}

fn exact(budget: &Arc<ResourceBudget>, key: &str) -> ParkedIdleCandidate {
    ParkedIdleCandidateBuilder::new(
        key,
        ResourceBudget::try_reserve_lease(budget, 2, 8).unwrap(),
    )
    .with_mock_sandbox_name("same-provider-label")
    .build()
}

fn blank(budget: &Arc<ResourceBudget>) -> ParkedIdleCandidate {
    let id = SandboxId::new_v4();
    ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new("same-provider-label")),
        Arc::new(Box::new(MockSandboxFactory::new())),
        ResourceBudget::try_reserve_lease(budget, 2, 8).unwrap(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    )
}

fn limit(count: usize) -> NonZeroUsize {
    NonZeroUsize::new(count).unwrap()
}

async fn cleanup(pool: &mut IdlePool) {
    for job in pool.drain() {
        job.run().await;
    }
}

#[tokio::test]
async fn bounded_candidates_are_blank_first_oldest_and_deterministic_at_ties() {
    let budget = budget();
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    let now = Instant::now();
    let first_blank = blank(&budget);
    let second_blank = blank(&budget);
    let mut blank_ids = [first_blank.sandbox_id(), second_blank.sandbox_id()];
    blank_ids.sort();
    for candidate in [first_blank, second_blank] {
        assert!(matches!(
            pool.park_at_for_test(candidate, now),
            ParkResult::Parked
        ));
    }
    for (key, age) in [("b", 3), ("a", 3), ("young", 1)] {
        assert!(matches!(
            pool.park_at_for_test(exact(&budget, key), now - Duration::from_secs(age)),
            ParkResult::Parked
        ));
    }
    for index in (0..32).rev() {
        assert!(matches!(
            pool.park_at_for_test(exact(&budget, &format!("other-{index}")), now),
            ParkResult::Parked
        ));
    }
    let selected = pool.pressure_candidates(limit(5));
    assert_eq!(selected.len(), 5);
    assert_eq!(
        selected
            .iter()
            .map(|c| c.identity().clone())
            .collect::<Vec<_>>(),
        vec![
            IdleSandboxIdentity::Blank(blank_ids[0]),
            IdleSandboxIdentity::Blank(blank_ids[1]),
            IdleSandboxIdentity::Exact("a".into()),
            IdleSandboxIdentity::Exact("b".into()),
            IdleSandboxIdentity::Exact("young".into()),
        ]
    );
    assert!(
        selected
            .iter()
            .all(|c| pool.revalidate_pressure_candidate(c))
    );
    assert_eq!(
        pool.pressure_candidates(limit(1))[0].identity(),
        selected[0].identity()
    );
    let exact = &selected[2];
    assert_eq!((exact.vcpu(), exact.memory_mb()), (2, 8));
    assert_eq!(exact.profile_name(), "vm0/default");
    assert_eq!(exact.device_rate_limits(), &None);
    assert_eq!(exact.parked_at(), now - Duration::from_secs(3));
    assert_eq!(
        pool.len(),
        37,
        "selection never detaches or releases a lease"
    );
    cleanup(&mut pool).await;
}

#[tokio::test]
async fn reservation_restore_and_same_key_replacement_invalidate_old_candidates() {
    let budget = budget();
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    assert!(matches!(
        pool.park(exact(&budget, "key")),
        ParkResult::Parked
    ));
    let original = pool.pressure_candidates(limit(1)).pop().unwrap();
    let reserved = pool.reserve_reusable("key", "vm0/default", &None).unwrap();
    assert!(pool.pressure_candidates(limit(1)).is_empty());
    assert!(!pool.revalidate_pressure_candidate(&original));
    assert!(matches!(
        pool.restore_reserved(reserved),
        RestoreReservedIdleResult::Restored
    ));
    assert!(
        !pool.revalidate_pressure_candidate(&original),
        "same resource restored is a new pool revision"
    );
    let restored = pool.pressure_candidates(limit(1)).pop().unwrap();
    assert!(pool.revalidate_pressure_candidate(&restored));
    let replacement = exact(&budget, "key");
    let replacement_id = replacement.sandbox_id();
    let displaced = match pool.park(replacement) {
        ParkResult::Replaced(job) => job,
        _ => panic!("replacement must own displaced cleanup"),
    };
    displaced.run().await;
    assert!(!pool.revalidate_pressure_candidate(&restored));
    let current = pool.pressure_candidates(limit(1)).pop().unwrap();
    assert_eq!(current.sandbox_id(), replacement_id);
    assert_ne!(current.sandbox_id(), restored.sandbox_id());
    assert!(pool.revalidate_pressure_candidate(&current));
    cleanup(&mut pool).await;
}

#[tokio::test]
async fn equal_resource_metadata_cannot_authorize_a_different_pool_owner() {
    let budget = budget();
    let mut first = IdlePool::new(IdlePoolConfig::default());
    let mut second = IdlePool::new(IdlePoolConfig::default());
    let id = SandboxId::new_v4();
    let now = Instant::now();
    for pool in [&mut first, &mut second] {
        let candidate = ParkedIdleCandidateBuilder::new(
            "same-key",
            ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap(),
        )
        .with_sandbox_id(id)
        .build();
        assert!(matches!(
            pool.park_at_for_test(candidate, now),
            ParkResult::Parked
        ));
    }
    let candidate = first.pressure_candidates(limit(1)).pop().unwrap();
    assert!(first.revalidate_pressure_candidate(&candidate));
    assert!(!second.revalidate_pressure_candidate(&candidate));
    cleanup(&mut first).await;
    cleanup(&mut second).await;
}

#[tokio::test]
async fn unrelated_mutation_drain_and_repark_defer_a_captured_selection() {
    let budget = budget();
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    assert!(matches!(
        pool.park(exact(&budget, "key")),
        ParkResult::Parked
    ));
    let old = pool.pressure_candidates(limit(1)).pop().unwrap();
    assert!(matches!(pool.park(blank(&budget)), ParkResult::Parked));
    assert!(!pool.revalidate_pressure_candidate(&old));
    let before_drain = pool.pressure_candidates(limit(2));
    cleanup(&mut pool).await;
    assert!(
        before_drain
            .iter()
            .all(|c| !pool.revalidate_pressure_candidate(c))
    );
    assert!(matches!(
        pool.park(exact(&budget, "key")),
        ParkResult::Parked
    ));
    assert!(!pool.revalidate_pressure_candidate(&old));
    assert!(pool.revalidate_pressure_candidate(&pool.pressure_candidates(limit(1))[0]));
    cleanup(&mut pool).await;
}

#[tokio::test]
async fn saturated_revision_cannot_issue_or_validate_selection_authority() {
    let budget = budget();
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    assert!(matches!(
        pool.park(exact(&budget, "key")),
        ParkResult::Parked
    ));
    let candidate = pool.pressure_candidates(limit(1)).pop().unwrap();
    // Owner-local overflow boundary: reaching this via u64::MAX public mutations
    // is not a practical fixture, but its fail-closed result is a real contract.
    pool.revision = u64::MAX;
    assert!(pool.pressure_candidates(limit(1)).is_empty());
    assert!(!pool.revalidate_pressure_candidate(&candidate));
    cleanup(&mut pool).await;
}

struct GatedObservation {
    path: std::path::PathBuf,
    entered: Notify,
    released: Notify,
}

impl MemoryObservationSource for GatedObservation {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            let observation = HostMemoryObservation::read_at(&self.path).await;
            self.entered.notify_one();
            self.released.notified().await;
            observation
        })
    }
}

#[tokio::test]
async fn real_p2_capacity_wait_stays_outside_pool_and_revalidates_after_repark() {
    let budget = budget();
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
        IdlePoolConfig::default(),
    )));
    let candidate = {
        let mut pool = pool.lock().await;
        assert!(matches!(
            pool.park(exact(&budget, "key")),
            ParkResult::Parked
        ));
        pool.pressure_candidates(limit(1)).pop().unwrap()
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    let source = Arc::new(GatedObservation {
        path,
        entered: Notify::new(),
        released: Notify::new(),
    });
    let operations = HostMemoryOperations::new(
        MemoryOperationPolicy {
            bounds: HostMemoryBounds {
                host_total_bytes: 64 * 1024 * 1024,
                operating_floor_bytes: 2 * 1024 * 1024,
                cleanup_reserve_bytes: 4 * 1024 * 1024,
                critical_available_bytes: 2 * 1024 * 1024,
                recovery_available_bytes: 8 * 1024 * 1024,
            },
            max_sample_age: Duration::from_secs(10),
            max_operations: 2,
            max_cleanup_inflight: 1,
        },
        source.clone(),
    )
    .unwrap();
    let mut request = operations
        .request(MemoryOperationPlan::CleanupIo { growth_bytes: 1024 })
        .unwrap();
    let pending = tokio::spawn(async move { request.try_grant().await });
    tokio::time::timeout(Duration::from_secs(2), source.entered.notified())
        .await
        .unwrap();
    let restored = {
        let mut pool = tokio::time::timeout(Duration::from_secs(2), pool.lock())
            .await
            .unwrap();
        let reserved = pool.reserve_reusable("key", "vm0/default", &None).unwrap();
        matches!(
            pool.restore_reserved(reserved),
            RestoreReservedIdleResult::Restored
        )
    };
    source.released.notify_one();
    let permit = pending.await.unwrap().unwrap();
    let valid = pool.lock().await.revalidate_pressure_candidate(&candidate);
    // No physical work started: release only the unused real P2 permission.
    drop(permit);
    let finished = operations.close_and_wait().await.unwrap();
    let jobs = pool.lock().await.drain();
    for job in jobs {
        job.run().await;
    }
    assert!(restored);
    assert!(
        !valid,
        "a granted allowance cannot authorize an old pool snapshot"
    );
    assert_eq!(finished.registered_operations, 0);
    assert_eq!(finished.tracked_tasks, 0);
}
