#![cfg(target_os = "linux")]

//! Opt-in packaged-guest terminal saving fixture; see README.md in this directory.

mod fixture;

use std::{error::Error, io, path::PathBuf, sync::Arc};

use runner_host::paths::RunnerPaths;
use runner_lifecycle::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageCache, HomeImagePromotionRequest,
};
use runner_lifecycle::home_mount::ensure_home_drive_mounted;
use runner_lifecycle::idle_pool::{
    DestroyOutcome, IdlePool, IdlePoolConfig, IdleSandboxIdentity, ParkResult,
    test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_storage::storage_fingerprints::StorageFingerprints;
use runner_supervisor::idle_lifecycle::{IdleDestroyTracker, IdlePoolRetirementRequest};
use runner_types::ids::RunId;
use sandbox::{
    FactoryConfig, RuntimeConfig, SandboxFactory, SandboxId, SandboxParkOutcome, SandboxRuntime,
    SnapshotRef,
};
use sandbox_firecracker::FirecrackerRuntime;
use tokio::sync::Notify;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires root, KVM, NBD, packaged guest artifacts and supplied measured policy"]
async fn guarded_terminal_saving_restores_home_without_private_runtime_bytes() -> TestResult<()> {
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::other("native idle fixture requires root").into());
    }
    let inputs = fixture::Inputs::load()?;
    let base = PathBuf::from(std::env::var("OKOU_TEST_RPC_BASE_DIR")?);
    std::fs::create_dir_all(&base)?;
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result = exercise_factories(&runtime, &base, &inputs).await;
    runtime.shutdown().await;
    result
}

async fn exercise_factories(
    runtime: &FirecrackerRuntime,
    base: &std::path::Path,
    inputs: &fixture::Inputs,
) -> TestResult<()> {
    for restored in [false, true] {
        // Never share a production Runner directory or another invocation's cache.
        let owned = tempfile::tempdir_in(base)?;
        let paths = RunnerPaths::new(owned.path().to_owned());
        let snapshot = if restored {
            Some(SnapshotRef {
                output_dir: PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?),
                hash: std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")?,
            })
        } else {
            None
        };
        let factory = runtime
            .create_factory(FactoryConfig {
                profile: fixture::PROFILE.into(),
                binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
                kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
                rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
                base_dir: owned.path().to_owned(),
                snapshot,
            })
            .await?;
        let factory = Arc::new(factory);
        let result = exercise_retirement(factory.clone(), paths, inputs).await;
        let mut factory = Arc::try_unwrap(factory)
            .map_err(|_| io::Error::other("native fixture lost its exclusive factory owner"))?;
        factory.shutdown().await;
        result?;
        println!("GUARDED_IDLE_TERMINAL_PASS restored={restored}");
    }
    Ok(())
}

async fn exercise_retirement(
    factory: Arc<Box<dyn SandboxFactory>>,
    paths: RunnerPaths,
    inputs: &fixture::Inputs,
) -> TestResult<()> {
    let cache = HomeImageCache::new(paths);
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = format!("thread:native-guarded-{run_id}");
    let rootfs_hash = std::env::var("OKOU_TEST_IDLE_ROOTFS_HASH")?;
    if rootfs_hash.is_empty() {
        return Err(io::Error::other("packaged rootfs hash must be supplied").into());
    }
    let operations = inputs.operations()?;
    let mut home = fixture::checkout(&cache, run_id, sandbox_id, &reuse_key, &rootfs_hash).await;
    let mut sandbox = factory
        .create(fixture::sandbox_config(sandbox_id, &mut home))
        .await?;
    let prepared = fixture::prepare_guest(&mut *sandbox, run_id).await;
    if let Err(error) = prepared {
        factory.destroy(sandbox).await;
        return Err(error);
    }
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let parked: TestResult<_> = async {
        let backing = sandbox
            .backing_process()
            .ok_or_else(|| io::Error::other("Firecracker supplied no exact backing capability"))?;
        if sandbox.park().await? != SandboxParkOutcome::Reusable {
            return Err(io::Error::other("native fixture could not physically park").into());
        }
        let promotion = home
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: chrono::Utc::now().to_rfc3339(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .ok_or_else(|| io::Error::other("native fixture could not own home saving"))?;
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).ok_or_else(|| {
            io::Error::other("native fixture could not acquire its logical lease")
        })?;
        Ok((backing, promotion, lease))
    }
    .await;
    let (backing, promotion, lease) = match parked {
        Ok(parked) => parked,
        Err(error) => {
            factory.destroy(sandbox).await;
            return Err(error);
        }
    };
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    let mut candidate = ParkedIdleCandidateBuilder::new(&reuse_key, lease)
        .with_sandbox(sandbox)
        .with_factory(factory.clone())
        .with_sandbox_id(sandbox_id)
        .with_profile_name(fixture::PROFILE)
        .with_rootfs_hash(&rootfs_hash)
        .with_home_promotion(promotion)
        .build();
    if let Err(error) = candidate.capture_retirement_backing() {
        // Explicit disposal of this invocation's native fixture, never a
        // production guarded-admission fallback.
        let (payload, lease) = candidate.into_active_destroy_parts();
        tracker
            .spawn_payload_retaining_lease(payload, lease, "native_fixture_capture_cleanup")
            .join()
            .await?;
        return Err(error.into());
    }
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let candidate = pool.retirement_candidate(&IdleSandboxIdentity::Exact(reuse_key.clone()))?;
    let pool = Arc::new(tokio::sync::Mutex::new(pool));
    let mut task = match tracker
        .retire_pool_entry(
            &pool,
            &operations,
            IdlePoolRetirementRequest {
                candidate,
                envelope: inputs.envelope(),
                context: "native_guarded_idle",
            },
        )
        .await
    {
        Ok(started) => {
            assert!(started.snapshot.idle_sandboxes.is_empty());
            started.task
        }
        Err(error) => {
            let jobs = pool.lock().await.drain();
            for job in jobs {
                job.run_with_context("native_fixture_admission_cleanup")
                    .await;
            }
            return Err(error.into());
        }
    };
    let result = task.join().await??;
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    assert!(result.home_cache_promoted);
    assert!(backing.exit_confirmed().await);
    drop(result.budget_lease);
    tracker.close_and_wait().await;
    let report = operations.close_and_wait().await?;
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    assert_eq!(budget.allocated(), (0, 0, 0));
    let next_run = RunId::new_v4();
    let next_id = SandboxId::new_v4();
    let mut restored = fixture::checkout(&cache, next_run, next_id, &reuse_key, &rootfs_hash).await;
    assert!(restored.is_cache_hit());
    let mut sandbox = factory
        .create(fixture::sandbox_config(next_id, &mut restored))
        .await?;
    let checked = async {
        sandbox.bind_run_control(&next_run.to_string())?;
        sandbox.start().await?;
        ensure_home_drive_mounted(&*sandbox, next_run)
            .await
            .map_err(|failure| failure.error)?;
        fixture::verify_saved_guest(&*sandbox, run_id).await
    }
    .await;
    factory.destroy(sandbox).await;
    checked
}
