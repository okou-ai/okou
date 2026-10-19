use super::super::super::*;
use super::super::support::{
    TEST_HEARTBEAT_GENERATION, TEST_RUNNER_ID, context_with_session, minimal_context,
    mock_run_config, mock_run_config_with_overrides, push_job, shutdown, test_profiles,
    wait_discover_entered, wait_status_mode,
};
use crate::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageCache, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use runner_host::paths::RunnerPaths;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{ActiveRunnerPreference, JobCandidate, RunnerPreferenceTier};
use runner_storage::storage_fingerprints::StorageFingerprints;
use sandbox::SandboxId;
use std::time::Instant;
use tokio::io::AsyncReadExt;

const REUSE_KEY: &str = "thread:draining-shared-home";
const MARKER: &[u8] = b"home written by the draining predecessor";

async fn cross_process_home_is_consumed(publish_before_arrival: bool) {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 16;
    let old_gate = sandbox_mock::MockLifecycleGate::new();
    let old_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    old_overrides.set_wait_process_lifecycle_gate(old_gate.clone());
    let (mut source, old) =
        mock_run_config_with_overrides(profiles.clone(), 2, 4096, 1, old_overrides);
    source.runner.identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let source_identity = source.runner.identity;
    let source_paths = RunnerPaths::new(source.paths.base_dir.clone());
    let publisher = HomeImageCache::shared(
        source_paths.clone(),
        &source.paths.home,
        &source.runner.group,
    );
    Arc::get_mut(&mut source.exec_config).unwrap().home_cache = Some(publisher.clone());
    let gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    runner_lifecycle::home_promotion::test_support::add_healthy_cache_preparation_matcher(
        &overrides,
    );
    let (mut recipient, new) =
        mock_run_config_with_overrides(profiles, 2, 4096, 1, overrides.clone());
    recipient.paths.home = source.paths.home.clone();
    let recipient_paths = RunnerPaths::new(recipient.paths.base_dir.clone());
    let consumer = HomeImageCache::shared(
        recipient_paths.clone(),
        &recipient.paths.home,
        &recipient.runner.group,
    );
    Arc::get_mut(&mut recipient.exec_config).unwrap().home_cache = Some(consumer.clone());
    assert_ne!(source_identity, recipient.runner.identity);

    let predecessor_id = RunId::new_v4();
    let predecessor_sandbox = SandboxId::new_v4();
    let producer = publisher
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: predecessor_id,
                sandbox_id: predecessor_sandbox,
                profile_name: "vm0/default",
                reuse_key: Some(REUSE_KEY),
                working_dir:
                    api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                image_size_bytes: 16 * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    let active = source_paths.active_home_image(&predecessor_sandbox);
    tokio::fs::create_dir_all(active.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active, MARKER).await.unwrap();
    tokio::fs::OpenOptions::new()
        .write(true)
        .open(&active)
        .await
        .unwrap()
        .set_len(16 * 1024 * 1024)
        .await
        .unwrap();
    let active_producer =
        old.active_runs
            .register(predecessor_id, Some(REUSE_KEY.into()), "vm0/default".into());
    let source_status = source.paths.base_dir.join("status.json");
    let old_task = tokio::spawn(run(source));
    wait_discover_entered(&old, Duration::from_secs(5)).await;
    let held_run = RunId::new_v4();
    push_job(
        &old,
        held_run,
        "vm0/default",
        Some(minimal_context(held_run)),
    );
    old_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    old.drain();
    wait_status_mode(&source_status, "draining", Duration::from_secs(5)).await;

    let publication = async move {
        assert!(
            producer
                .promote(
                    predecessor_id,
                    HomeCacheTerminalStatus::Success,
                    "2026-10-19T09:13:38Z".into(),
                    &StorageFingerprints::default()
                )
                .await
                .unwrap()
        );
    };
    tokio::pin!(publication);
    if publish_before_arrival {
        publication.as_mut().await;
    }
    let new_task = tokio::spawn(run(recipient));
    wait_discover_entered(&new, Duration::from_secs(5)).await;
    let sizes = BTreeMap::from([("vm0/default", 16 * 1024 * 1024)]);
    let scopes = publisher.reuse_scopes(&sizes).await;
    assert!(!scopes.is_empty());
    assert_eq!(scopes, consumer.reuse_scopes(&sizes).await);

    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, "provider-session-shared-home");
    context.reuse_key = Some(REUSE_KEY.into());
    new.provider.set_claim_result(run_id, Some(context));
    let deadline = Instant::now() + Duration::from_secs(30);
    let candidate = || {
        JobCandidate::new(run_id, "vm0/default".into())
            .with_reuse_key(Some(REUSE_KEY.into()))
            .with_history_generation_run_id(Some(predecessor_id))
            .with_runner_preference(ActiveRunnerPreference::new(
                RunnerProcessIdentity::new(
                    TEST_RUNNER_ID.parse().unwrap(),
                    TEST_HEARTBEAT_GENERATION,
                )
                .unwrap(),
                RunnerPreferenceTier::FinalizingPredecessor,
                deadline,
            ))
    };
    new.handle.discover_tx.send(candidate()).unwrap();
    if !publish_before_arrival {
        assert!(
            new.handle
                .wait_deferred_poll_count(1, Duration::from_secs(5))
                .await
        );
        assert!(new.handle.claim_candidates().is_empty());
        assert_eq!(new.handle.deferred_poll_deadlines()[0], deadline);
        // Rediscovery is not authority to renew the retained candidate.
        new.handle.discover_tx.send(candidate()).unwrap();
        publication.as_mut().await;
    }
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    let configs = overrides.create_configs();
    let sandbox = configs
        .iter()
        .find(|config| config.home_drive.is_some())
        .expect("recipient must create a VM using the published home");
    assert_ne!(sandbox.id, predecessor_sandbox);
    let Some(sandbox::HomeDriveSeedImage::Move(seed)) =
        sandbox.home_drive.as_ref().unwrap().seed_image.as_ref()
    else {
        panic!("recipient must consume the committed generation as its writable home seed");
    };
    assert!(
        !seed.parent().unwrap().join("metadata.json").exists(),
        "checkout must revoke the shared commit before transferring its seed"
    );
    let mut file = tokio::fs::File::open(seed).await.unwrap();
    let mut actual = vec![0; MARKER.len()];
    file.read_exact(&mut actual).await.unwrap();
    assert_eq!(actual, MARKER);
    assert_eq!(
        seed.file_name().unwrap().to_str().unwrap(),
        format!("image-{predecessor_id}.ext4")
    );
    assert!(
        old.handle
            .claim_candidates()
            .iter()
            .all(|candidate| candidate.run_id() == held_run),
        "the draining publisher cannot claim new work"
    );
    assert!(
        new.active_runs
            .finalizing_predecessor(predecessor_id, REUSE_KEY, "vm0/default")
            .is_none()
    );
    gate.release_one();
    new.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("recipient should finish using the published home");
    drop(active_producer);
    old_gate.release_one();
    old.handle
        .wait_completion(held_run, Duration::from_secs(5))
        .await
        .expect("draining must let previously claimed work finish");
    shutdown(&new, new_task).await;
    shutdown(&old, old_task).await;
}

