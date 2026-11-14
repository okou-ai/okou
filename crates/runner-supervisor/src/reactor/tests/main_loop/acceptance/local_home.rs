use super::super::super::support::MockRunEnv;
use super::*;
use crate::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use crate::idle_pool::{ParkResult, ParkedIdleCandidate};
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(10);
const SIZE: u64 = 1024 * 1024;

#[derive(Clone, Copy)]
enum HomeCandidate {
    Ordinary,
    FirstRun,
    KnownLocal,
}

#[tokio::test]
async fn first_run_without_a_home_hint_keeps_an_available_blank() {
    assert_home_selection(false, HomeCandidate::FirstRun, true).await;
}

#[tokio::test]
async fn no_hint_keeps_reserved_blank_when_hidden_home_publishes_during_claim() {
    assert_home_selection(true, HomeCandidate::Ordinary, true).await;
}

#[tokio::test]
async fn first_run_without_a_home_hint_creates_a_fresh_home_without_a_seed() {
    assert_home_selection(false, HomeCandidate::FirstRun, false).await;
}

#[tokio::test]
async fn ordinary_acceptance_reuses_a_positively_known_local_home() {
    assert_home_selection(false, HomeCandidate::KnownLocal, true).await;
}

pub(super) async fn publish_home(
    cache: &HomeImageCache,
    paths: &RunnerPaths,
    key: &str,
    source: RunId,
) {
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: source,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(key),
                working_dir: "/home/user/workspace",
                image_size_bytes: SIZE,
            },
            home_drive_required: true,
        })
        .await;
    let image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&image, vec![0x5a; SIZE as usize])
        .await
        .unwrap();
    assert!(
        lease
            .promote(
                source,
                HomeCacheTerminalStatus::Success,
                "2026-10-28T03:00:00Z".into(),
                &crate::storage_fingerprints::StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
}

async fn park_blank(
    config: &RunConfig,
    env: &MockRunEnv,
    overrides: &Arc<MockSandboxOverrides>,
) -> SandboxId {
    let id = SandboxId::new_v4();
    let candidate = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::with_overrides(
            id.to_string(),
            overrides.clone(),
        )),
        Arc::new(Box::new(MockSandboxFactory::with_overrides(
            overrides.clone(),
        ))),
        ResourceBudget::try_reserve_lease(&config.capacity.budget, 2, 4096).unwrap(),
        id,
        "vm0/default".into(),
        config.runner.profiles["vm0/default"].rootfs_hash.clone(),
        None,
    );
    assert!(matches!(
        env.idle_pool.lock().await.park(candidate),
        ParkResult::Parked
    ));
    id
}

async fn assert_home_selection(
    during_claim: bool,
    candidate_kind: HomeCandidate,
    blank_available: bool,
) {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let execution = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 2, overrides.clone());
    config.capacity.max_idle = 0;
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let blank_id = if blank_available {
        Some(park_blank(&config, &env, &overrides).await)
    } else {
        None
    };
    let publisher = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let cache_dir = config.paths.home.home_image_cache_dir();
    let budget = config.capacity.budget.clone();
    let key = "thread:evidenced-home-selection";
    let source = RunId::new_v4();
    let successor = RunId::new_v4();
    let known_local = matches!(candidate_kind, HomeCandidate::KnownLocal);
    if known_local {
        publish_home(&publisher, &paths, key, source).await;
    }
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    // Remove general watcher progress through a real filesystem lifecycle;
    // Unadvertised entries below are discoverable only with selected advice.
    let moved = cache_dir.with_extension("moved");
    tokio::fs::rename(&cache_dir, &moved).await.unwrap();
    tokio::fs::rename(&moved, &cache_dir).await.unwrap();
    if !during_claim && !known_local {
        publish_home(&publisher, &paths, key, source).await;
    }
    let mut context = context_with_reuse_key(successor, key);
    if matches!(candidate_kind, HomeCandidate::FirstRun) {
        context.is_first_run = Some(true);
    }
    env.provider.set_claim_result(successor, Some(context));
    if during_claim {
        env.handle.block_claim(successor);
    }
    let candidate = runner_provider::JobCandidate::new(successor, "vm0/default".into())
        .with_reuse_key(Some(key.into()));
    env.handle.discover_tx.send(candidate).unwrap();
    if during_claim {
        assert!(env.handle.wait_run_claim_in_flight(successor, WAIT).await);
        publish_home(&publisher, &paths, key, source).await;
        env.handle.unblock_claim(successor);
    }
    execution.wait_entered(1, WAIT).await.unwrap();
    let created = overrides.create_configs();
    let restore = known_local;
    let replacements = overrides.home_drive_replacements();
    if restore {
        let drive = if blank_available {
            assert!(
                created.is_empty(),
                "cached Home must retain the available blank VM"
            );
            assert_eq!(replacements.len(), 1);
            &replacements[0]
        } else {
            assert_eq!(created.len(), 1);
            created[0].home_drive.as_ref().unwrap()
        };
        let seed = drive
            .seed_image
            .as_ref()
            .expect("evidenced Home must supply its physical seed");
        let seed_path = match seed {
            sandbox::HomeDriveSeedImage::Move(path) | sandbox::HomeDriveSeedImage::Copy(path) => {
                path
            }
        };
        assert_eq!(
            tokio::fs::read(seed_path).await.unwrap(),
            vec![0x5a; SIZE as usize]
        );
    } else if blank_available {
        assert!(
            created.is_empty(),
            "no-hint acceptance must retain the parked blank"
        );
    } else {
        assert_eq!(created.len(), 1);
        assert!(
            created[0].home_drive.as_ref().unwrap().seed_image.is_none(),
            "no-hint fresh preparation must not consume a hidden Home"
        );
    }
    execution.release_one();
    let completed = env.handle.wait_completion(successor, WAIT).await.unwrap();
    assert_eq!(completed.exit_code, 0);
    if blank_available {
        assert_eq!(completed.sandbox_id, blank_id);
    }
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}
