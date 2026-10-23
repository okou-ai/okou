//! Actual foreground Fresh and original exact-reuse work under the shared P2.

use runner_lifecycle::host_memory_operations::{MemoryOperation, MemoryOperationPlan};
use runner_lifecycle::idle_pool::IdleActivationOwner;
use runner_supervisor::idle_lifecycle::add_preparing_run_with_idle_status_snapshot;
use sandbox::{ResourceLimits, SandboxBackingProcess, SandboxConfig};
use serde_json::json;

use super::*;

pub struct Request {
    pub context: transitions::Context,
    pub plan: MemoryOperationPlan,
    pub preparation_bytes: u64,
    pub envelope: runner_lifecycle::idle_pool::IdleRetirementEnvelope,
    pub proof: Arc<evidence::Case>,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub original: RunId,
    pub fresh: bool,
    pub pool_wait: tokio::sync::oneshot::Sender<()>,
    pub status_wait: tokio::sync::oneshot::Sender<()>,
}

/// Publish only after the real dependency future has positively returned Pending.
async fn held<T>(
    future: impl std::future::Future<Output = T>,
    entered: tokio::sync::oneshot::Sender<()>,
) -> TestResult<T> {
    tokio::pin!(future);
    if futures_util::poll!(&mut future).is_ready() {
        return Err(io::Error::other("native foreground dependency was not held").into());
    }
    entered
        .send(())
        .map_err(|_| io::Error::other("native foreground wait observer disappeared"))?;
    Ok(future.await)
}

#[derive(serde::Serialize)]
pub struct Completion {
    pub sandbox_id: SandboxId,
    pub run_id: RunId,
    pub operation_id: String,
    pub backing_generation: String,
    pub backing_exit_confirmed: bool,
}

