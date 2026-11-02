use super::*;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use guest_contracts::reuse_preparation::{FilesystemCapacity, ReusePreparationReport};
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sandbox::{ExecResult, SandboxFactory, SandboxId};
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides};
use sha2::{Digest, Sha256};
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use crate::idle_lifecycle::SharedIdlePool;
use crate::job_lifecycle::{ActiveBudgetLease, RunCleanupDisposition, RunCleanupState};
use runner_host::paths::RunnerPaths;
use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::home_image_cache::{
    HomeImageCache, HomeImageLeaseIdentity, HomeImagePrepareRequest, HomeImagePromotionContext,
    HomeImagePromotionIdentityRequest, HomeImagePromotionRequest,
};
use runner_lifecycle::home_promotion::test_support::{
    add_healthy_cache_preparation_matcher,
    mock_sandbox_ready_for_cache_preparation as cache_sandbox,
};
use runner_lifecycle::idle_pool::{
    IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult, ParkingGate,
    RestoreReservedIdleResult, test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::idle_reuse_preparation::{
    add_healthy_reuse_preparation_matcher, mock_sandbox_ready_for_idle_reuse,
};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::restored_session_identity::RestoredSessionIdentity;
use runner_lifecycle::status::StatusTracker;
use runner_network::network_log_drain::NetworkLogDrainCoordinator;
use runner_network::network_log_manager::NetworkLogManager;
use runner_storage::storage_fingerprints::StorageFingerprint;
use runner_storage::storage_plan::build_storage_plan;
use runner_types::ids::RunId;
use runner_types::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};
use runner_types::types::SandboxReuseResult;

fn observe_finalization_events() -> (
    FinalizationTestHooks,
    tokio::sync::mpsc::UnboundedReceiver<FinalizationTestEvent>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let hooks = FinalizationTestHooks {
        on_event: Some(Arc::new(move |event| {
            tx.send(event)
                .expect("finalization observer should remain active");
        })),
    };
    (hooks, rx)
}

async fn wait_for_finalization_event(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<FinalizationTestEvent>,
    expected: impl Fn(&FinalizationTestEvent) -> bool,
    timeout: Duration,
) -> FinalizationTestEvent {
    tokio::time::timeout(timeout, async {
        loop {
            let event = events
                .recv()
                .await
                .expect("finalization event channel closed");
            if expected(&event) {
                return event;
            }
        }
    })
    .await
    .expect("finalization event did not arrive")
}

fn test_active_runs() -> ActiveRuns {
    ActiveRuns::new(Arc::new(tokio::sync::Notify::new()))
}

async fn prepare_and_publish_home_image(
    sandbox: &dyn Sandbox,
    promotion: HomeImagePromotionContext,
) -> bool {
    prepare_home_image_from_active_sandbox(sandbox, Some(promotion), "test")
        .await
        .expect("home promotion should prepare")
        .publish()
        .await
}

fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    (budget, lease)
}

async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    assert_eq!(
        event.fields.get(field).map(String::as_str),
        Some(expected),
        "unexpected {field}; event={event:#?}"
    );
}

fn severe_memory_retention_diagnostics() -> sandbox::SevereMemoryRetentionDiagnostics {
    sandbox::SevereMemoryRetentionDiagnostics {
        requested_target_mib: 3584,
        first_observed_target_mib: Some(3584),
        observed_target_mib: Some(3584),
        target_observed: true,
        first_actual_mib: Some(2074),
        previous_actual_mib: Some(2300),
        actual_mib: Some(2448),
        max_actual_mib: Some(2448),
        deficit_mib: Some(1136),
        actual_delta_mib: Some(374),
        elapsed_ms: 5001,
        sample_count: 9,
        reported_free_memory_bytes: Some(8 * 1024 * 1024),
        reported_available_memory_bytes: Some(9 * 1024 * 1024),
        reported_total_memory_bytes: Some(4_i64 * 1024 * 1024 * 1024),
        reported_swap_in_bytes: Some(11),
        reported_swap_out_bytes: Some(12),
        reported_major_faults: Some(13),
        reported_minor_faults: Some(14),
        reported_disk_caches_bytes: Some(15),
        progress_extension_blocker: Some("fresh_guest_available_reserve_insufficient"),
        guest_memory_snapshot_attempted: true,
        guest_memory_snapshot: Some(sandbox::GuestMemorySnapshot {
            mem_total_bytes: 101,
            mem_free_bytes: 102,
            mem_available_bytes: 103,
            buffers_bytes: 104,
            cached_bytes: 105,
            anon_pages_bytes: 106,
            mapped_bytes: 107,
            dirty_bytes: 108,
            writeback_bytes: 109,
            shmem_bytes: 110,
            slab_bytes: 111,
            slab_reclaimable_bytes: 112,
            slab_unreclaimable_bytes: 113,
            unevictable_bytes: 114,
            kernel_stack_bytes: 115,
            page_tables_bytes: 116,
            swap_total_bytes: 117,
            swap_free_bytes: 118,
        }),
    }
}

struct FinalizeTestFixture {
    dir: tempfile::TempDir,
    status: Arc<StatusTracker>,
    parking_gate: ParkingGate,
    idle_pool: SharedIdlePool,
    network_log_manager: NetworkLogManager,
}

impl FinalizeTestFixture {
    async fn new() -> Self {
        Self::new_with_max_idle(10).await
    }

    async fn new_with_max_idle(max_idle: usize) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let status = Arc::new(StatusTracker::new(
            dir.path().join("status.json"),
            4,
            None,
            None,
        ));
        status.write_initial().await.unwrap();
        let parking_gate = ParkingGate::new_open();
        let idle_pool: SharedIdlePool = Arc::new(tokio::sync::Mutex::new(
            IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle }, parking_gate.clone()),
        ));
        let network_log_manager = NetworkLogManager::new();

        Self {
            dir,
            status,
            parking_gate,
            idle_pool,
            network_log_manager,
        }
    }

    async fn network_log_session(&self) -> NetworkLogSession {
        self.network_log_manager
            .register_source_ip("10.0.0.1", self.dir.path().join("network.jsonl"))
            .await
    }

    fn finalize_context(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        session_id: &str,
        network_log_session: NetworkLogSession,
        cancel: RunCancellationHandle,
    ) -> FinalizeContext {
        FinalizeContext {
            run_id,
            sandbox_id,
            runner_id: "runner-test".into(),
            reuse_result: SandboxReuseResult::PoolMiss,
            profile_name: "vm0/default".into(),
            rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            reuse_key: Some(session_id.into()),
            cli_agent_session_id: Some(session_id.into()),
            discovered_cli_agent_session_id: None,
            restored_session_identity: None,
            source_ip: "10.0.0.1".into(),
            network_log_session: Some(network_log_session),
            home_image: None,
            home_image_size_bytes: 0,
            storage_fingerprints:
                runner_storage::storage_fingerprints::StorageFingerprints::default(),
            device_rate_limits: None,
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            idle_pool: Arc::clone(&self.idle_pool),
            idle_destroy_tracker: IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new())),
            status: Arc::clone(&self.status),
            reuse_state_notify: Arc::new(tokio::sync::Notify::new()),
            active_run_reuse: ActiveRunReusePublisher::detached(),
            home_cache_snapshot: HomeCacheStateSnapshot::new(),
            parking_gate: self.parking_gate.clone(),
            network_log_drain: NetworkLogDrainCoordinator::noop(),
            exit_code: 0,
            sandbox_reuse_disposition: SandboxReuseDisposition::Eligible(
                SandboxReuseTerminal::Success,
            ),
            cancel,
            cleanup_state: RunCleanupState::new(),
        }
    }
}

