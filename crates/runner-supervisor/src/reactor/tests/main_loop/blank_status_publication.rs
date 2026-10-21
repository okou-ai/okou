use super::super::super::*;
use super::super::support::{
    TestParkedIdleCandidateSpec, minimal_context, mock_run_config_with_overrides, push_job,
    seed_idle_pool_with_timing, shutdown, test_profiles, wait_discover_entered,
};

#[derive(Clone, Copy)]
enum PublicationOrigin {
    AgedExact,
    PreparedBlank,
}

#[derive(Clone, Copy)]
enum PublicationWait {
    State,
    AtomicWrite,
}

async fn claim_while_blank_publication_is_held(origin: PublicationOrigin, wait: PublicationWait) {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let park = sandbox_mock::MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park.clone());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides.clone());
    config.capacity.max_idle = 1;
    let budget = Arc::clone(&config.capacity.budget);
    let pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    if matches!(wait, PublicationWait::AtomicWrite) {
        config.shared.status = Arc::new(StatusTracker::new_with_atomic_write_gate(
            status_path.clone(),
            3, // Startup publishes Initial and Running before the controlled writer.
            Arc::clone(&started),
            Arc::clone(&release),
        ));
    }
    let status = Arc::clone(&config.shared.status);
    let (_heartbeat, heartbeat_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_rx);
    // Suppress the startup refill until status contention has been armed.
    let foreground = config
        .exec_config
        .pre_spawn_admission
        .acquire(2, &env.cancel)
        .await
        .unwrap();
    if matches!(origin, PublicationOrigin::AgedExact) {
        seed_idle_pool_with_timing(
            &pool,
            &budget,
            TestParkedIdleCandidateSpec {
                reuse_key: "aged-before-publication",
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 4096,
                native_generation_run_id: None,
                parked_at: std::time::Instant::now() - Duration::from_secs(40 * 60),
            },
        )
        .await;
    }
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let mut state_waits = status.idle_snapshot_waits_for_test();
    let previous_waits = *state_waits.borrow_and_update();
    let previous_requests = status.idle_info_update_request_count();
    let holder = if matches!(wait, PublicationWait::State) {
        Some(status.hold_state_for_test().await)
    } else {
        None
    };
    let writer = if matches!(wait, PublicationWait::AtomicWrite) {
        let status = Arc::clone(&status);
        let writer = tokio::spawn(async move { status.set_mode(RunnerMode::Running).await });
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .expect("external writer must own the real atomic-write gate");
        Some(writer)
    } else {
        None
    };
    drop(foreground);

    if matches!(origin, PublicationOrigin::PreparedBlank) {
        park.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        park.release_one();
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        match wait {
            PublicationWait::State => {
                state_waits
                    .wait_for(|count| *count > previous_waits)
                    .await
                    .expect("status state-lock observation should remain live");
            }
            PublicationWait::AtomicWrite => {
                while status.idle_info_update_request_count() <= previous_requests {
                    tokio::task::yield_now().await;
                }
            }
        }
    })
    .await
    .expect("accepted blank mutation must reach blocked publication");

    let blank_id = if matches!(origin, PublicationOrigin::PreparedBlank) {
        Some(pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id)
    } else {
        assert!(pool.lock().await.held_reuse_keys().is_empty());
        None
    };
    let run_id = RunId::new_v4();
    env.handle.block_claim(run_id);
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let claimed_while_held = env
        .handle
        .wait_run_claim_in_flight(run_id, Duration::from_secs(2))
        .await;
    let registered_while_held = env.cancel_tokens.handle(run_id).await.is_some();
    let owned_while_held = budget.allocated().2 > 0;

    // Retain cleanup on the expected unchanged-runtime failure as well.
    drop(holder);
    release.add_permits(1);
    park.release_many(usize::MAX);
    if let Some(writer) = writer {
        writer.await.unwrap().unwrap();
    }
    env.handle.unblock_claim(run_id);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("the admitted job should complete after the publication gate opens");
    assert_eq!(completion.exit_code, 0);
    if let Some(blank_id) = blank_id {
        assert_eq!(completion.sandbox_id, Some(blank_id));
    }
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(pool.lock().await.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(status_path).await.unwrap()).unwrap();
    assert_eq!(persisted["mode"], "stopped");
    for field in ["idle_sandboxes", "blank_sandboxes", "active_runs"] {
        assert!(
            persisted
                .get(field)
                .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty)),
            "joined shutdown must not retain stale {field}: {persisted}",
        );
    }
    assert!(
        claimed_while_held,
        "eligible claim waited for blank inventory publication"
    );
    assert!(registered_while_held);
    assert!(owned_while_held);
}

#[tokio::test]
async fn aged_exact_publication_state_wait_allows_claim() {
    claim_while_blank_publication_is_held(PublicationOrigin::AgedExact, PublicationWait::State)
        .await;
}

#[tokio::test]
async fn aged_exact_publication_atomic_write_wait_allows_claim() {
    claim_while_blank_publication_is_held(
        PublicationOrigin::AgedExact,
        PublicationWait::AtomicWrite,
    )
    .await;
}

#[tokio::test]
async fn prepared_blank_publication_state_wait_allows_claim() {
    claim_while_blank_publication_is_held(PublicationOrigin::PreparedBlank, PublicationWait::State)
        .await;
}

#[tokio::test]
async fn prepared_blank_publication_atomic_write_wait_allows_claim() {
    claim_while_blank_publication_is_held(
        PublicationOrigin::PreparedBlank,
        PublicationWait::AtomicWrite,
    )
    .await;
}
