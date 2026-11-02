use super::*;
use futures_util::FutureExt;
use runner_host::paths::RunnerPaths;
use runner_lifecycle::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use runner_lifecycle::idle_pool::{
    IdlePoolConfig, ParkResult, ParkedIdleCandidate, test_support::ParkedIdleCandidateBuilder,
};
use runner_types::types::{HomeCacheCapability, ReusableSandboxState};
use sandbox::SandboxId;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

#[derive(Default)]
struct RecordingProvider {
    heartbeats: std::sync::Mutex<Vec<HeartbeatState>>,
}

#[async_trait::async_trait]
impl JobProvider for RecordingProvider {
    async fn discover(&self) -> Option<runner_provider::JobCandidate> {
        None
    }

    async fn claim(
        &self,
        _candidate: runner_provider::JobCandidate,
    ) -> Option<runner_provider::ClaimedJob> {
        None
    }

    async fn complete(
        &self,
        _request: runner_types::types::CompleteRequest,
        _completion_auth: runner_provider::CompletionAuth,
    ) {
    }

    async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()> {
        self.heartbeats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(state.clone());
        Ok(())
    }

    async fn shutdown(&self) {}
}

fn test_runner_identity() -> RunnerProcessIdentity {
    RunnerProcessIdentity::new(uuid::Uuid::from_u128(1), 7).unwrap()
}

fn test_profiles() -> BTreeMap<String, HeartbeatProfile> {
    let mut m = BTreeMap::new();
    m.insert(
        "vm0/default".to_string(),
        HeartbeatProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            home_disk_mb: 1,
        },
    );
    m
}

fn test_snapshot_metadata() -> HeartbeatSnapshotMetadata<'static> {
    HeartbeatSnapshotMetadata {
        runner_identity: test_runner_identity(),
        group: "vm0/test",
        sequence: 42,
    }
}

fn make_parked_candidate(reuse_key: &str, budget: &Arc<ResourceBudget>) -> ParkedIdleCandidate {
    ParkedIdleCandidateBuilder::new(
        reuse_key,
        ResourceBudget::try_reserve_lease(budget, 2, 4096).unwrap(),
    )
    .with_mock_sandbox_name("test")
    .build()
}

fn refresh_snapshot(snapshot: &HomeCacheStateSnapshot, states: Vec<HeldHomeState>) {
    let refresh = snapshot.begin_home_cache_refresh();
    let mut inventory = HomeCacheInventory::default();
    for state in states {
        for home in state.home_caches {
            inventory.entries.insert(
                format!("{}:{}", state.reuse_key, home.profile),
                HeldHomeState {
                    reuse_key: state.reuse_key.clone(),
                    last_completed_at: state.last_completed_at.clone(),
                    home_caches: vec![home],
                },
            );
        }
    }
    snapshot.finish_home_cache_refresh(refresh, inventory);
}