const TEST_HOME_IMAGE_SIZE: usize = 1024 * 1024;

fn test_home_image(marker: &[u8]) -> Vec<u8> {
    assert!(marker.len() <= TEST_HOME_IMAGE_SIZE);
    let mut image = vec![0; TEST_HOME_IMAGE_SIZE];
    image[..marker.len()].copy_from_slice(marker);
    image
}

async fn prepare_test_home_image_lease(
    paths: &RunnerPaths,
    cache: &HomeImageCache,
    run_id: RunId,
    sandbox_id: SandboxId,
    reuse_key: &str,
) -> HomeImageLease {
    let mut lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    let drive = lease.home_drive_config().await.unwrap().unwrap();
    match drive.seed_image {
        Some(sandbox::HomeDriveSeedImage::Move(source)) => {
            tokio::fs::rename(source, paths.active_home_image(&sandbox_id))
                .await
                .unwrap();
        }
        Some(sandbox::HomeDriveSeedImage::Copy(_)) => panic!("checkout must use Move"),
        None => {
            tokio::fs::write(
                paths.active_home_image(&sandbox_id),
                test_home_image(b"image"),
            )
            .await
            .unwrap();
        }
    }
    lease
}

fn test_verified_restored_session_identity(
    framework: SessionHistoryFramework,
    session_id: &str,
    history: &[u8],
) -> RestoredSessionIdentity {
    let history_source = match framework {
        SessionHistoryFramework::ClaudeCode => SessionHistorySourceRef::ClaudeCode {
            config_dir: "/home/user/.claude".to_string(),
            working_dir: CANONICAL_WORKING_DIR.to_string(),
            session_id: session_id.to_string(),
        },
        SessionHistoryFramework::Codex => SessionHistorySourceRef::Codex {
            sessions_dir: "/home/user/.codex/sessions".to_string(),
            thread_id: session_id.to_string(),
        },
        SessionHistoryFramework::Pi => SessionHistorySourceRef::Pi {
            session_path: format!(
                "{}/restored-{session_id}.jsonl",
                api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
            ),
            session_id: session_id.to_string(),
        },
    };
    let metadata = SessionHistoryIdentity::new(
        framework,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        history_source,
    )
    .unwrap();
    RestoredSessionIdentity::from_final_metadata(
        metadata,
        "/home/user/.vm0/guest-agent/runs/run-b/final-session-history-identity.json",
        "/home/user/.vm0/guest-agent/runs/run-b",
    )
    .unwrap()
}

async fn home_seed_path(lease: &mut HomeImageLease) -> std::path::PathBuf {
    let drive = lease
        .home_drive_config()
        .await
        .unwrap()
        .expect("home drive configured");
    match drive.seed_image.expect("cache hit has a pinned seed") {
        sandbox::HomeDriveSeedImage::Move(path) | sandbox::HomeDriveSeedImage::Copy(path) => path,
    }
}

async fn seed_home_cache_image(
    paths: &RunnerPaths,
    cache: &HomeImageCache,
    reuse_key: &str,
    image: &[u8],
) {
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: image.len() as u64,
            },
            home_drive_required: true,
        })
        .await;
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(active_image, image).await.unwrap();
    assert!(
        lease
            .promote(
                run_id,
                HomeCacheTerminalStatus::Success,
                "2026-07-31T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
}

fn test_promotion_context(
    lease: HomeImageLease,
    run_id: RunId,
    sandbox_id: SandboxId,
    terminal_status: HomeCacheTerminalStatus,
    storage_fingerprints: runner_storage::storage_fingerprints::StorageFingerprints,
) -> HomeImagePromotionContext {
    lease
        .into_promotion_context(HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status,
            completed_at: local_completed_at(),
            storage_fingerprints,
        })
        .expect("test home image should be promotable")
}

async fn sandbox_with_overrides(
    sandbox_id: SandboxId,
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
) -> (Arc<Box<dyn SandboxFactory>>, Box<dyn Sandbox>) {
    add_healthy_cache_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> =
        Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
        .expect("create sandbox with overrides");
    (factory, sandbox)
}

#[tokio::test]
async fn finalizer_closes_network_log_session_before_parking() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-network-log-park",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.guest_timezone_intent = GuestTimezoneIntent::Configured("Asia/Shanghai".into());

    let _finalization_ready = finalize_sandbox_for_completion(
        Some(Box::new(mock_sandbox_ready_for_idle_reuse(
            "network-log-park",
        ))),
        ActiveBudgetLease::new(lease),
        context,
    )
    .await;

    {
        let mut idle_pool = fixture.idle_pool.lock().await;
        let reservation = idle_pool
            .reserve_reusable_source("sess-network-log-park", "vm0/default", &None, run_id)
            .expect("finalized sandbox should be reusable for its generation");
        assert_eq!(
            reservation.guest_timezone_intent(),
            &GuestTimezoneIntent::Configured("Asia/Shanghai".into())
        );
        assert!(matches!(
            idle_pool.restore_reserved(reservation),
            RestoreReservedIdleResult::Restored
        ));
    }
    assert!(
        !fixture
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"after-park.test"})
            )
            .await,
        "parked sandbox must not retain the previous run's network-log attribution",
    );
}