#[tokio::test]
async fn draining_process_publication_wakes_replacement_and_checks_out_actual_home_bytes() {
    cross_process_home_is_consumed(false).await;
}

#[tokio::test]
async fn replacement_consumes_already_committed_home_from_draining_process() {
    cross_process_home_is_consumed(true).await;
}

#[tokio::test(start_paused = true)]
async fn missing_shared_publication_expires_without_renewal_or_early_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let task = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, REUSE_KEY)));
    let deadline = Instant::now() + Duration::from_secs(30);
    let candidate = |expires| {
        JobCandidate::new(run_id, "vm0/default".into())
            .with_reuse_key(Some(REUSE_KEY.into()))
            .with_history_generation_run_id(Some(RunId::new_v4()))
            .with_runner_preference(ActiveRunnerPreference::new(
                RunnerProcessIdentity::new(
                    TEST_RUNNER_ID.parse().unwrap(),
                    TEST_HEARTBEAT_GENERATION,
                )
                .unwrap(),
                RunnerPreferenceTier::FinalizingPredecessor,
                expires,
            ))
    };
    env.handle.discover_tx.send(candidate(deadline)).unwrap();
    assert!(
        env.handle
            .wait_deferred_poll_count(1, Duration::from_secs(5))
            .await
    );
    assert!(env.handle.claim_candidates().is_empty());
    env.handle
        .discover_tx
        .send(candidate(deadline + Duration::from_secs(30)))
        .unwrap();
    assert!(
        env.handle
            .wait_deferred_poll_count(2, Duration::from_secs(5))
            .await
    );
    tokio::time::advance(Duration::from_secs(30)).await;
    env.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("failed or missing publication must fall back at the original deadline");
    assert!(
        env.handle
            .deferred_poll_deadlines()
            .iter()
            .all(|actual| *actual == deadline)
    );
    shutdown(&env, task).await;
}