#[tokio::test]
async fn home_inventory_operations_distinguish_unloaded_empty_and_omitted_states() {
    let observations = runner_storage::operation_test_support::RecordedHomeObservations::default();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 0,
    })));
    let profiles = test_profiles();
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let active_runs = test_active_runs();
    let provider = Arc::new(RecordingProvider::default());
    let snapshot = HomeCacheStateSnapshot::new();
    let hb = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &idle_pool,
        runner_hostname: None,
        runner_identity: test_runner_identity(),
        group: "vm0/test",
        profiles: &profiles,
        budget: &budget,
        provider: provider.clone(),
        active_runs: &active_runs,
        home_cache_snapshot: snapshot.clone(),
        sandbox_op_reporter: Some(observations.handle()),
    });
    send_heartbeat(&hb, RunnerMode::Running, 1, HeartbeatRequest::ordinary())
        .await
        .unwrap();
    refresh_snapshot(&snapshot, Vec::new());
    send_heartbeat(&hb, RunnerMode::Running, 2, HeartbeatRequest::ordinary())
        .await
        .unwrap();
    refresh_snapshot(
        &snapshot,
        vec![
            held_home_state(
                "thread:available",
                "2026-06-01T00:00:00.000Z",
                &["vm0/default"],
            ),
            held_home_state(
                "thread:active",
                "2026-06-01T00:00:00.000Z",
                &["vm0/default"],
            ),
            held_home_state(
                "thread:other-profile",
                "2026-06-01T00:00:00.000Z",
                &["other"],
            ),
        ],
    );
    let _active = active_runs.register(
        runner_types::ids::RunId::new_v4(),
        Some("thread:active".into()),
        "vm0/default".into(),
    );
    send_heartbeat(&hb, RunnerMode::Running, 3, HeartbeatRequest::ordinary())
        .await
        .unwrap();
    let events = observations.events();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].inventory_loaded, Some(false));
    assert_eq!(events[0].inventory_output_states, Some(0));
    assert_eq!(events[1].inventory_loaded, Some(true));
    assert_eq!(events[1].inventory_output_states, Some(0));
    let event = &events[2];
    assert_eq!(event.kind, HomeObservationKind::Inventory);
    assert_eq!(event.outcome, HomeObservationOutcome::Assembled);
    assert_eq!(
        event.runner_id.as_deref(),
        Some(test_runner_identity().runner_id().to_string().as_str())
    );
    assert_eq!(event.runner_heartbeat_generation, Some(7));
    assert_eq!(event.inventory_loaded, Some(true));
    assert_eq!(event.inventory_observed_states, Some(3));
    assert_eq!(event.inventory_output_states, Some(1));
    assert_eq!(event.inventory_omitted_states, Some(2));
    assert!(event.run_id.is_none());
    assert!(event.is_first_run.is_none());
    let sent = provider.heartbeats.lock().unwrap();
    assert_eq!(
        sent[2].held_home_states,
        vec![held_home_state(
            "thread:available",
            "2026-06-01T00:00:00.000Z",
            &["vm0/default"]
        )]
    );
}

fn test_active_runs() -> ActiveRuns {
    ActiveRuns::new(Arc::new(tokio::sync::Notify::new()))
}

fn home_cache(profile: &str) -> HomeCacheCapability {
    HomeCacheCapability {
        source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
        profile: profile.to_owned(),
        home_affinity_version: runner_types::types::HOME_AFFINITY_VERSION,
    }
}

fn held_home_state(reuse_key: &str, last_completed_at: &str, profiles: &[&str]) -> HeldHomeState {
    HeldHomeState {
        reuse_key: reuse_key.to_owned(),
        last_completed_at: last_completed_at.to_owned(),
        home_caches: profiles.iter().map(|profile| home_cache(profile)).collect(),
    }
}

async fn seed_home_cache_state(
    cache: &HomeImageCache,
    paths: &RunnerPaths,
    reuse_key: &str,
    completed_at: &str,
) -> runner_types::ids::RunId {
    let run_id = runner_types::ids::RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir:
                    api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::File::create(&active_image)
        .await
        .unwrap()
        .set_len(1024 * 1024)
        .await
        .unwrap();
    assert!(
        lease
            .promote(
                run_id,
                HomeCacheTerminalStatus::Success,
                completed_at.into(),
                &runner_storage::storage_fingerprints::StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    run_id
}

async fn capture_heartbeat_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
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

fn home_cache_change(cache_key: &str) -> HomeCacheChange {
    HomeCacheChange {
        observed_at: tokio::time::Instant::now(),
        dirty_cache_keys: BTreeSet::from([cache_key.to_owned()]),
        requires_full_reconcile: false,
    }
}

#[test]
fn ordinary_heartbeat_forces_send_without_dropping_coalesced_cache_commits() {
    let ordinary = HeartbeatRequest::ordinary();
    let cache_then_ordinary =
        HeartbeatRequest::home_cache(home_cache_change("a")).merge(HeartbeatRequest::ordinary());
    let ordinary_then_cache =
        HeartbeatRequest::ordinary().merge(HeartbeatRequest::home_cache(home_cache_change("b")));
    assert!(ordinary.home_cache_change.is_none());
    assert!(cache_then_ordinary.home_cache_change.is_some());
    assert_eq!(
        cache_then_ordinary
            .home_cache_change
            .unwrap()
            .dirty_cache_keys,
        BTreeSet::from(["a".to_owned()])
    );
    assert!(ordinary_then_cache.home_cache_change.is_some());
    assert_eq!(
        ordinary_then_cache
            .home_cache_change
            .unwrap()
            .dirty_cache_keys,
        BTreeSet::from(["b".to_owned()])
    );
}

#[test]
fn heartbeat_running_count_no_idle() {
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let _leases = [
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
    ];
    let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let profiles = test_profiles();

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );
    assert_eq!(state.running_count, 2);
}

#[test]
fn heartbeat_admittable_profiles_match_current_budget() {
    let budget = Arc::new(ResourceBudget::new(5, 8192, 1.0, 2));
    let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let mut profiles = test_profiles();
    profiles.insert(
        "vm0/large".to_string(),
        HeartbeatProfile {
            vcpu: 4,
            memory_mb: 8192,
            rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            home_disk_mb: 10240,
        },
    );
    let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );

    assert_eq!(state.admittable_profiles, vec!["vm0/default"]);
}