#[tokio::test]
async fn finalizer_emits_joined_severe_memory_retention_warning() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let report = ReusePreparationReport {
        before: FilesystemCapacity {
            available_bytes: 256 * 1024 * 1024,
            available_inodes: 2048,
        },
        after: FilesystemCapacity {
            available_bytes: 384 * 1024 * 1024,
            available_inodes: 4096,
        },
        removed_entries: 7,
        home: runner_lifecycle::idle_reuse_preparation::healthy_reuse_preparation_report().home,
    };
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".into(),
        exit_code: 0,
        stdout: serde_json::to_vec(&report).unwrap(),
        stderr: Vec::new(),
    });
    overrides.push_park_result(Ok(sandbox::SandboxParkOutcome::NonReusable(
        sandbox::SandboxParkNonReusableReason::SevereMemoryRetention(Box::new(
            severe_memory_retention_diagnostics(),
        )),
    )));
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "thread:severe-memory-warning",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.factory = factory;
    context.runner_id = "runner-attribution-test".into();
    context.reuse_result = SandboxReuseResult::Reused;

    let (_finalization_ready, events) = capture_async_log_events(finalize_sandbox_for_completion(
        Some(sandbox),
        ActiveBudgetLease::new(lease),
        context,
    ))
    .await;

    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    let matching_events: Vec<_> = events
        .iter()
        .filter(|event| {
            event.fields.get("message").is_some_and(|message| {
                message == "sandbox parked with severe memory retention, destroying sandbox"
            })
        })
        .collect();
    assert_eq!(matching_events.len(), 1, "captured={events:#?}");
    let event = captured_event(
        &events,
        "sandbox parked with severe memory retention, destroying sandbox",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "run_id", &run_id.to_string());
    assert_event_field(event, "sandbox_id", &sandbox_id.to_string());
    assert_event_field(event, "runner_id", "runner-attribution-test");
    assert_event_field(event, "runner_version", env!("CARGO_PKG_VERSION"));
    assert_event_field(event, "profile_name", "vm0/default");
    assert_event_field(event, "reuse_key_kind", "thread");
    assert_event_field(event, "sandbox_reuse_result", "reused");
    assert_event_field(event, "reuse_preparation_ready", "true");
    assert_event_field(event, "containment_ready", "true");
    assert_event_field(event, "reuse_preparation_removed_entries", "7");
    assert_event_field(
        event,
        "reuse_preparation_before_available_bytes",
        "268435456",
    );
    assert_event_field(
        event,
        "reuse_preparation_after_available_bytes",
        "402653184",
    );
    assert_event_field(event, "requested_target_mib", "3584");
    assert_event_field(event, "first_actual_mib", "2074");
    assert_event_field(event, "previous_actual_mib", "2300");
    assert_event_field(event, "actual_mib", "2448");
    assert_event_field(event, "deficit_mib", "1136");
    assert_event_field(
        event,
        "progress_extension_blocker",
        "fresh_guest_available_reserve_insufficient",
    );
    assert_event_field(event, "guest_memory_snapshot_attempted", "true");
    assert_event_field(event, "reported_swap_in_bytes", "11");
    assert_event_field(event, "reported_disk_caches_bytes", "15");
    assert_event_field(event, "guest_memory_snapshot_available", "true");
    for (field, value) in [
        ("guest_mem_total_bytes", 101),
        ("guest_mem_free_bytes", 102),
        ("guest_mem_available_bytes", 103),
        ("guest_buffers_bytes", 104),
        ("guest_cached_bytes", 105),
        ("guest_anon_pages_bytes", 106),
        ("guest_mapped_bytes", 107),
        ("guest_dirty_bytes", 108),
        ("guest_writeback_bytes", 109),
        ("guest_shmem_bytes", 110),
        ("guest_slab_bytes", 111),
        ("guest_slab_reclaimable_bytes", 112),
        ("guest_slab_unreclaimable_bytes", 113),
        ("guest_unevictable_bytes", 114),
        ("guest_kernel_stack_bytes", 115),
        ("guest_page_tables_bytes", 116),
        ("guest_swap_total_bytes", 117),
        ("guest_swap_free_bytes", 118),
    ] {
        assert_event_field(event, field, &value.to_string());
    }
    assert_eq!(event.field_kinds.get("first_actual_mib"), Some(&"u64"));
    assert_eq!(
        event.field_kinds.get("reported_swap_in_bytes"),
        Some(&"i64")
    );
    assert_eq!(event.field_kinds.get("guest_mem_total_bytes"), Some(&"u64"));
    assert_event_field(event, "reason", "severe_memory_retention");
    assert_event_field(event, "admission_action", "reject_and_destroy");
}

#[tokio::test]
async fn finalizer_preserves_success_when_reuse_preparation_rejects_guest() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cleanup_state = RunCleanupState::new();
    let workspace_dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(workspace_dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let home_image =
        prepare_test_home_image_lease(&paths, &cache, run_id, sandbox_id, "thread:reuse-rejected")
            .await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".into(),
        exit_code: 0,
        stdout: serde_json::to_vec(&ReusePreparationReport {
            before: FilesystemCapacity {
                available_bytes: 64 * 1024 * 1024,
                available_inodes: 4096,
            },
            after: FilesystemCapacity {
                available_bytes: 64 * 1024 * 1024,
                available_inodes: 4096,
            },
            removed_entries: 0,
            home: runner_lifecycle::idle_reuse_preparation::healthy_reuse_preparation_report().home,
        })
        .unwrap(),
        stderr: Vec::new(),
    });
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "thread:reuse-rejected",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.factory = factory;
    context.cleanup_state = cleanup_state.clone();
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;

    let (_finalization_ready, events) = capture_async_log_events(finalize_sandbox_for_completion(
        Some(sandbox),
        ActiveBudgetLease::new(lease),
        context,
    ))
    .await;

    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    let cache_states = cache.held_home_states().await;
    assert_eq!(cache_states.len(), 1);
    assert_eq!(cache_states[0].reuse_key, "thread:reuse-rejected");
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::DestroyCompleted
    );
    let capacity_event = captured_event(&events, "sandbox rejected from idle reuse");
    assert_eq!(capacity_event.level, Level::INFO);
    assert_event_field(capacity_event, "reason", "low_bytes");
    let lifecycle_event = captured_event(
        &events,
        "parked sandbox rejected by idle capacity admission, destroying instead of reusing",
    );
    assert_eq!(lifecycle_event.level, Level::INFO);
}

#[tokio::test]
async fn finalizer_parking_observer_uses_reuse_key() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = "thread:finalizer-17975";
    let (hooks, mut events) = observe_finalization_events();
    let context = fixture.finalize_context(
        run_id,
        sandbox_id,
        reuse_key,
        network_log_session,
        RunCancellationHandle::new(),
    );
    let _finalization_ready = finalize_sandbox_for_completion_observed(
        Some(Box::new(mock_sandbox_ready_for_idle_reuse(
            "finalizer-redaction",
        ))),
        ActiveBudgetLease::new(lease),
        context,
        hooks,
    )
    .await;
    let event = wait_for_finalization_event(
            &mut events,
            |event| matches!(event, FinalizationTestEvent::SandboxParkedForReuse { run_id: observed, .. } if *observed == run_id),
            Duration::from_secs(1),
        )
        .await;
    assert_eq!(
        event,
        FinalizationTestEvent::SandboxParkedForReuse {
            run_id,
            reuse_key: reuse_key.into(),
        }
    );
}

#[tokio::test]
async fn finalizer_keeps_idle_pool_ownership_when_cancelled_after_transfer() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cancel = RunCancellationHandle::new();
    let cleanup_state = RunCleanupState::new();
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-cancel-after-transfer",
        network_log_session,
        cancel.clone(),
    );
    context.cleanup_state = cleanup_state.clone();

    let _finalization_ready = finalize_sandbox_for_completion(
        Some(Box::new(mock_sandbox_ready_for_idle_reuse(
            "cancel-after-transfer",
        ))),
        ActiveBudgetLease::new(lease),
        context,
    )
    .await;

    assert_eq!(fixture.idle_pool.lock().await.len(), 1);
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::IdlePoolOwned,
    );

    assert!(cancel.request_hard_cancellation().await);

    assert_eq!(
        fixture.idle_pool.lock().await.len(),
        1,
        "late cancellation must not undo idle-pool ownership",
    );
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::IdlePoolOwned,
    );
}

