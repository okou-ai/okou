//! Real guarded park/restore/replenishment owners with supplied Fresh coverage.

use std::collections::BTreeMap;

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::host_memory_operations::{HostMemoryOperations, MemoryOperation};
use runner_lifecycle::idle_pool::{IdlePoolIncoming, ParkedIdleCandidate};
use runner_lifecycle::lifecycle::RunnerMode;
use runner_supervisor::blank_pool::{
    BlankPoolReplenisher, BlankPrepareResult, BlankProfile, GuardedBlankPoolRequest,
};
use runner_supervisor::idle_lifecycle::SharedIdlePool;
use sandbox::{ResourceLimits, SandboxConfig};

use super::*;

pub struct Context {
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub pool: SharedIdlePool,
    pub status: Arc<StatusTracker>,
    pub operations: HostMemoryOperations,
    pub budget: Arc<ResourceBudget>,
    pub tracker: IdleDestroyTracker,
    pub rootfs_hash: String,
    pub reuse_key: String,
}

pub async fn exercise(
    context: Context,
    inputs: &fixture::Inputs,
    scope: NativeScope,
) -> TestResult<()> {
    match scope {
        NativeScope::Replacement | NativeScope::Restore => {
            let candidate =
                prepare_incoming(&context, inputs, matches!(scope, NativeScope::Restore)).await?;
            let mut incoming = if matches!(scope, NativeScope::Restore) {
                let reservation = context
                    .pool
                    .lock()
                    .await
                    .take_reserved(&context.reuse_key)
                    .ok_or_else(|| io::Error::other("native exact reservation disappeared"))?;
                assert!(matches!(
                    context.pool.lock().await.park(candidate),
                    ParkResult::Parked
                ));
                match IdlePoolIncoming::restore(reservation) {
                    Ok(incoming) => incoming,
                    Err(_) => {
                        return Err(
                            io::Error::other("native restore returned running owner").into()
                        );
                    }
                }
            } else {
                IdlePoolIncoming::park(candidate)
            };
            incoming.capture_backing()?;
            let mut started = context
                .tracker
                .insert_pool_entry(
                    &context.pool,
                    &mut incoming,
                    &context.operations,
                    inputs.envelope(),
                    "native_guarded_insertion",
                )
                .await?;
            assert!(incoming.into_owner().is_none());
            let task = started.retirement.as_mut().ok_or_else(|| {
                io::Error::other("native insertion did not replace its original victim")
            })?;
            let completion = task.join().await??;
            if completion.outcome != DestroyOutcome::Completed
                || (matches!(scope, NativeScope::Replacement) && !completion.home_cache_promoted)
            {
                return Err(io::Error::other(
                    "native replacement did not prove required saving/exit",
                )
                .into());
            }
            drop(completion);
        }
        NativeScope::Aged => {
            let mut request = context.operations.request(inputs.replacement_plan()?)?;
            let permit = request.try_grant().await?;
            let envelope = inputs.envelope();
            let factory = context.factory.clone();
            let pool = context.pool.clone();
            let status = context.status.clone();
            let operations = context.operations.clone();
            let tracker = context.tracker.clone();
            let budget = context.budget.clone();
            let rootfs_hash = context.rootfs_hash.clone();
            let work = permit.spawn(move |mut operation| async move {
                let profiles = BTreeMap::from([(
                    fixture::PROFILE.into(),
                    BlankProfile {
                        vcpu: 2,
                        memory_mb: 4096,
                        rootfs_hash,
                        home_disk_mb: 16384,
                    },
                )]);
                let factories = BTreeMap::from([(fixture::PROFILE.into(), (factory, true))]);
                let admission = PreSpawnAdmission::new(2)?;
                let mut replenisher =
                    BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);
                let request = || GuardedBlankPoolRequest {
                    mode: RunnerMode::Running,
                    pool: &pool,
                    budget: &budget,
                    admission: &admission,
                    status: &status,
                    tracker: &tracker,
                    operations: &operations,
                    envelope,
                };
                replenisher.maybe_start_guarded(request()).await;
                let result = replenisher
                    .wait_for_preparation()
                    .await
                    .ok_or_else(|| io::Error::other("native aged preparation did not start"))?;
                let BlankPrepareResult::Ready {
                    candidate,
                    retired_exact: true,
                } = result
                else {
                    return Err(io::Error::other(
                        "native aged cleanup/preparation did not complete",
                    )
                    .into());
                };
                let mut incoming = IdlePoolIncoming::park(*candidate);
                incoming.capture_backing()?;
                operation.bind_backing(incoming.captured_backing()?)?;
                settle(&mut operation).await?;
                replenisher
                    .finish_guarded_preparation(&mut incoming, request())
                    .await?;
                assert!(incoming.into_owner().is_none());
                replenisher.shutdown(&tracker).await;
                Ok::<(), Box<dyn Error + Send + Sync>>(())
            })?;
            work.join().await??;
        }
        _ => return Err(io::Error::other("incorrect native transition scope").into()),
    }
    // Exact restore now owns the original required-home resource; replacement
    // and aged cases own their new physical inventory. Retire all through the
    // same guarded owner, never invent physical credit from status removal.
    let mut task = context
        .tracker
        .start_pool_retirement_batch(
            context.pool.clone(),
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_guarded_transition_final_inventory",
            },
        )
        .await?;
    let result = task.join().await?;
    if !result.is_complete() {
        return Err(
            io::Error::other(format!("native final inventory incomplete: {result:?}")).into(),
        );
    }
    Ok(())
}