#[test]
fn heartbeat_admittable_profiles_include_reclaimable_but_not_reserved_inventory() {
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 1));
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let candidate = ParkedIdleCandidateBuilder::new(
        "sess-idle",
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
    )
    .with_last_completed_at("2026-06-01T00:00:00.000Z")
    .build();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let profiles = test_profiles();

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );

    assert_eq!(state.admittable_profiles, vec!["vm0/default"]);
    assert_eq!(state.allocated_vcpu, 2);
    assert_eq!(state.allocated_memory_mb, 4096);
    assert_eq!(state.running_count, 0);

    let reserved = pool
        .reserve_reusable("sess-idle", "vm0/default", &None)
        .unwrap();
    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );
    assert!(state.admittable_profiles.is_empty());
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(matches!(
        pool.restore_reserved(reserved),
        runner_lifecycle::idle_pool::RestoreReservedIdleResult::Restored
    ));
}

#[test]
fn heartbeat_reclaimable_profiles_respect_active_capacity_for_all_parked_kinds() {
    for blank_count in 0..=2 {
        let budget = Arc::new(ResourceBudget::new(4, 6144, 1.0, 3));
        let _active = ResourceBudget::try_reserve_lease(&budget, 1, 2048).unwrap();
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        for index in 0..2 {
            let lease = ResourceBudget::try_reserve_lease(&budget, 1, 2048).unwrap();
            let candidate = if index < blank_count {
                let sandbox_id = SandboxId::new_v4();
                ParkedIdleCandidate::blank(
                    Box::new(sandbox_mock::MockSandbox::new(sandbox_id.to_string())),
                    Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
                    lease,
                    sandbox_id,
                    "vm0/small".into(),
                    "test-rootfs".into(),
                    None,
                )
            } else {
                ParkedIdleCandidateBuilder::new(format!("idle-{index}"), lease)
                    .with_profile_name("vm0/small")
                    .build()
            };
            assert!(matches!(pool.park(candidate), ParkResult::Parked));
        }
        let mut profiles = test_profiles();
        profiles.insert(
            "vm0/small".into(),
            HeartbeatProfile {
                vcpu: 1,
                memory_mb: 2048,
                rootfs_hash: "test-rootfs".into(),
                home_disk_mb: 10240,
            },
        );
        profiles.insert(
            "vm0/large".into(),
            HeartbeatProfile {
                vcpu: 4,
                memory_mb: 8192,
                rootfs_hash: "test-rootfs".into(),
                home_disk_mb: 10240,
            },
        );

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.admittable_profiles, vec!["vm0/default", "vm0/small"]);
        assert_eq!(state.running_count, 1);
        assert_eq!(state.allocated_vcpu, 3);
        assert_eq!(state.allocated_memory_mb, 6144);
        assert!(ResourceBudget::try_reserve_lease(&budget, 2, 4096).is_none());
    }
}