#[tokio::test]
async fn home_promotion_freezes_and_promotes_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease =
        prepare_test_home_image_lease(&paths, &cache, run_id, sandbox_id, "sess-promote").await;
    let sandbox = cache_sandbox("home-promotion");
    let promotion = test_promotion_context(
        lease,
        run_id,
        sandbox_id,
        HomeCacheTerminalStatus::Success,
        runner_storage::storage_fingerprints::StorageFingerprints::default(),
    );

    let promoted = prepare_and_publish_home_image(&sandbox, promotion).await;

    assert!(promoted);
    let states = cache.held_home_states().await;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, "sess-promote");
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 2);
    assert!(exec_calls[0].cmd.contains("prepare-for-cache"));
    assert!(exec_calls[0].sudo);
    assert!(
        exec_calls[1]
            .cmd
            .contains("\"$home_fsfreeze_path\" --freeze")
    );
}

#[tokio::test]
async fn non_success_home_promotion_preserves_affected_paths_across_cache_sources() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());

    for (terminal_name, terminal_status) in [
        ("nonzero", HomeCacheTerminalStatus::NonzeroExit),
        ("cancelled", HomeCacheTerminalStatus::Cancelled),
    ] {
        for (source_name, publish_seed) in [("cache-hit", true), ("idle-reuse", false)] {
            let session_id = format!("sess-{terminal_name}-{source_name}");
            // Persisted input scope is fixed home, not cwd: both previous and current
            // storage mounts here deliberately live outside /home/user/workspace.
            let removed_storage_path = "/home/user/.npm/removed-storage".to_owned();
            let removed_artifact_path = format!("{CANONICAL_WORKING_DIR}/removed-artifact");
            let current_storage_path = "/home/user/current-storage".to_owned();
            let current_artifact_path = format!("{CANONICAL_WORKING_DIR}/current-artifact");
            let previous_storage = StorageFingerprints {
                storages: HashMap::from([(
                    removed_storage_path.clone(),
                    StorageFingerprint::new("removed-storage", "v1"),
                )]),
                artifacts: HashMap::from([(
                    removed_artifact_path.clone(),
                    StorageFingerprint::new("removed-artifact", "v1"),
                )]),
            };

            let seed_run_id = RunId::new_v4();
            let seed_sandbox_id = SandboxId::new_v4();
            let seed_lease = prepare_test_home_image_lease(
                &paths,
                &cache,
                seed_run_id,
                seed_sandbox_id,
                &session_id,
            )
            .await;
            let seed_promotion = test_promotion_context(
                seed_lease,
                seed_run_id,
                seed_sandbox_id,
                HomeCacheTerminalStatus::Success,
                previous_storage.clone(),
            );

            let run_id = RunId::new_v4();
            let (sandbox_id, lease) = if publish_seed {
                assert!(
                    prepare_and_publish_home_image(
                        &cache_sandbox(format!("home-seed-{session_id}")),
                        seed_promotion,
                    )
                    .await
                );
                let sandbox_id = SandboxId::new_v4();
                let lease =
                    prepare_test_home_image_lease(&paths, &cache, run_id, sandbox_id, &session_id)
                        .await;
                assert!(lease.is_cache_hit());
                (sandbox_id, lease)
            } else {
                let expected = cache
                        .expected_promotion_identity(HomeImagePromotionIdentityRequest {
                            working_dir: CANONICAL_WORKING_DIR,
                            sandbox_id: seed_sandbox_id,
                            profile_name: "vm0/default",
                            reuse_key: &session_id,
                            rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
                        })
                        .expect("idle reuse promotion identity should be valid");
                let lease = seed_promotion
                    .try_into_active_lease(&expected, true)
                    .expect("parked promotion should become an active lease");
                (seed_sandbox_id, lease)
            };
            assert_eq!(lease.previous_storage(), Some(&previous_storage));

            let sandbox = cache_sandbox(format!("home-promotion-{session_id}"));
            let current_manifest = StorageManifest {
                storages: vec![StorageEntry {
                    name: "current-storage".into(),
                    mount_path: current_storage_path.clone(),
                    vas_storage_name: "current-storage".into(),
                    vas_version_id: "v1".into(),
                    archive_url: "https://example.com/current-storage.tar.gz".into(),
                    archive_size: None,
                }],
                artifacts: vec![ArtifactEntry {
                    mount_path: current_artifact_path.clone(),
                    vas_storage_name: "current-artifact".into(),
                    vas_storage_id: "current-artifact-id".into(),
                    vas_version_id: "v1".into(),
                    archive_url: Some("https://example.com/current-artifact.tar.gz".into()),
                    empty: None,
                    missing_root_policy: None,
                    archive_size: None,
                }],
            };
            let promotion = test_promotion_context(
                lease,
                run_id,
                sandbox_id,
                terminal_status,
                StorageFingerprints::from_manifest(&current_manifest),
            );

            let promoted = prepare_and_publish_home_image(&sandbox, promotion).await;

            assert!(promoted);
            let exec_calls = sandbox.exec_calls();
            assert_eq!(exec_calls.len(), 2);
            assert!(exec_calls[0].cmd.contains("prepare-for-cache"));
            assert!(
                exec_calls[1]
                    .cmd
                    .contains("\"$home_fsfreeze_path\" --freeze")
            );
            let checkout = cache
                    .prepare(HomeImagePrepareRequest {
                        identity: HomeImageLeaseIdentity {
                            working_dir: CANONICAL_WORKING_DIR,
                            run_id: RunId::new_v4(),
                            sandbox_id: SandboxId::new_v4(),
                            profile_name: "vm0/default",
                            reuse_key: Some(&session_id),
                            rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
                        },
                        home_drive_required: true,
                    })
                    .await;

            assert!(checkout.is_cache_hit());
            let previous_storage = checkout
                .previous_storage()
                .expect("cache hit should expose previous storage fingerprints");
            for path in [&removed_storage_path, &current_storage_path] {
                assert!(
                    previous_storage
                        .storages
                        .get(path)
                        .is_some_and(StorageFingerprint::is_tainted),
                    "storage path should be retained as tainted: {path}",
                );
            }
            for path in [&removed_artifact_path, &current_artifact_path] {
                assert!(
                    previous_storage
                        .artifacts
                        .get(path)
                        .is_some_and(StorageFingerprint::is_tainted),
                    "artifact path should be retained as tainted: {path}",
                );
            }

            let plan = build_storage_plan(&current_manifest, Some(previous_storage))
                .expect("next storage plan should build from promoted fingerprints");
            assert_eq!(plan.reused_entries(), 0);
            let guest_manifest = plan.into_guest_manifest();
            assert!(!guest_manifest.storages[0].cached);
            assert!(!guest_manifest.artifacts[0].cached);
            assert_eq!(
                guest_manifest
                    .cleanup_paths
                    .into_iter()
                    .collect::<HashSet<_>>(),
                HashSet::from([
                    removed_storage_path,
                    removed_artifact_path,
                    current_storage_path,
                    current_artifact_path,
                ])
            );
        }
    }
}

