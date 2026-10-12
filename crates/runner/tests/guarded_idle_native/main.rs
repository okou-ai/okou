#![cfg(target_os = "linux")]

//! Opt-in packaged-guest terminal saving fixture; see README.md in this directory.

mod finalizing;
mod fixture;
mod pressure;
mod transitions;

use std::{error::Error, io, path::PathBuf, sync::Arc};

use runner_host::paths::RunnerPaths;
use runner_lifecycle::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageCache, HomeImagePromotionRequest,
};
use runner_lifecycle::home_mount::ensure_home_drive_mounted;
use runner_lifecycle::host_memory_operations::MemoryOperationError;
use runner_lifecycle::idle_pool::{
    DestroyOutcome, IdlePool, IdlePoolConfig, IdleRetirementBatchScope, ParkResult,
    test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_lifecycle::status::StatusTracker;
use runner_storage::storage_fingerprints::StorageFingerprints;
use runner_supervisor::idle_lifecycle::{
    GuardedIdlePressureRequest, IdleDestroyTracker, IdlePoolBatchRetirementRequest,
    IdlePressureRequest, IdlePressureSelection, select_idle_entries_for_guarded_pressure,
};
use runner_types::ids::RunId;
use sandbox::{
    FactoryConfig, RuntimeConfig, SandboxFactory, SandboxId, SandboxParkOutcome, SandboxRuntime,
    SnapshotRef,
};
use sandbox_firecracker::FirecrackerRuntime;
use tokio::sync::Notify;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const MISSING_GUEST_TIMEZONE: &str = "Etc/okou-test-missing-zone";

#[derive(Clone, Copy, Debug)]
enum NativeScope {
    Batch(IdleRetirementBatchScope),
    Logical,
    Replacement,
    Restore,
    Aged,
    CallerOwned,
    SpeculativeGuestFailure,
    FinalizingParked,
    FinalizingRunning,
    Pressure,
}

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
    for scope in [
        NativeScope::Batch(IdleRetirementBatchScope::Exact),
        NativeScope::Batch(IdleRetirementBatchScope::All),
        NativeScope::Logical,
        NativeScope::Replacement,
        NativeScope::Restore,
        NativeScope::Aged,
        NativeScope::CallerOwned,
        NativeScope::SpeculativeGuestFailure,
        NativeScope::FinalizingParked,
        NativeScope::FinalizingRunning,
        NativeScope::Pressure,
    ] {
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
            let result = exercise_retirement(factory.clone(), paths, inputs, scope).await;
            let mut factory = Arc::try_unwrap(factory)
                .map_err(|_| io::Error::other("native fixture lost its exclusive factory owner"))?;
            factory.shutdown().await;
            result?;
            println!("GUARDED_IDLE_TERMINAL_PASS restored={restored} scope={scope:?}");
        }
    }
    Ok(())
}