#[test]
fn heartbeat_admittable_profiles_empty_when_not_running() {
    let budget = ResourceBudget::new(8, 32768, 1.0, 4);
    let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let profiles = test_profiles();

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Draining,
    );

    assert!(state.admittable_profiles.is_empty());
}

#[test]
fn heartbeat_starting_reports_no_admittable_profiles() {
    let budget = ResourceBudget::new(8, 32768, 1.0, 4);
    let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let profiles = test_profiles();

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Starting,
    );

    assert_eq!(state.mode, "starting");
    assert!(state.admittable_profiles.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn send_heartbeat_logs_state_counts_without_raw_reuse_state() {
    let reuse_key = "thread:sensitive-heartbeat-17975";
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    let source_run_id =
        seed_home_cache_state(&cache, &paths, reuse_key, "2026-06-01T00:00:00.000Z").await;
    let profiles = test_profiles();
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let active_runs = test_active_runs();
    let provider = Arc::new(RecordingProvider::default());
    let home_cache_snapshot = HomeCacheStateSnapshot::new();
    refresh_initial_home_cache_snapshot(&home_cache_snapshot, Some(&cache), &profiles).await;
    let hb = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &idle_pool,
        runner_hostname: None,
        sandbox_op_reporter: None,
        runner_identity: test_runner_identity(),
        group: "vm0/test",
        profiles: &profiles,
        budget: &budget,
        provider,
        active_runs: &active_runs,
        home_cache_snapshot: home_cache_snapshot.clone(),
    });

    let (delivery, events) = capture_heartbeat_events(send_heartbeat(
        &hb,
        RunnerMode::Running,
        42,
        HeartbeatRequest::ordinary(),
    ))
    .await;

    delivery.unwrap();

    let heartbeat_event = captured_event(&events, "heartbeat");
    assert_eq!(heartbeat_event.level, tracing::Level::INFO);
    assert_eq!(
        heartbeat_event
            .fields
            .get("reusable_sandboxes")
            .map(String::as_str),
        Some("0")
    );
    assert_eq!(
        heartbeat_event
            .fields
            .get("home_states")
            .map(String::as_str),
        Some("1")
    );
    for event in &events {
        for (field, value) in &event.fields {
            assert!(
                !value.contains(reuse_key),
                "captured field {field} leaked raw reuse key {reuse_key:?}: {event:#?}"
            );
        }
    }
    let cached_states = home_cache_snapshot.current_held_home_states(&active_runs, None);
    assert_eq!(cached_states.len(), 1);
    assert_eq!(cached_states[0].reuse_key, reuse_key);
    assert_eq!(
        cached_states[0].home_caches,
        vec![HomeCacheCapability {
            source_run_id,
            ..home_cache("vm0/default")
        }]
    );
}