#[tokio::test]
async fn home_promotion_skips_cache_when_guest_freeze_fails() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease =
        prepare_test_home_image_lease(&paths, &cache, run_id, sandbox_id, "sess-failed").await;
    let sandbox = cache_sandbox("home-promotion-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(64, Vec::new(), b"not mounted".to_vec())));
    let promotion = test_promotion_context(
        lease,
        run_id,
        sandbox_id,
        HomeCacheTerminalStatus::Success,
        runner_storage::storage_fingerprints::StorageFingerprints::default(),
    );

    let prepared = prepare_home_image_from_active_sandbox(&sandbox, Some(promotion), "test").await;

    assert!(prepared.is_none());
    assert!(
        cache.held_home_states().await.is_empty(),
        "freeze failure must not advertise an inconsistent home image"
    );
    assert_eq!(sandbox.exec_calls().len(), 2);
}

#[tokio::test]
async fn finalizer_parks_home_cache_promotion_without_publishing_cache() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some("unused-context-session"),
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(
        paths.active_home_image(&sandbox_id),
        test_home_image(b"image"),
    )
    .await
    .unwrap();
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "unused-context-session",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.cli_agent_session_id = None;
    context.discovered_cli_agent_session_id = Some("sess-guest".into());
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;

    let http = runner_provider::http::HttpClient::new(runner_provider::http::HttpClientConfig {
        api_url: "http://localhost".into(),
        vercel_bypass: None,
        client_session_id: "retained-home-test".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let mut telemetry = JobTelemetry::new(http, run_id, String::new(), None);
    let _finalization_ready = finalize_sandbox_for_completion_with_telemetry(
        Some(Box::new(mock_sandbox_ready_for_idle_reuse(
            "guest-session-promotion",
        ))),
        ActiveBudgetLease::new(lease),
        &mut telemetry,
        context,
    )
    .await;

    let idle_states = fixture.idle_pool.lock().await.held_sandbox_states();
    assert_eq!(idle_states.len(), 1);
    assert_eq!(idle_states[0].reuse_key, "unused-context-session");
    let cache_states = cache.held_home_states().await;
    assert!(
        cache_states.is_empty(),
        "parked sandboxes keep the live home mounted and must not publish a separate cache image"
    );
    let facts = telemetry.pending_home_snapshot();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].kind, HomeObservationKind::Preservation);
    assert_eq!(facts[0].outcome, HomeObservationOutcome::Retained);
    assert_eq!(facts[0].run_id, Some(run_id));
    assert_eq!(
        facts[0].reuse_key.as_deref(),
        Some("unused-context-session")
    );
    assert_eq!(facts[0].reason.as_deref(), Some("idle_pool"));
    assert!(facts[0].image_generation.is_none());
}

#[tokio::test]
async fn finalizer_rejects_mismatched_home_promotion_before_parking() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some("sess-mismatch"),
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(
        paths.active_home_image(&sandbox_id),
        test_home_image(b"image"),
    )
    .await
    .unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-mismatch",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.factory = factory;
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64 + 1;

    let _finalization_ready =
        finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
            .await;

    assert_eq!(
        overrides.park_call_count(),
        0,
        "mismatched promotion should be rejected before sandbox park"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    assert!(
        cache.held_home_states().await.is_empty(),
        "mismatched park-time promotion must not publish home cache"
    );
}

#[tokio::test]
async fn finalizer_republishes_failed_sessionless_home_hit_without_inventing_history_proof() {
    assert_finalizer_republishes_sessionless_home_hit(false).await;
}

#[tokio::test]
async fn finalizer_republishes_hard_cancelled_sessionless_home_hit_without_inventing_history_proof()
{
    assert_finalizer_republishes_sessionless_home_hit(true).await;
}

async fn assert_finalizer_republishes_sessionless_home_hit(cancelled: bool) {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let reuse_key = "thread:rotating-provider";
    // Opaque image bytes model ordinary home + cwd state, not a second history body slot.
    let home_bytes = test_home_image(
        b"workspace/cache-marker\nhome-marker\n.npm/cache-marker\nclaude-session-a\n",
    );
    seed_home_cache_image(&paths, &cache, reuse_key, &home_bytes).await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let mut home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: home_bytes.len() as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert!(home_image.is_cache_hit());
    assert!(home_image.history_proof_binding().is_none());
    let seed = home_seed_path(&mut home_image).await;
    assert_eq!(tokio::fs::read(&seed).await.unwrap(), home_bytes);
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::rename(seed, &active_image).await.unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let cancel = RunCancellationHandle::new();
    if cancelled {
        assert!(cancel.request_hard_cancellation().await);
    }
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "unused-context-session",
        network_log_session,
        cancel,
    );
    context.factory = factory;
    context.reuse_key = Some(reuse_key.into());
    context.cli_agent_session_id = None;
    context.discovered_cli_agent_session_id = None;
    context.restored_session_identity = None;
    context.exit_code = 1;
    context.sandbox_reuse_disposition = if cancelled {
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::CooperativeCancellation)
    } else {
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
    };
    if !cancelled {
        assert!(context.parking_gate.soft_drain());
    }
    context.home_image = Some(home_image);
    context.home_image_size_bytes = home_bytes.len() as u64;
    let _ready =
        finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
            .await;
    assert_eq!(overrides.park_call_count(), 0);
    assert_eq!(overrides.stop_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(cache.held_home_states().await[0].reuse_key, reuse_key);
    let mut checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: home_bytes.len() as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert!(checkout.is_cache_hit());
    assert_eq!(
        tokio::fs::read(home_seed_path(&mut checkout).await)
            .await
            .unwrap(),
        home_bytes
    );
    // Image reuse and history authority are distinct: no finalized eligible proof means
    // the restore-plan owner must use the authoritative remote history path.
    assert!(checkout.history_proof_binding().is_none());
}

