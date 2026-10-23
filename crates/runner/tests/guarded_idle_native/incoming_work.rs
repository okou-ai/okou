//! Actual incoming owners retain their distinct restoration and aged ordering.

use std::collections::BTreeMap;

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::host_memory_operations::{MemoryGrowthPermit, MemoryOperation};
use runner_lifecycle::idle_pool::{ActivationCleanupOutcome, IdlePoolIncoming};
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::BudgetLease;
use runner_supervisor::blank_pool::{
    BlankPoolReplenisher, BlankPrepareResult, BlankProfile, GuardedBlankPoolRequest,
};
use runner_supervisor::idle_lifecycle::{GuardedActivationCleanupTask, IdlePoolRetirementRequest};
use sandbox::SandboxBackingProcess;
use serde_json::{Value, json};

use super::*;

pub struct Setup {
    incoming: Option<IdlePoolIncoming>,
    permit: Option<MemoryGrowthPermit>,
    backing: Option<Arc<dyn SandboxBackingProcess>>,
    preparation: Value,
    pub grant: Value,
    pub incoming_id: Option<SandboxId>,
}

pub fn kind(scope: NativeScope) -> TestResult<&'static str> {
    Ok(match scope {
        NativeScope::Replacement => "Replacement",
        NativeScope::Restore => "Restore",
        NativeScope::Aged => "Aged",
        _ => return Err(io::Error::other("incorrect incoming corpus scope").into()),
    })
}

pub async fn prepare(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
    scope: NativeScope,
    source: &recovery_source::Source,
    proof: &Arc<evidence::Case>,
) -> TestResult<Setup> {
    let first = source.samples()?.len();
    if matches!(scope, NativeScope::Aged) {
        let started = evidence::clocks()?.0;
        let mut request = context.operations.request(inputs.replacement_plan()?)?;
        let permit = request.try_grant().await?;
        let finished = evidence::clocks()?.0;
        let id = permit
            .id()
            .ok_or_else(|| io::Error::other("aged Fresh permit missing"))?;
        return Ok(Setup {
            incoming: None,
            permit: Some(permit),
            backing: None,
            preparation: Value::Null,
            incoming_id: None,
            grant: json!({"started_ns": started, "finished_ns": finished,
                "operation_id": id.generation().to_string(), "samples": source.samples()?.into_iter().skip(first).collect::<Vec<_>>()}),
        });
    }
    let prepared = transitions::prepare_observed_incoming(
        context,
        inputs,
        matches!(scope, NativeScope::Restore),
    )
    .await?;
    let start = prepared.receipt.grant_started_ns;
    let finish = prepared.receipt.grant_finished_ns;
    let grant = json!({"started_ns": start, "finished_ns": finish,
        "operation_id": prepared.receipt.operation_id, "samples": source.samples()?.into_iter().skip(first)
            .filter(|sample| sample.get("started_ns").and_then(Value::as_u64).is_some_and(|n| n >= start)
                && sample.get("finished_ns").and_then(Value::as_u64).is_some_and(|n| n <= finish)).collect::<Vec<_>>()});
    let mut incoming = if matches!(scope, NativeScope::Restore) {
        let mut pool = context.pool.lock().await;
        let reservation = pool
            .take_reserved(&context.reuse_key)
            .ok_or_else(|| io::Error::other("incoming original reservation missing"))?;
        let parked = pool.park(prepared.candidate);
        if !matches!(parked, ParkResult::Parked) {
            proof.retain(reservation);
            proof.retain(parked);
            return Err(io::Error::other("incoming competing blank refused").into());
        }
        drop(pool);
        match IdlePoolIncoming::restore(reservation) {
            Ok(incoming) => incoming,
            Err(owner) => {
                proof.retain(owner);
                return Err(io::Error::other("original restore owner is running").into());
            }
        }
    } else {
        IdlePoolIncoming::park(prepared.candidate)
    };
    if let Err(error) = incoming.capture_backing() {
        proof.retain(incoming);
        return Err(error.into());
    }
    Ok(Setup {
        incoming_id: incoming.sandbox_id(),
        incoming: Some(incoming),
        permit: None,
        backing: Some(prepared.backing),
        preparation: serde_json::to_value(prepared.receipt)?,
        grant,
    })
}

pub struct Request {
    pub context: transitions::Context,
    pub inputs: fixture::Inputs,
    pub scope: NativeScope,
    pub setup: Setup,
    pub proof: Arc<evidence::Case>,
    pub original: Arc<dyn SandboxBackingProcess>,
    pub pool_wait: tokio::sync::oneshot::Sender<u64>,
    pub join_wait: tokio::sync::oneshot::Sender<u64>,
}