#[tokio::test]
async fn unused_release_heartbeat_revalidates_one_key_and_preserves_independent_homes() {
    for replace_source in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = HomeImageCache::new(paths.clone());
        seed_home_cache_state(&cache, &paths, "released", "2026-06-01T00:00:00.000Z").await;
        seed_home_cache_state(&cache, &paths, "independent", "2026-06-01T00:01:00.000Z").await;
        let mut watcher = runner_lifecycle::home_image_cache::HomeCacheWatcher::new(cache.clone())
            .await
            .unwrap();
        let profiles = test_profiles();
        let snapshot = HomeCacheStateSnapshot::new();
        refresh_initial_home_cache_snapshot(&snapshot, Some(&cache), &profiles).await;
        assert_eq!(snapshot.loaded_home_cache_snapshot().states.len(), 2);
        let lease = cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: runner_types::ids::RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    rootfs_hash: "current-rootfs",
                    reuse_key: Some("released"),
                    working_dir:
                        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                    image_size_bytes: 1024 * 1024,
                },
                home_drive_required: true,
            })
            .await;
        assert!(lease.is_cache_hit());
        if replace_source {
            let identity = lease.source_identity().unwrap();
            let image = cache
                .entry_paths(identity.cache_key)
                .image(identity.image_generation)
                .unwrap();
            tokio::fs::rename(&image, dir.path().join("original.ext4"))
                .await
                .unwrap();
            tokio::fs::File::create(&image)
                .await
                .unwrap()
                .set_len(1024 * 1024)
                .await
                .unwrap();
        }
        drop(lease);
        let change = tokio::time::timeout(Duration::from_secs(10), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert!(!change.requires_full_reconcile);
        cache.reset_held_state_root_scan_count();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let active_runs = test_active_runs();
        let provider = Arc::new(RecordingProvider::default());
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_hostname: None,
            sandbox_op_reporter: None,
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            profiles: &profiles,
            budget: &budget,
            provider: provider.clone(),
            active_runs: &active_runs,
            home_cache_snapshot: snapshot,
        });
        hb.home_cache_snapshot.note_home_cache_change(&change);
        let token = hb.home_cache_snapshot.begin_home_cache_refresh();
        let updates = cache
            .revalidate_home_cache_keys(&profile_home_sizes(&profiles), &change.dirty_cache_keys)
            .await;
        hb.home_cache_snapshot
            .finish_home_cache_key_updates(token, updates);
        send_heartbeat(
            &hb,
            RunnerMode::Running,
            1,
            HeartbeatRequest::home_cache(change).merge(HeartbeatRequest::ordinary()),
        )
        .await
        .unwrap();
        let sent = provider.heartbeats.lock().unwrap();
        assert_eq!(sent.len(), 1);
        let keys = sent[0]
            .held_home_states
            .iter()
            .map(|state| state.reuse_key.as_str())
            .collect::<BTreeSet<_>>();
        let expected = if replace_source {
            BTreeSet::from(["independent"])
        } else {
            BTreeSet::from(["independent", "released"])
        };
        assert_eq!(keys, expected);
        assert_eq!(cache.held_state_root_scan_count(), 0);
    }
}

#[tokio::test]
async fn initial_home_cache_heartbeat_uses_loaded_snapshot() {
    let reuse_key = "thread:loaded-initial-snapshot";
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    seed_home_cache_state(&cache, &paths, reuse_key, "2026-06-01T00:00:00.000Z").await;
    let profiles = test_profiles();
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let active_runs = test_active_runs();
    let provider = Arc::new(RecordingProvider::default());
    let home_cache_snapshot = HomeCacheStateSnapshot::new();
    refresh_snapshot(
        &home_cache_snapshot,
        vec![held_home_state(
            reuse_key,
            "2026-06-01T00:00:00.000Z",
            &["vm0/default"],
        )],
    );
    let cache_key =
        runner_host::paths::scoped_home_image_cache_key("", "vm0/default", reuse_key, 1024 * 1024);
    let metadata = runner_lifecycle::test_fixtures::runner_home_image_cache_dir(&paths)
        .join(cache_key)
        .join("metadata.json");
    tokio::fs::remove_file(metadata).await.unwrap();
    let hb = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &idle_pool,
        runner_hostname: None,
        sandbox_op_reporter: None,
        runner_identity: test_runner_identity(),
        group: "vm0/test",
        profiles: &profiles,
        budget: &budget,
        provider: provider.clone(),
        active_runs: &active_runs,
        home_cache_snapshot,
    });

    send_heartbeat(&hb, RunnerMode::Running, 42, HeartbeatRequest::ordinary())
        .await
        .unwrap();

    let heartbeats = provider
        .heartbeats
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(heartbeats.len(), 1);
    assert_eq!(
        heartbeats[0].held_home_states,
        vec![held_home_state(
            reuse_key,
            "2026-06-01T00:00:00.000Z",
            &["vm0/default"],
        )]
    );
}