#[tokio::test]
async fn finalizer_rotating_source_preserves_current_image_without_inheriting_history_authority() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let reuse_key = "thread:provider-rotation";
    let previous_home = test_home_image(b"ordinary-home-state\nclaude-a\n");
    let next_home = test_home_image(b"ordinary-home-state\ncodex--b\n");
    assert_eq!(previous_home.len(), next_home.len());
    seed_home_cache_image(&paths, &cache, reuse_key, &previous_home).await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let mut home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: previous_home.len() as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert!(home_image.is_cache_hit());
    assert_eq!(
        tokio::fs::read(home_seed_path(&mut home_image).await)
            .await
            .unwrap(),
        previous_home
    );
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::rename(home_seed_path(&mut home_image).await, &active_image)
        .await
        .unwrap();
    tokio::fs::write(&active_image, &next_home).await.unwrap();
    let next_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let next_identity = test_verified_restored_session_identity(
        SessionHistoryFramework::Codex,
        next_session_id,
        b"codex-b",
    );
    let sandbox = cache_sandbox(sandbox_id.to_string());
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "unused-context-session",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.reuse_key = Some(reuse_key.into());
    context.cli_agent_session_id = None;
    context.discovered_cli_agent_session_id = Some(next_session_id.into());
    context.restored_session_identity = Some(next_identity);
    context.home_image = Some(home_image);
    context.home_image_size_bytes = next_home.len() as u64;
    context.parking_gate.close();
    let _ready = finalize_sandbox_for_completion(
        Some(Box::new(sandbox)),
        ActiveBudgetLease::new(lease),
        context,
    )
    .await;
    let mut checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: next_home.len() as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert!(checkout.is_cache_hit());
    assert_eq!(
        tokio::fs::read(home_seed_path(&mut checkout).await)
            .await
            .unwrap(),
        next_home
    );
    // Final identity alone is not a terminal source/live-byte proof. The fixture returns
    // cleanup-only evidence; it cannot authorize skipping remote restoration.
    assert!(checkout.history_proof_binding().is_none());
}

#[tokio::test]
async fn finalizer_promotes_home_cache_from_reuse_key_without_resolved_session() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = "thread:lease-only";
    let home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(
        paths.active_home_image(&sandbox_id),
        test_home_image(b"image"),
    )
    .await
    .unwrap();
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "unused-context-session",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.cli_agent_session_id = None;
    context.discovered_cli_agent_session_id = None;
    context.exit_code = 1;
    context.sandbox_reuse_disposition =
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit);
    assert!(context.parking_gate.soft_drain());
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;
    let home_cache_snapshot = context.home_cache_snapshot.clone();

    let _finalization_ready = finalize_sandbox_for_completion(
        Some(Box::new(cache_sandbox("reuse-key-promotion"))),
        ActiveBudgetLease::new(lease),
        context,
    )
    .await;

    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    let cache_states = cache.held_home_states().await;
    assert_eq!(cache_states.len(), 1);
    assert_eq!(cache_states[0].reuse_key, reuse_key);
    let active_runs = test_active_runs();
    let snapshot_states = home_cache_snapshot.current_held_home_states(&active_runs, None);
    assert_eq!(snapshot_states.len(), 1);
    assert_eq!(snapshot_states[0].reuse_key, reuse_key);
    assert_eq!(snapshot_states[0].home_caches.len(), 1);
    assert_eq!(snapshot_states[0].home_caches[0].profile, "vm0/default");
}

#[tokio::test]
async fn finalizer_promotes_failed_first_run_home_without_session() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = "thread:first-run-failure";
    let home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(
        home_image.result(),
        runner_lifecycle::home_image_cache::HomeCacheCheckoutResult::Miss
    );
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(
        paths.active_home_image(&sandbox_id),
        test_home_image(b"image"),
    )
    .await
    .unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "unused-context-session",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.factory = factory;
    context.reuse_key = Some(reuse_key.into());
    context.cli_agent_session_id = None;
    context.discovered_cli_agent_session_id = None;
    context.exit_code = 1;
    context.sandbox_reuse_disposition =
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit);
    assert!(context.parking_gate.soft_drain());
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;
    let home_cache_snapshot = context.home_cache_snapshot.clone();

    let _finalization_ready =
        finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
            .await;

    assert_eq!(overrides.park_call_count(), 0);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    let cache_states = cache.held_home_states().await;
    assert_eq!(cache_states.len(), 1);
    assert_eq!(cache_states[0].reuse_key, reuse_key);
    let inspection = cache.inspect().await.unwrap();
    assert_eq!(inspection.entries.len(), 1);
    assert_eq!(
        inspection.entries[0].last_terminal_status,
        Some(HomeCacheTerminalStatus::NonzeroExit)
    );
    let mut checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert!(checkout.is_cache_hit());
    assert_eq!(
        tokio::fs::read(home_seed_path(&mut checkout).await)
            .await
            .unwrap(),
        test_home_image(b"image")
    );
    assert!(
        checkout.history_proof_binding().is_none(),
        "sessionless failure cannot invent history authority"
    );
    let active_runs = test_active_runs();
    let snapshot_states = home_cache_snapshot.current_held_home_states(&active_runs, None);
    assert_eq!(snapshot_states.len(), 1);
    assert_eq!(snapshot_states[0].reuse_key, reuse_key);
    assert_eq!(snapshot_states[0].home_caches.len(), 1);
}

#[tokio::test]
async fn finalizer_waits_for_successful_stop_before_home_generation_publication() {
    let (budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = "thread:stop-before-commit";
    let home_image =
        prepare_test_home_image_lease(&paths, &cache, run_id, sandbox_id, reuse_key).await;
    let stop_gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_stop_lifecycle_gate(stop_gate.clone());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        reuse_key,
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.factory = factory;
    context.parking_gate.close();
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;
    let snapshot = context.home_cache_snapshot.clone();
    let finalization = tokio::spawn(finalize_sandbox_for_completion(
        Some(sandbox),
        ActiveBudgetLease::new(lease),
        context,
    ));
    stop_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let calls = overrides.exec_calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].cmd.contains("prepare-for-cache"));
    assert!(calls[1].cmd.contains("\"$home_fsfreeze_path\" --freeze"));
    assert_eq!(overrides.destroy_call_count(), 0);
    assert_eq!(overrides.park_call_count(), 0);
    assert_eq!(
        budget.allocated().2,
        1,
        "termination retains active ownership"
    );
    assert_eq!(
        tokio::fs::read(paths.active_home_image(&sandbox_id))
            .await
            .unwrap(),
        test_home_image(b"image")
    );
    assert!(
        cache.held_home_states().await.is_empty(),
        "freeze alone is not publication"
    );
    assert!(
        snapshot
            .current_held_home_states(&test_active_runs(), None)
            .is_empty()
    );
    stop_gate.release_one();
    let ready = finalization.await.unwrap();
    assert_eq!(overrides.stop_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(cache.held_home_states().await[0].reuse_key, reuse_key);
    let mut checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(reuse_key),
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    assert!(checkout.is_cache_hit());
    assert_eq!(
        tokio::fs::read(home_seed_path(&mut checkout).await)
            .await
            .unwrap(),
        test_home_image(b"image")
    );
    assert!(checkout.history_proof_binding().is_none());
    drop(ready);
    assert_eq!(budget.allocated().2, 0);
}