async fn pending<T>(
    future: impl std::future::Future<Output = T>,
    sender: tokio::sync::oneshot::Sender<u64>,
) -> TestResult<T> {
    tokio::pin!(future);
    if futures_util::poll!(&mut future).is_ready() {
        return Err(io::Error::other("incoming dependency did not poll Pending").into());
    }
    sender
        .send(evidence::clocks()?.0)
        .map_err(|_| io::Error::other("incoming wait observer lost"))?;
    Ok(future.await)
}

async fn complete(
    task: &mut GuardedActivationCleanupTask,
    wait: Option<tokio::sync::oneshot::Sender<u64>>,
) -> TestResult<BudgetLease> {
    let result = match wait {
        Some(wait) => pending(task.join(), wait).await???,
        None => task.join().await??,
    };
    if !matches!(result, ActivationCleanupOutcome::Completed { .. }) {
        return Err(io::Error::other("incoming cleanup did not complete").into());
    }
    Ok(task.take_completed_lease()?)
}

async fn retire_inventory(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
    wait: Option<tokio::sync::oneshot::Sender<u64>>,
) -> TestResult<BudgetLease> {
    let mut selections = context
        .pool
        .lock()
        .await
        .retirement_batch(IdleRetirementBatchScope::All);
    if selections.len() != 1 {
        return Err(io::Error::other("incoming final inventory is not singular").into());
    }
    let (_, _, candidate) = selections.remove(0).into_parts();
    let mut started = context
        .tracker
        .retire_pool_entry(
            &context.pool,
            &context.operations,
            IdlePoolRetirementRequest {
                candidate: candidate?,
                envelope: inputs.envelope(),
                context: "native_incoming_final",
            },
        )
        .await?;
    context.status.set_idle_snapshot(started.snapshot).await?;
    complete(&mut started.task, wait).await
}

pub async fn exercise(request: Request) -> TestResult<BudgetLease> {
    let Request {
        context,
        inputs,
        scope,
        mut setup,
        proof,
        original,
        pool_wait,
        join_wait,
    } = request;
    let mut retained_lease = None;
    let outcome: TestResult<()> = async {
        let (prepared, backing, incoming_id, incoming_backing) = if matches!(scope, NativeScope::Aged) {
            let permit = setup.permit.take().ok_or_else(|| io::Error::other("aged Fresh consumed"))?;
            let inner = context.clone(); let measured = proof.clone();
            let work = permit.spawn(move |mut operation| async move {
                aged(&inner, &inputs, &measured, &mut operation, pool_wait, join_wait).await
            })?;
            let (prepared, backing, lease, id) = work.join().await??;
            retained_lease = Some(lease);
            (prepared, backing.clone(), id, backing.identity().generation().to_string())
        } else {
            let incoming = setup.incoming.as_mut().ok_or_else(|| io::Error::other("incoming capsule missing"))?;
            let incoming_id = incoming.sandbox_id().ok_or_else(|| io::Error::other("incoming identity missing"))?;
            let incoming_backing = incoming.captured_backing()?.identity().generation().to_string();
            let mut started = pending(context.tracker.insert_pool_entry(&context.pool, incoming,
                &context.operations, inputs.envelope(), "native_incoming_insert"), pool_wait).await??;
            if setup.incoming.take().and_then(IdlePoolIncoming::into_owner).is_some() {
                return Err(io::Error::other("incoming capsule did not transfer").into());
            }
            if !context.pool.lock().await.contains_sandbox_id(incoming_id) {
                return Err(io::Error::other("incoming original identity not installed").into());
            }
            context.status.set_idle_snapshot(started.snapshot).await?;
            let task = started.retirement.as_mut().ok_or_else(|| io::Error::other("incoming victim cleanup missing"))?;
            if matches!(scope, NativeScope::Restore) {
                drop(complete(task, None).await?);
                retained_lease = Some(retire_inventory(&context, &inputs, Some(join_wait)).await?);
            } else {
                retained_lease = Some(complete(task, Some(join_wait)).await?);
                drop(retire_inventory(&context, &inputs, None).await?);
            }
            (setup.preparation.clone(), setup.backing.take().ok_or_else(|| io::Error::other("new backing missing"))?, incoming_id, incoming_backing)
        };
        if backing.identity() == original.identity() || !backing.exit_confirmed().await
            || !original.exit_confirmed().await || context.budget.allocated() != (2,4096,1)
            || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("incoming exact backing/full original custody incomplete").into());
        }
        if (matches!(scope, NativeScope::Restore)) != (incoming_backing == original.identity().generation().to_string()) {
            return Err(io::Error::other("incoming restored a different original owner").into());
        }
        proof.require_full_lease()?;
        proof.incoming_witness("incoming_completed", json!({
            "kind": kind(scope)?, "preparation": prepared, "fresh_grant": setup.grant,
            "incoming_sandbox_id": incoming_id.to_string(), "incoming_backing_generation": incoming_backing,
            "new_backing_generation": backing.identity().generation().to_string(),
            "new_backing_exit_confirmed": true, "original_exit_confirmed": true,
            "original_owner_restored": matches!(scope, NativeScope::Restore),
            "separate_incoming_lease": !matches!(scope, NativeScope::Aged),
            "original_full_lease_retained": true, "allocated": context.budget.allocated(),
        }))?;
        Ok(())
    }.await;
    if let Err(error) = outcome {
        proof.retain(setup);
        proof.retain(retained_lease);
        return Err(error);
    }
    retained_lease.ok_or_else(|| io::Error::other("incoming final original lease missing").into())
}