#[tokio::test]
async fn home_inventory_survives_rootfs_changes_and_requires_exact_home_shape() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    seed_home_cache_state(
        &cache,
        &paths,
        "thread:profile-identity",
        "2026-06-01T00:00:00.000Z",
    )
    .await;
    let mut profiles = test_profiles();
    assert_eq!(home_cache_states(Some(&cache), &profiles).await.len(), 1);
    // A new rootfs uses the same independent home image and physical key.
    profiles.get_mut("vm0/default").unwrap().rootfs_hash =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab".into();
    assert_eq!(home_cache_states(Some(&cache), &profiles).await.len(), 1);
    let snapshot = HomeCacheStateSnapshot::new();
    let initial = refresh_initial_home_cache_snapshot(&snapshot, Some(&cache), &profiles).await;
    assert_eq!(initial.states.len(), 1);
    profiles.get_mut("vm0/default").unwrap().rootfs_hash =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 2;
    assert!(home_cache_states(Some(&cache), &profiles).await.is_empty());
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    assert_eq!(home_cache_states(Some(&cache), &profiles).await.len(), 1);
    profiles.clear();
    assert!(home_cache_states(Some(&cache), &profiles).await.is_empty());
}

#[test]
fn cached_home_snapshot_filters_profiles_and_serializes_empty_inventory() {
    let profiles = test_profiles();
    let filtered = filter_home_states_for_profiles(
        vec![held_home_state(
            "thread:configured",
            "2026-06-01T00:00:00.000Z",
            &["vm0/default", "vm0/removed"],
        )],
        &profiles,
    );
    assert_eq!(filtered[0].home_caches, vec![home_cache("vm0/default")]);
    let budget = ResourceBudget::new(8, 32768, 1.0, 4);
    let pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );
    let body = serde_json::to_value(&state).unwrap();
    assert_eq!(body["heldHomeStates"], serde_json::json!([]));
    assert!(
        state.held_home_states.is_empty(),
        "inventory is populated only by eligible cache evidence"
    );
}

#[tokio::test]
async fn home_cache_states_filter_claimed_reuse_key() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = HomeImageCache::new(paths.clone());
    seed_home_cache_state(&cache, &paths, "sess-cache", "2026-06-01T00:00:00.000Z").await;
    seed_home_cache_state(&cache, &paths, "sess-claimed", "2026-06-01T00:00:01.000Z").await;
    let active_runs = test_active_runs();
    let profiles = test_profiles();
    let cache_states = home_cache_states(Some(&cache), &profiles).await;
    let states = filter_current_held_home_states(cache_states, &active_runs, Some("sess-claimed"));

    assert!(
        states.iter().any(|state| state.reuse_key == "sess-cache"),
        "unrelated home cache should remain advertised"
    );
    assert!(
        !states.iter().any(|state| state.reuse_key == "sess-claimed"),
        "currently claimed reuse key should be filtered until the run finishes"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn heartbeat_advertises_live_producer_then_held_sandbox() {
    let reuse_key = "thread:heartbeat-producer";
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let notify = Arc::new(tokio::sync::Notify::new());
    let active_runs = ActiveRuns::new(Arc::clone(&notify));
    let run_id = runner_types::ids::RunId::new_v4();
    let guard = active_runs.register(run_id, Some(reuse_key.into()), "vm0/default".into());
    assert!(notify.notified().now_or_never().is_some());
    let publisher = guard.reuse_publisher();
    let provider = Arc::new(RecordingProvider::default());
    let profiles = test_profiles();
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let hb = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &idle_pool,
        runner_hostname: None,
        sandbox_op_reporter: None,
        runner_identity: test_runner_identity(),
        group: "vm0/test",
        profiles: &profiles,
        budget: &budget,
        provider: provider.clone(),
        active_runs: &active_runs,
        home_cache_snapshot: HomeCacheStateSnapshot::new(),
    });

    send_heartbeat(&hb, RunnerMode::Running, 1, HeartbeatRequest::ordinary())
        .await
        .unwrap();
    assert!(publisher.mark_finalizing(std::time::Instant::now()));
    send_heartbeat(&hb, RunnerMode::Running, 2, HeartbeatRequest::ordinary())
        .await
        .unwrap();
    let mut pool = idle_pool.lock().await;
    let in_flight_hb = hb.clone();
    let in_flight = tokio::spawn(async move {
        send_heartbeat(
            &in_flight_hb,
            RunnerMode::Running,
            3,
            HeartbeatRequest::ordinary(),
        )
        .await
        .unwrap();
    });
    // The task takes the active snapshot then waits for the pool lock.
    tokio::task::yield_now().await;
    let candidate = ParkedIdleCandidateBuilder::new(
        reuse_key,
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
    )
    .with_last_completed_at("2026-06-01T00:00:00.000Z")
    .build();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    assert!(publisher.publish_exact_sandbox());
    drop(pool);
    in_flight.await.unwrap();
    send_heartbeat(&hb, RunnerMode::Running, 4, HeartbeatRequest::ordinary())
        .await
        .unwrap();

    let heartbeats = provider
        .heartbeats
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(heartbeats[0].active_reuse_producers[0].run_id, run_id);
    assert_eq!(heartbeats[0].active_reuse_producers[0].reuse_key, reuse_key);
    assert!(heartbeats[0].held_sandbox_states.is_empty());
    assert_eq!(heartbeats[1].active_reuse_producers[0].run_id, run_id);
    assert_eq!(heartbeats[2].active_reuse_producers[0].run_id, run_id);
    assert_eq!(heartbeats[2].held_sandbox_states[0].reuse_key, reuse_key);
    assert!(heartbeats[3].active_reuse_producers.is_empty());
    assert_eq!(heartbeats[3].held_sandbox_states[0].reuse_key, reuse_key);
}