#[tokio::test]
async fn finalizer_stop_error_abandons_frozen_home_cache_before_destroy() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let session_id = "sess-active-stop-error";
    let home_image =
        prepare_test_home_image_lease(&paths, &cache, run_id, sandbox_id, session_id).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_stop_result(Err(sandbox::SandboxError::Start {
        message: "simulated active stop failure".into(),
    }));
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        session_id,
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.factory = factory;
    context.exit_code = 1;
    context.sandbox_reuse_disposition =
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit);
    assert!(context.parking_gate.soft_drain());
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;
    let home_cache_snapshot = context.home_cache_snapshot.clone();

    let _finalization_ready =
        finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
            .await;

    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 2);
    assert!(exec_calls[0].cmd.contains("prepare-for-cache"));
    assert!(
        exec_calls[1]
            .cmd
            .contains("\"$home_fsfreeze_path\" --freeze")
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(cache.held_home_states().await.is_empty());
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    let active_runs = test_active_runs();
    assert!(
        home_cache_snapshot
            .current_held_home_states(&active_runs, None)
            .is_empty(),
        "failed post-freeze stop must not advertise reusable state"
    );
}

#[tokio::test]
async fn finalizer_promotes_home_cache_when_parked_candidate_is_rejected() {
    let fixture = FinalizeTestFixture::new_with_max_idle(1).await;
    let (_existing_budget, existing_lease) = test_budget_lease();
    let existing = ParkedIdleCandidateBuilder::new("sess-existing", existing_lease)
        .with_mock_sandbox_name("existing-idle")
        .with_last_completed_at(local_completed_at())
        .build();
    assert!(matches!(
        fixture.idle_pool.lock().await.park(existing),
        ParkResult::Parked
    ));

    let (_budget, lease) = test_budget_lease();
    let network_log_session = fixture.network_log_session().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let home_image = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                working_dir: CANONICAL_WORKING_DIR,
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some("sess-new"),
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
            },
            home_drive_required: true,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(
        paths.active_home_image(&sandbox_id),
        test_home_image(b"image"),
    )
    .await
    .unwrap();
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-new",
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.home_image = Some(home_image);
    context.home_image_size_bytes = TEST_HOME_IMAGE_SIZE as u64;

    let _finalization_ready = finalize_sandbox_for_completion(
        Some(Box::new({
            let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
            add_healthy_reuse_preparation_matcher(&overrides);
            add_healthy_cache_preparation_matcher(&overrides);
            MockSandbox::with_overrides("rejected-home-promotion", overrides)
        })),
        ActiveBudgetLease::new(lease),
        context,
    )
    .await;

    let idle_states = fixture.idle_pool.lock().await.held_sandbox_states();
    assert_eq!(idle_states.len(), 1);
    assert_eq!(idle_states[0].reuse_key, "sess-existing");
    let cache_states = cache.held_home_states().await;
    assert_eq!(cache_states.len(), 1);
    assert_eq!(cache_states[0].reuse_key, "sess-new");
}

#[tokio::test]
async fn finalizer_notifies_after_replaced_idle_promotion_despite_destroy_panic() {
    let fixture = FinalizeTestFixture::new().await;
    let session_id = "sess-replaced-cache";
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());

    let old_run_id = RunId::new_v4();
    let old_sandbox_id = SandboxId::new_v4();
    let old_home_image =
        prepare_test_home_image_lease(&paths, &cache, old_run_id, old_sandbox_id, session_id).await;
    let old_promotion = test_promotion_context(
        old_home_image,
        old_run_id,
        old_sandbox_id,
        HomeCacheTerminalStatus::Success,
        runner_storage::storage_fingerprints::StorageFingerprints::default(),
    );
    let destroy_gate = MockLifecycleGate::new();
    let existing_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&existing_overrides);
    add_healthy_cache_preparation_matcher(&existing_overrides);
    existing_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    existing_overrides.push_destroy_panic("simulated replaced idle destroy panic");
    let existing_factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&existing_overrides)),
    ));
    let existing_sandbox = existing_factory
        .create(sandbox::SandboxConfig {
            id: old_sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
        .expect("create existing sandbox");
    let (_existing_budget, existing_lease) = test_budget_lease();
    let existing_candidate = IdleParkRequest::new(IdleParkRequestParts {
        run_id: old_run_id,
        source_ip: existing_sandbox.source_ip().to_owned(),
        sandbox: existing_sandbox,
        factory: existing_factory,
        reuse_key: session_id.into(),
        sandbox_id: old_sandbox_id,
        profile_name: "vm0/default".into(),
        rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        device_rate_limits: None,
        budget_lease: existing_lease,
        storage_fingerprints: runner_storage::storage_fingerprints::StorageFingerprints::default(),
        restored_session_identity: None,
        native_generation_run_id: None,
        guest_timezone_intent: GuestTimezoneIntent::Unknown,
        home_image_size_bytes: TEST_HOME_IMAGE_SIZE as u64,
        home_promotion: Some(old_promotion),
        handoff: None,
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_error();
        panic!("existing sandbox should park: {error}");
    })
    .expect_reusable()
    .with_last_completed_at(local_completed_at());
    assert!(matches!(
        fixture.idle_pool.lock().await.park(existing_candidate),
        ParkResult::Parked
    ));

    let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
    let (_budget, lease) = test_budget_lease();
    let network_log_session = fixture.network_log_session().await;
    let new_run_id = RunId::new_v4();
    let new_sandbox_id = SandboxId::new_v4();
    let mut context = fixture.finalize_context(
        new_run_id,
        new_sandbox_id,
        session_id,
        network_log_session,
        RunCancellationHandle::new(),
    );
    context.reuse_state_notify = Arc::clone(&reuse_state_notify);
    context.idle_destroy_tracker = IdleDestroyTracker::new(Arc::clone(&reuse_state_notify));
    let held_status = fixture.status.hold_state_for_test().await;

    let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
        Some(Box::new(mock_sandbox_ready_for_idle_reuse(
            "replacement-sandbox",
        ))),
        ActiveBudgetLease::new(lease),
        context,
    ));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("replaced idle destroy should reach destroy gate");
    drop(held_status);
    tokio::time::timeout(Duration::from_secs(5), reuse_state_notify.notified())
        .await
        .expect("new replacement status must publish while old cleanup remains blocked");

    destroy_gate.release_one();
    let _finalization_ready = finalize_task.await.expect("finalizer task should join");
    assert!(
        reuse_state_notify.notified().now_or_never().is_some(),
        "replaced idle home cache promotion should notify after destroy"
    );
    assert!(
        cache
            .held_home_states()
            .await
            .iter()
            .any(|state| state.reuse_key == session_id),
        "replaced idle home cache should be visible after destroy completion"
    );
}

#[tokio::test]
async fn finalizer_closes_network_log_session_before_cancel_destroy() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let cancel = RunCancellationHandle::new();
    cancel.request_hard_cancellation().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, overrides).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-network-log-cancel",
        network_log_session,
        cancel,
    );
    context.factory = factory;

    let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
        Some(sandbox),
        ActiveBudgetLease::new(lease),
        context,
    ));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("hard-cancelled active sandbox should enter destroy gate");
    assert!(
        !fixture
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"before-destroy.test"})
            )
            .await,
        "hard-cancelled active sandbox must close network-log attribution before destroy",
    );

    destroy_gate.release_one();
    let _finalization_ready = tokio::time::timeout(Duration::from_secs(5), finalize_task)
        .await
        .expect("finalizer should complete after destroy is released")
        .expect("finalizer task should join");
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
}