async fn aged(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    operation: &mut MemoryOperation,
    pool_wait: tokio::sync::oneshot::Sender<u64>,
    join_wait: tokio::sync::oneshot::Sender<u64>,
) -> TestResult<(
    Value,
    Arc<dyn SandboxBackingProcess>,
    BudgetLease,
    SandboxId,
)> {
    let profiles = BTreeMap::from([(
        fixture::PROFILE.into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: context.rootfs_hash.clone(),
            home_disk_mb: fixture::HOME_DISK_MB,
        },
    )]);
    let factories = BTreeMap::from([(fixture::PROFILE.into(), (context.factory.clone(), true))]);
    let admission = PreSpawnAdmission::new(2)?;
    let mut replenisher =
        BlankPoolReplenisher::new(&profiles, &factories, &context.budget, 1, None);
    let request = || GuardedBlankPoolRequest {
        mode: RunnerMode::Running,
        pool: &context.pool,
        budget: &context.budget,
        admission: &admission,
        status: &context.status,
        tracker: &context.tracker,
        operations: &context.operations,
        envelope: inputs.envelope(),
    };
    let mut incoming = None;
    let outcome: TestResult<_> = async {
        pending(replenisher.maybe_start_guarded(request()), pool_wait).await?;
        let result = pending(replenisher.wait_for_preparation(), join_wait).await?
            .ok_or_else(|| io::Error::other("aged preparation not scheduled"))?;
        let BlankPrepareResult::Ready { candidate, retired_exact: true } = result else {
            proof.retain(result); return Err(io::Error::other("aged actual preparation incomplete").into());
        };
        let capsule = incoming.insert(IdlePoolIncoming::park(*candidate));
        capsule.capture_backing()?;
        let id = capsule.sandbox_id().ok_or_else(|| io::Error::other("aged new identity missing"))?;
        let backing = capsule.captured_backing()?;
        let operation_id = operation.id().ok_or_else(|| io::Error::other("aged physical phase missing"))?;
        operation.bind_backing(backing.clone())?;
        loop { match operation.complete_phase().await {
            Ok(()) => break,
            Err(MemoryOperationError::AccountingChanged) => tokio::task::yield_now().await,
            Err(error) => return Err(error.into()),
        }}
        let prepared = json!({"sandbox_id": id.to_string(), "backing_generation": backing.identity().generation().to_string(),
            "operation_id": operation_id.generation().to_string(),
            "prepared_ns": evidence::clocks()?.0, "phase_settled": true, "retired_exact": true,
            "original_lease_reused": true});
        replenisher.finish_guarded_preparation(capsule, request()).await?;
        if incoming.take().and_then(IdlePoolIncoming::into_owner).is_some() {
            return Err(io::Error::other("aged new blank did not transfer").into());
        }
        let lease = retire_inventory(context, inputs, None).await?;
        Ok((prepared, backing, lease, id))
    }.await;
    // The original accepted cleanup and a returned incoming owner never depend
    // on the observation future's lifetime. Shutdown precedes dependent teardown.
    replenisher.shutdown(&context.tracker).await;
    if outcome.is_err() {
        proof.retain(incoming);
    }
    outcome
}