async fn exercise_retirement(
    factory: Arc<Box<dyn SandboxFactory>>,
    paths: RunnerPaths,
    inputs: &fixture::Inputs,
    scope: NativeScope,
) -> TestResult<()> {
    let status = Arc::new(StatusTracker::new(
        paths.base_dir().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await?;
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
    let (vcpu, memory) = match scope {
        NativeScope::Replacement | NativeScope::Restore => (4, 8192),
        NativeScope::Aged => (12, 24576),
        _ => (2, 4096),
    };
    let budget = Arc::new(ResourceBudget::new(vcpu, memory, 1.0, 0));
    if matches!(
        scope,
        NativeScope::FinalizingParked | NativeScope::FinalizingRunning
    ) {
        return finalizing::exercise(
            finalizing::Context {
                factory,
                cache,
                sandbox,
                home,
                budget,
                operations,
                rootfs_hash,
                run_id,
                sandbox_id,
                reuse_key,
            },
            inputs,
            matches!(scope, NativeScope::FinalizingRunning),
        )
        .await;
    }
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
        .with_history_generation_run_id(run_id)
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
    let parked = if matches!(scope, NativeScope::Aged) {
        pool.park_at_for_test(
            candidate,
            std::time::Instant::now() - std::time::Duration::from_secs(40 * 60),
        )
    } else {
        pool.park(candidate)
    };
    assert!(matches!(parked, ParkResult::Parked));
    let pool = Arc::new(tokio::sync::Mutex::new(pool));
    let retirement: TestResult<_> = async {
        match scope {
            NativeScope::Pressure => {
                pressure::exercise(&pool, &status, &tracker, &operations, inputs).await?;
                Ok(None)
            }
            NativeScope::FinalizingParked | NativeScope::FinalizingRunning => Err(io::Error::other("finalizing scope did not enter its producer transition").into()),
            NativeScope::CallerOwned | NativeScope::SpeculativeGuestFailure => {
                use runner_lifecycle::idle_pool::{
                    ActivationCleanupOutcome, GuardedSpeculativeIdleOwner, IdleActivationOwner,
                };
                // A successor cancelled before business activation still owns
                // its exact parked reservation and mandatory terminal saving.
                let reservation = pool
                    .lock()
                    .await
                    .take_reserved(&reuse_key)
                    .ok_or_else(|| io::Error::other("native caller reservation disappeared"))?;
                let mut owner = Some(if matches!(scope, NativeScope::SpeculativeGuestFailure) {
                    let mut speculative =
                        GuardedSpeculativeIdleOwner::new(reservation).map_err(|_| {
                            io::Error::other("native speculation received running handoff")
                        })?;
                    // Exercise a real fixed guest restore failure after unpark,
                    // before any business process. The deliberately absent zone
                    // must fail required timezone verification in the Executor.
                    let result = speculative
                        .prepare(RunId::new_v4(), |sandbox, _, _| {
                            Box::pin(async move {
                                runner_executor::executor::restore_guest_state_with_timezone(
                                    sandbox,
                                    MISSING_GUEST_TIMEZONE,
                                )
                                .await
                                .map_err(|e| e.to_string())
                            })
                        })
                        .await;
                    let expected_error = runner_executor::ExecutorError::Config(format!(
                        "guest timezone {MISSING_GUEST_TIMEZONE:?} is unavailable: /usr/share/zoneinfo/{MISSING_GUEST_TIMEZONE} is not a file"
                    ))
                    .to_string();
                    if result.as_ref().err() != Some(&expected_error) {
                        return Err(io::Error::other(format!(
                            "native speculative guest restore expected {expected_error:?}, got {result:?}"
                        ))
                        .into());
                    }
                    speculative.take_cleanup_owner()?
                } else {
                    IdleActivationOwner::new(reservation)
                        .map_err(|_| io::Error::other("native caller received running handoff"))?
                });
                let mut task = tracker
                    .retire_activation_owner(
                        &mut owner,
                        &operations,
                        inputs.envelope(),
                        "native_caller_cleanup",
                    )
                    .await?;
                assert!(owner.is_none());
                let outcome = task.join().await??;
                if !matches!(
                    outcome,
                    ActivationCleanupOutcome::Completed {
                        home_cache_promoted: true
                    }
                ) {
                    return Err(io::Error::other(format!(
                        "native caller required saving incomplete: {outcome:?}"
                    ))
                    .into());
                }
                tracker.close_and_wait().await;
                drop(task.take_completed_lease()?);
                if !tracker.take_retained_activation_owners()?.is_empty() {
                    return Err(io::Error::other("native caller retained uncertainty").into());
                }
                Ok(None)
            }
            NativeScope::Replacement | NativeScope::Restore | NativeScope::Aged => {
                transitions::exercise(
                    transitions::Context {
                        factory: factory.clone(),
                        pool: pool.clone(),
                        status: status.clone(),
                        operations: operations.clone(),
                        budget: budget.clone(),
                        tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(),
                        reuse_key: reuse_key.clone(),
                    },
                    inputs,
                    scope,
                )
                .await?;
                Ok(None)
            }
            NativeScope::Batch(scope) => {
                let mut task = tracker
                    .start_pool_retirement_batch(
                        pool.clone(),
                        status.clone(),
                        operations.clone(),
                        IdlePoolBatchRetirementRequest {
                            scope,
                            envelope: inputs.envelope(),
                            context: "native_guarded_idle",
                        },
                    )
                    .await?;
                let result = task.join().await?;
                if !result.is_complete() {
                    return Err(io::Error::other(format!(
                        "native guarded batch incomplete: {result:?}"
                    ))
                    .into());
                }
                assert_eq!(
                    (result.selected, result.completed, result.uncertain),
                    (1, 1, 0)
                );
                Ok(None)
            }
            NativeScope::Logical => {
                // Same physical authority reserves real replacement growth before
                // accepting old retirement. Logical transfer supplies no credit.
                let mut replacement = operations.request(inputs.replacement_plan()?)?;
                let permit = replacement.try_grant().await?;
                let mut result = select_idle_entries_for_guarded_pressure(
                    &pool,
                    &status,
                    &tracker,
                    &budget,
                    &operations,
                    Vec::new(),
                    GuardedIdlePressureRequest {
                        selection: IdlePressureRequest {
                            run_id: RunId::new_v4(),
                            reuse_key: None,
                            profile_name: fixture::PROFILE,
                            device_rate_limits: &None,
                            history_generation_run_id: None,
                            allow_compatible_blank: false,
                            blank_pool_diagnostics: None,
                            vcpu: 2,
                            memory_mb: 4096,
                            context: "native_guarded_logical",
                        },
                        envelope: inputs.envelope(),
                    },
                )
                .await;
                if !result.not_started.is_empty() || result.status_error.is_some() {
                    return Err(io::Error::other(format!(
                        "native logical refusal/status failure: {:?} / {:?}",
                        result.not_started, result.status_error
                    ))
                    .into());
                }
                let IdlePressureSelection::Fresh(lease) = result.selection else {
                    return Err(io::Error::other(
                        "native logical substitution did not return a full lease",
                    )
                    .into());
                };
                assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 4096));
                assert_eq!(result.retirements.len(), 1);
                // Prepare a different guest before joining old cleanup. Ordinary
                // external gates establish still-live overlap, without timing claims.
                let next_factory = factory.clone();
                let next_cache = cache.clone();
                let next_rootfs = rootfs_hash.clone();
                let work = permit.spawn(move |mut operation| async move {
                    let next_run = RunId::new_v4();
                    let next_id = SandboxId::new_v4();
                    let key = format!("thread:native-logical-replacement-{next_run}");
                    let mut home =
                        fixture::checkout(&next_cache, next_run, next_id, &key, &next_rootfs).await;
                    let mut next = next_factory
                        .create(fixture::sandbox_config(next_id, &mut home))
                        .await?;
                    let prepared: TestResult<()> = async {
                        let backing = next
                            .backing_process()
                            .ok_or_else(|| io::Error::other("replacement supplied no backing"))?;
                        operation.bind_backing(backing)?;
                        fixture::prepare_guest(&mut *next, next_run).await?;
                        loop {
                            match operation.complete_phase().await {
                                Ok(()) => break,
                                Err(MemoryOperationError::AccountingChanged) => {
                                    tokio::task::yield_now().await
                                }
                                Err(error) => return Err(error.into()),
                            }
                        }
                        Ok(())
                    }
                    .await;
                    next_factory.destroy(next).await;
                    prepared
                })?;
                work.join().await??;
                for task in &mut result.retirements {
                    let completion = task.join().await??;
                    if completion.outcome != DestroyOutcome::Completed
                        || !completion.home_cache_promoted
                    {
                        return Err(io::Error::other(
                            "native logical retirement did not prove complete saving",
                        )
                        .into());
                    }
                }
                Ok(Some(lease))
            }
        }
    }
    .await;
    let logical_lease = match retirement {
        Ok(lease) => lease,
        Err(error) => {
            let jobs = pool.lock().await.drain();
            for job in jobs {
                job.run_with_context("native_fixture_refused_batch_cleanup")
                    .await;
            }
            tracker.close_and_wait().await;
            return Err(error);
        }
    };
    assert!(pool.lock().await.is_empty());
    assert!(backing.exit_confirmed().await);
    tracker.close_and_wait().await;
    let report = operations.close_and_wait().await?;
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    drop(logical_lease);
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