/// Complete only this foreground owner; other accepted inventory remains owned.
pub async fn prepare(request: Request) -> TestResult<Completion> {
    let Request {
        context,
        plan,
        preparation_bytes,
        envelope: _,
        proof,
        backing,
        original,
        fresh,
        pool_wait,
        status_wait,
    } = request;
    let run = RunId::new_v4();
    let (reservation, snapshot) = {
        let mut pool = held(context.pool.lock(), pool_wait).await?;
        let reservation = if fresh {
            if pool
                .take_reserved(&format!("thread:native-foreground-{run}"))
                .is_some()
            {
                return Err(
                    io::Error::other("native fresh lookup unexpectedly reused an owner").into(),
                );
            }
            None
        } else {
            Some(
                pool.take_reserved(&context.reuse_key)
                    .ok_or_else(|| io::Error::other("native exact foreground owner disappeared"))?,
            )
        };
        (reservation, pool.status_snapshot())
    };
    let id = match &reservation {
        Some(owner) => owner.sandbox_id(),
        None => SandboxId::new_v4(),
    };
    let plan = if fresh {
        plan
    } else {
        MemoryOperationPlan::Resume {
            memory_mib: 4096,
            preparation_bytes,
            backing: backing.clone(),
        }
    };
    let admission = async {
        held(
            add_preparing_run_with_idle_status_snapshot(&context.status, run, id, snapshot),
            status_wait,
        )
        .await??;
        let mut request = context.operations.request(plan)?;
        let mut permit = request.try_grant().await?;
        permit.refresh().await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(permit)
    }
    .await;
    let permit = match admission {
        Ok(permit) => permit,
        Err(error) => {
            proof.retain(reservation);
            return Err(error);
        }
    };
    let operation_id = permit
        .id()
        .ok_or_else(|| io::Error::other("native foreground permit missing"))?;
    let work_context = context.clone();
    let work_proof = proof.clone();
    let work = permit.spawn(move |mut operation| async move {
        let context = work_context;
        let completed_backing;
        let backing_exit_confirmed;
        if fresh {
            let lease = ResourceBudget::try_reserve_lease(&context.budget, 2, 4096)
                .ok_or_else(|| io::Error::other("native foreground full profile does not fit"))?;
            let mut sandbox = context
                .factory
                .create(SandboxConfig {
                    id,
                    resources: ResourceLimits {
                        cpu_count: 2,
                        memory_mb: 4096,
                    },
                    device_rate_limits: None,
                    home_drive: Some(sandbox::HomeDriveConfig {
                        size_mb: fixture::HOME_DISK_MB,
                        seed_image: None,
                        space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
                    }),
                })
                .await?;
            let checked: TestResult<()> = async {
                sandbox.bind_run_control(&run.to_string())?;
                sandbox.start().await?;
                let actual = sandbox
                    .backing_process()
                    .ok_or_else(|| io::Error::other("native foreground Fresh backing missing"))?;
                if actual.identity() == backing.identity() {
                    return Err(io::Error::other("native Fresh reused the original backing").into());
                }
                operation.bind_backing(actual.clone())?;
                if fixture::exec(&*sandbox, "printf native-foreground-ready").await?
                    != b"native-foreground-ready"
                {
                    return Err(
                        io::Error::other("native Fresh foreground RPC did not complete").into(),
                    );
                }
                settle(&mut operation).await?;
                Ok(())
            }
            .await;
            let actual = sandbox.backing_process();
            context.factory.destroy(sandbox).await;
            let exited = match &actual {
                Some(actual) => actual.exit_confirmed().await,
                None => false,
            };
            if !exited {
                work_proof.retain(actual);
                work_proof.retain(lease);
                return Err(
                    io::Error::other("native Fresh backing did not positively exit").into(),
                );
            }
            checked?;
            completed_backing = actual
                .as_ref()
                .ok_or_else(|| io::Error::other("native Fresh completion backing missing"))?
                .identity()
                .generation()
                .to_string();
            backing_exit_confirmed = true;
            drop(lease);
        } else {
            let reservation =
                reservation.ok_or_else(|| io::Error::other("native reuse reservation missing"))?;
            let mut owner = match IdleActivationOwner::new(reservation) {
                Ok(owner) => owner,
                Err(reservation) => {
                    work_proof.retain(reservation);
                    return Err(
                        io::Error::other("native reuse was not a parked original owner").into(),
                    );
                }
            };
            let (reused, lease) = match owner.activate(run).await {
                Ok(reused) => reused,
                Err(error) => {
                    work_proof.retain(owner);
                    return Err(io::Error::other(error).into());
                }
            };
            let mut parts = (*reused).into_parts();
            let checked: TestResult<()> = async {
                let actual = parts
                    .sandbox
                    .backing_process()
                    .ok_or_else(|| io::Error::other("native reuse backing missing"))?;
                if actual.identity() != backing.identity()
                    || (lease.vcpu(), lease.memory_mb()) != (2, 4096)
                {
                    return Err(io::Error::other(
                        "native reuse lost its original backing/full lease",
                    )
                    .into());
                }
                let expected = continuation::digest(&fixture::home_payload(original));
                let bytes =
                    fixture::exec(&*parts.sandbox, "sha256sum /home/user/guarded-idle-payload")
                        .await?;
                if std::str::from_utf8(&bytes)?.split_whitespace().next() != Some(expected.as_str())
                {
                    return Err(io::Error::other(
                        "native reuse changed complete original home data",
                    )
                    .into());
                }
                settle(&mut operation).await?;
                // Return this synthetic read-only foreground command to its original
                // fixture identity and promotion owner for the required saving proof.
                if parts.sandbox.park().await? != SandboxParkOutcome::Reusable {
                    return Err(io::Error::other(
                        "native reuse could not repark its original owner",
                    )
                    .into());
                }
                parts.sandbox.bind_run_control(&original.to_string())?;
                if parts.home_promotion.is_none() {
                    return Err(
                        io::Error::other("native reuse lost original home promotion").into(),
                    );
                }
                Ok(())
            }
            .await;
            if let Err(error) = checked {
                work_proof.retain(parts);
                work_proof.retain(lease);
                return Err(error);
            }
            let promotion = parts
                .home_promotion
                .ok_or_else(|| io::Error::other("native reuse lost original home promotion"))?;
            let mut candidate = ParkedIdleCandidateBuilder::new(&context.reuse_key, lease)
                .with_source_run_id(original)
                .with_sandbox(parts.sandbox)
                .with_factory(context.factory.clone())
                .with_sandbox_id(id)
                .with_profile_name(fixture::PROFILE)
                .with_rootfs_hash(&context.rootfs_hash)
                .with_source_run_id(original)
                .with_native_generation_run_id(original)
                .with_home_promotion(promotion)
                .build();
            if let Err(error) = candidate.capture_retirement_backing() {
                work_proof.retain(candidate);
                return Err(error.into());
            }
            let parked = context.pool.lock().await.park(candidate);
            if !matches!(parked, ParkResult::Parked) {
                work_proof.retain(parked);
                return Err(io::Error::other("native reuse original repark was rejected").into());
            }
            completed_backing = backing.identity().generation().to_string();
            backing_exit_confirmed = false;
        }
        context.status.remove_run_if_matching(run, id).await?;
        work_proof.foreground_witness(
            "foreground_prepared",
            json!({
                "kind": if fresh {"Fresh"} else {"Reuse"}, "sandbox_id": id.to_string(),
                "run_id": run.to_string(), "operation_id": operation_id.generation().to_string(),
                "guest_rpc_completed": true, "phase_settled": true,
                "original_owner_preserved": true, "allocated": context.budget.allocated(),
            }),
        )?;
        Ok::<_, Box<dyn Error + Send + Sync>>(Completion {
            sandbox_id: id,
            run_id: run,
            operation_id: operation_id.generation().to_string(),
            backing_generation: completed_backing,
            backing_exit_confirmed,
        })
    })?;
    work.join().await?
}

pub async fn exercise(request: Request) -> TestResult<()> {
    let context = request.context.clone();
    let envelope = request.envelope;
    prepare(request).await?;
    let mut saving = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope,
                context: "native_foreground_original_required_saving",
            },
        )
        .await?;
    let result = saving.join().await?;
    if !result.is_complete() || result.selected != 1 || result.completed != 1 {
        return Err(io::Error::other(format!(
            "native foreground original saving incomplete: {result:?}"
        ))
        .into());
    }
    Ok(())
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