#[test]
fn held_sandbox_states_filter_active_reuse_keys() {
    let active_runs = test_active_runs();
    let active_guard = active_runs.register(
        runner_types::ids::RunId::new_v4(),
        Some("thread-active".into()),
        "vm0/default".into(),
    );
    let states = vec![
        HeldSandboxState {
            reuse_key: "thread-active".into(),
            last_completed_at: "2026-06-01T00:00:01.000Z".into(),
            reusable_sandbox: ReusableSandboxState {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile: "vm0/default".into(),
            },
        },
        HeldSandboxState {
            reuse_key: "thread-held".into(),
            last_completed_at: "2026-06-01T00:00:02.000Z".into(),
            reusable_sandbox: ReusableSandboxState {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile: "vm0/default".into(),
            },
        },
    ];

    let filtered =
        filter_current_held_sandbox_states(states.clone(), &active_runs, Some("thread-claimed"));

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].reuse_key, "thread-held");

    assert!(active_guard.reuse_publisher().publish_exact_sandbox());
    let filtered = filter_current_held_sandbox_states(states, &active_runs, None);
    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0].reuse_key, "thread-active");
    assert_eq!(filtered[1].reuse_key, "thread-held");
}

#[test]
fn heartbeat_running_count_excludes_idle() {
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let _leases = [
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
    ];
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(
        pool.park(make_parked_candidate("sess-1", &budget)),
        ParkResult::Parked,
    ));
    let profiles = test_profiles();

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );
    assert_eq!(state.running_count, 2);
    assert!(state.held_sandbox_states.is_empty());
}

#[test]
fn heartbeat_running_count_all_idle() {
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(
        pool.park(make_parked_candidate("sess-1", &budget)),
        ParkResult::Parked,
    ));
    assert!(matches!(
        pool.park(make_parked_candidate("sess-2", &budget)),
        ParkResult::Parked,
    ));
    let profiles = test_profiles();

    let state = collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );
    assert_eq!(state.running_count, 0);
}

#[test]
#[should_panic(expected = "substituted leases must belong to the target resource budget")]
fn heartbeat_rejects_foreign_pool_budget() {
    let budget = ResourceBudget::new(8, 32768, 1.0, 4);
    let foreign_budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(
        pool.park(make_parked_candidate("sess-1", &foreign_budget)),
        ParkResult::Parked,
    ));
    assert_eq!(pool.len(), 1);
    let profiles = test_profiles();

    collect_heartbeat_state(
        test_snapshot_metadata(),
        &profiles,
        &budget,
        &pool,
        RunnerMode::Running,
    );
}