async fn prepare_incoming(
    context: &Context,
    inputs: &fixture::Inputs,
    blank: bool,
) -> TestResult<ParkedIdleCandidate> {
    let mut request = context.operations.request(inputs.replacement_plan()?)?;
    let permit = request.try_grant().await?;
    let lease = ResourceBudget::try_reserve_lease(&context.budget, 2, 4096)
        .ok_or_else(|| io::Error::other("native incoming full logical lease unavailable"))?;
    let factory = context.factory.clone();
    let key = context.reuse_key.clone();
    let rootfs = context.rootfs_hash.clone();
    let work = permit.spawn(move |mut operation| async move {
        let id = SandboxId::new_v4();
        let mut sandbox = factory
            .create(SandboxConfig {
                id,
                resources: ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                home_drive: None,
            })
            .await?;
        let prepared: TestResult<()> = async {
            operation.bind_backing(
                sandbox
                    .backing_process()
                    .ok_or_else(|| io::Error::other("native incoming backing unavailable"))?,
            )?;
            sandbox.start().await?;
            if sandbox.park_for_blank_pool().await? != SandboxParkOutcome::Reusable {
                return Err(io::Error::other("native incoming could not physically park").into());
            }
            settle(&mut operation).await
        }
        .await;
        if let Err(error) = prepared {
            factory.destroy(sandbox).await;
            return Err(error);
        }
        let mut candidate = if blank {
            ParkedIdleCandidate::blank(
                sandbox,
                factory,
                lease,
                id,
                fixture::PROFILE.into(),
                rootfs,
                None,
            )
        } else {
            ParkedIdleCandidateBuilder::new(&key, lease)
                .with_sandbox(sandbox)
                .with_factory(factory)
                .with_sandbox_id(id)
                .with_profile_name(fixture::PROFILE)
                .with_rootfs_hash(&rootfs)
                .build()
        };
        candidate.capture_retirement_backing()?;
        Ok::<_, Box<dyn Error + Send + Sync>>(candidate)
    })?;
    work.join().await?
}

async fn settle(operation: &mut MemoryOperation) -> TestResult<()> {
    loop {
        match operation.complete_phase().await {
            Ok(()) => return Ok(()),
            Err(MemoryOperationError::AccountingChanged) => tokio::task::yield_now().await,
            Err(error) => return Err(error.into()),
        }
    }
}
