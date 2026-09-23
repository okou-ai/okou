use super::super::super::*;

use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_pool::{ParkResult, test_support::ParkedIdleCandidateBuilder};
use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceCacheTerminalStatus, WorkspaceImageCache, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest, WorkspaceImagePromotionRequest,
};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use runner_host::paths::RunnerPaths;
use runner_types::ids::RunId;
use sandbox::SandboxId;

const TEST_LAST_COMPLETED_AT: &str = "2026-05-28T00:00:00.000Z";

struct IdlePoolSeedSpec<'a> {
    reuse_key: &'a str,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    history_generation_run_id: Option<RunId>,
    guest_timezone_intent: GuestTimezoneIntent,
    timing: Option<std::time::Instant>,
}

pub(in super::super) struct SpeculativeIdleSeedSpec<'a> {
    pub(in super::super) reuse_key: &'a str,
    pub(in super::super) profile_name: &'a str,
    pub(in super::super) vcpu: u32,
    pub(in super::super) memory_mb: u32,
    pub(in super::super) history_generation_run_id: RunId,
    pub(in super::super) guest_timezone_intent: GuestTimezoneIntent,
    pub(in super::super) timing: Option<std::time::Instant>,
}

/// Pre-populate idle pool with an entry and reserve its budget. Returns
/// the entry's sandbox id so reuse tests can assert it propagates through
/// to the completion payload.
pub(in super::super) async fn seed_idle_pool(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    reuse_key: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) -> SandboxId {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        &overrides,
        IdlePoolSeedSpec {
            reuse_key,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: None,
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            timing: None,
        },
    )
    .await
}

pub(in super::super) async fn seed_idle_pool_with_history_generation(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    reuse_key: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
    history_generation_run_id: RunId,
) -> SandboxId {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        &overrides,
        IdlePoolSeedSpec {
            reuse_key,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: Some(history_generation_run_id),
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            timing: None,
        },
    )
    .await
}

pub(in super::super) async fn seed_idle_pool_with_speculative_timezone(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    overrides: &Arc<sandbox_mock::MockSandboxOverrides>,
    spec: SpeculativeIdleSeedSpec<'_>,
) -> SandboxId {
    let SpeculativeIdleSeedSpec {
        reuse_key,
        profile_name,
        vcpu,
        memory_mb,
        history_generation_run_id,
        guest_timezone_intent,
        timing,
    } = spec;
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        overrides,
        IdlePoolSeedSpec {
            reuse_key,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: Some(history_generation_run_id),
            guest_timezone_intent,
            timing,
        },
    )
    .await
}

pub(in super::super) async fn seed_idle_pool_with_overrides(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    overrides: &Arc<sandbox_mock::MockSandboxOverrides>,
    reuse_key: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) -> SandboxId {
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        overrides,
        IdlePoolSeedSpec {
            reuse_key,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: None,
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            timing: None,
        },
    )
    .await
}

async fn seed_idle_pool_with_overrides_and_generation(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    overrides: &Arc<sandbox_mock::MockSandboxOverrides>,
    spec: IdlePoolSeedSpec<'_>,
) -> SandboxId {
    let IdlePoolSeedSpec {
        reuse_key,
        profile_name,
        vcpu,
        memory_mb,
        history_generation_run_id,
        guest_timezone_intent,
        timing,
    } = spec;
    let runtime = sandbox_mock::MockSandboxRuntime::with_overrides(Arc::clone(overrides));
    let factory = runtime
        .create_factory(sandbox::FactoryConfig {
            profile: profile_name.into(),
            binary_path: PathBuf::new(),
            kernel_path: PathBuf::new(),
            rootfs_path: PathBuf::new(),
            base_dir: PathBuf::new(),
            snapshot: None,
        })
        .await
        .expect("create factory");
    let factory_arc: Arc<Box<dyn sandbox::SandboxFactory>> = Arc::new(factory);
    let sandbox_id = SandboxId::new_v4();
    let sandbox = factory_arc
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: vcpu,
                memory_mb,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).expect("reserve budget");

    let builder = ParkedIdleCandidateBuilder::new(reuse_key, budget_lease)
        .with_sandbox(sandbox)
        .with_factory(factory_arc)
        .with_sandbox_id(sandbox_id)
        .with_profile_name(profile_name)
        .with_guest_timezone_intent(guest_timezone_intent)
        .with_last_completed_at(TEST_LAST_COMPLETED_AT);
    let candidate = match history_generation_run_id {
        Some(run_id) => builder.with_history_generation_run_id(run_id).build(),
        None => builder.build(),
    };
    let mut guard = pool.lock().await;
    let result = match timing {
        Some(parked_at) => guard.park_at_for_test(candidate, parked_at),
        None => guard.park(candidate),
    };
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

pub(in super::super) struct WorkspacePromotionSeedSpec<'a> {
    pub(in super::super) reuse_key: &'a str,
    pub(in super::super) profile_name: &'a str,
    pub(in super::super) vcpu: u32,
    pub(in super::super) memory_mb: u32,
    pub(in super::super) image_size_bytes: u64,
}

pub(in super::super) async fn seed_idle_pool_with_workspace_promotion(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    cache: &WorkspaceImageCache,
    paths: &RunnerPaths,
    spec: WorkspacePromotionSeedSpec<'_>,
) -> SandboxId {
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: spec.profile_name,
                reuse_key: Some(spec.reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: spec.image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(spec.image_size_bytes).await.unwrap();
    drop(file);
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: TEST_LAST_COMPLETED_AT.into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .expect("workspace image should be promotable");
    let budget_lease = ResourceBudget::try_reserve_lease(budget, spec.vcpu, spec.memory_mb)
        .expect("reserve budget");
    let candidate = ParkedIdleCandidateBuilder::new(spec.reuse_key, budget_lease)
        .with_mock_sandbox_name("idle-workspace-promotion-test")
        .with_sandbox_id(sandbox_id)
        .with_profile_name(spec.profile_name)
        .with_workspace_promotion(promotion)
        .with_last_completed_at(TEST_LAST_COMPLETED_AT)
        .build();
    let mut guard = pool.lock().await;
    let result = guard.park(candidate);
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

pub(in super::super) async fn seed_workspace_cache_state(
    cache: &WorkspaceImageCache,
    paths: &RunnerPaths,
    reuse_key: &str,
    profile_name: &str,
    image_size_bytes: u64,
) {
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name,
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(image_size_bytes).await.unwrap();
    drop(file);
    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                TEST_LAST_COMPLETED_AT.into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
}

pub(in super::super) struct TestParkedIdleCandidateSpec<'a> {
    pub(in super::super) reuse_key: &'a str,
    pub(in super::super) profile_name: &'a str,
    pub(in super::super) vcpu: u32,
    pub(in super::super) memory_mb: u32,
    pub(in super::super) history_generation_run_id: Option<RunId>,
    pub(in super::super) parked_at: std::time::Instant,
}

pub(in super::super) async fn seed_idle_pool_with_timing(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    spec: TestParkedIdleCandidateSpec<'_>,
) {
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, spec.vcpu, spec.memory_mb).unwrap();
    let builder = ParkedIdleCandidateBuilder::new(spec.reuse_key, budget_lease)
        .with_profile_name(spec.profile_name);
    let candidate = match spec.history_generation_run_id {
        Some(run_id) => builder.with_history_generation_run_id(run_id).build(),
        None => builder.build(),
    };
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(candidate, spec.parked_at);
    assert!(matches!(result, ParkResult::Parked));
}