#[tokio::test]
async fn finalizer_flushes_accepted_network_log_writes_before_cancel_completion() {
    let (_budget, lease) = test_budget_lease();
    let mut fixture = FinalizeTestFixture::new().await;
    let write_started = Arc::new(tokio::sync::Notify::new());
    let write_release = Arc::new(tokio::sync::Semaphore::new(0));
    fixture.network_log_manager = NetworkLogManager::new_with_write_gate(
        Arc::clone(&write_started),
        Arc::clone(&write_release),
    );
    let network_log_session = fixture.network_log_session().await;
    let accepted_row = serde_json::json!({"type":"dns","host":"accepted-before-cancel.test"});
    assert!(
        fixture
            .network_log_manager
            .append_for_ip("10.0.0.1", accepted_row.clone())
            .await,
        "network-log row should be accepted before hard cancellation",
    );
    tokio::time::timeout(Duration::from_secs(5), write_started.notified())
        .await
        .expect("accepted network-log write should enter the write gate");

    let cancel = RunCancellationHandle::new();
    cancel.request_hard_cancellation().await;
    // Keep stop/destroy ungated and home promotion absent, so polling reaches
    // session closure rather than an unrelated cleanup wait.
    let mut finalizer = std::pin::pin!(finalize_sandbox_for_completion(
        Some(Box::new(MockSandbox::new("network-log-cancel-flush"))),
        ActiveBudgetLease::new(lease),
        fixture.finalize_context(
            RunId::new_v4(),
            SandboxId::new_v4(),
            "sess-network-log-cancel-flush",
            network_log_session,
            cancel,
        ),
    ));
    assert!(
        finalizer.as_mut().now_or_never().is_none(),
        "hard-cancelled finalization must wait for the accepted network-log write",
    );
    assert!(
        !fixture
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"after-close.test"})
            )
            .await,
        "finalizer must reach session closure before waiting for the accepted write",
    );

    write_release.add_permits(1);
    let _finalization_ready = tokio::time::timeout(Duration::from_secs(5), finalizer)
        .await
        .expect("finalizer should complete after the accepted write is released");
    let contents = tokio::fs::read_to_string(fixture.dir.path().join("network.jsonl"))
        .await
        .expect("accepted network-log row should be persisted before finalization returns");
    let rows: Vec<serde_json::Value> = contents
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .expect("persisted network-log rows should be valid JSON");
    assert_eq!(rows, vec![accepted_row]);
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
}

#[tokio::test]
async fn finalizer_preserves_verified_success_metadata_after_late_cooperative_cancel() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let session_id = "sess-late-cooperative-cancel";
    let cancel = RunCancellationHandle::new();
    cancel.request_cooperative_user_cancellation().await;
    let cleanup_state = RunCleanupState::new();
    let identity = RestoredSessionIdentity::claude_code_for_test("verified-history");
    let mut context =
        fixture.finalize_context(run_id, sandbox_id, session_id, network_log_session, cancel);
    context.exit_code = 137;
    context.restored_session_identity = Some(identity.clone());
    context.cleanup_state = cleanup_state.clone();

    let _finalization_ready = finalize_sandbox_for_completion(
        Some(Box::new(mock_sandbox_ready_for_idle_reuse(
            "late-cooperative-cancel",
        ))),
        ActiveBudgetLease::new(lease),
        context,
    )
    .await;

    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::IdlePoolOwned,
    );
    let held = fixture.idle_pool.lock().await.held_sandbox_states();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].reusable_sandbox.source_run_id, run_id,);
    let entry = fixture
        .idle_pool
        .lock()
        .await
        .take(session_id)
        .expect("late-cancelled successful sandbox should be parked");
    let runner_lifecycle::idle_pool::IdleUnparkResult::Reused { sandbox, .. } =
        entry.try_unpark_for_run(RunId::new_v4()).await
    else {
        panic!("late-cancelled successful sandbox should unpark");
    };
    assert_eq!(sandbox.restored_session_identity(), Some(&identity));
}

#[tokio::test]
async fn finalizer_destroys_candidate_when_cancelled_after_park() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cancel = RunCancellationHandle::new();
    let cleanup_state = RunCleanupState::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-cancel-after-park",
        network_log_session,
        cancel.clone(),
    );
    context.factory = factory;
    context.cleanup_state = cleanup_state.clone();

    let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
        Some(sandbox),
        ActiveBudgetLease::new(lease),
        context,
    ));

    assert_eq!(
        park_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("park should enter gate"),
        1
    );
    cancel.request_hard_cancellation().await;
    park_gate.release_one();
    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("cancelled parked candidate should enter destroy gate"),
        1
    );
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    assert!(
        !fixture
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"after-cancelled-park.test"})
            )
            .await,
        "cancelled parked candidate must close network-log attribution before destroy",
    );

    destroy_gate.release_one();
    let _finalization_ready = finalize_task.await.expect("finalizer task should join");
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::DestroyCompleted
    );
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
}

#[tokio::test]
async fn finalizer_destroys_candidate_when_cancelled_before_idle_pool_transfer() {
    let (_budget, lease) = test_budget_lease();
    let fixture = FinalizeTestFixture::new().await;
    let network_log_session = fixture.network_log_session().await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cancel = RunCancellationHandle::new();
    let cleanup_state = RunCleanupState::new();
    let (hooks, mut events) = observe_finalization_events();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
    let mut context = fixture.finalize_context(
        run_id,
        sandbox_id,
        "sess-cancel-before-transfer",
        network_log_session,
        cancel.clone(),
    );
    context.factory = factory;
    context.cleanup_state = cleanup_state.clone();
    // Hold the pool lock so cancellation lands after the observer event but
    // before ownership can transfer into the idle pool.
    let pool_guard = fixture.idle_pool.lock().await;

    let finalize_task = tokio::spawn(finalize_sandbox_for_completion_observed(
        Some(sandbox),
        ActiveBudgetLease::new(lease),
        context,
        hooks,
    ));

    wait_for_finalization_event(
            &mut events,
            |event| matches!(event, FinalizationTestEvent::BeforeIdlePoolOwnershipTransfer { run_id: observed } if *observed == run_id),
            Duration::from_secs(5),
        )
        .await;
    cancel.request_hard_cancellation().await;
    assert!(
        !fixture
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"before-transfer-cancel.test"})
            )
            .await,
        "network-log attribution must be closed before waiting for idle-pool ownership",
    );
    drop(pool_guard);
    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("cancelled candidate should enter destroy gate"),
        1
    );

    destroy_gate.release_one();
    let _finalization_ready = finalize_task.await.expect("finalizer task should join");
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::DestroyCompleted
    );
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
}
