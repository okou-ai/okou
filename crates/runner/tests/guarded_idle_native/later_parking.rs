//! A captured retirement batch must publish the newer live inventory.

use std::{path::Path, time::Duration};

use runner_lifecycle::idle_pool::IdlePoolIncoming;
use serde_json::{Value, json};

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

async fn read_status(path: &Path) -> TestResult<Value> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other("later parking status is not a regular file").into());
    }
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

async fn start(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
) -> Result<
    runner_supervisor::idle_lifecycle::IdleCleanupTask<
        runner_supervisor::idle_lifecycle::IdlePoolRetirementBatchReport,
    >,
    MemoryOperationError,
> {
    context
        .tracker
        .start_pool_retirement_batch(
            context.pool.clone(),
            context.status.clone(),
            context.operations.clone(),
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_later_parking",
            },
        )
        .await
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    original: Arc<dyn sandbox::SandboxBackingProcess>,
    blank: bool,
) -> TestResult<()> {
    let status_path = directory.join("status.json");
    let initial = context.pool.lock().await.status_snapshot();
    context.status.set_idle_snapshot(initial).await?;
    let published = read_status(&status_path).await?;
    let gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(gate.clone())?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let mut later_context = context.clone();
    later_context.reuse_key = format!("thread:native-later-{}", RunId::new_v4());
    // This accepted preparation owns its output until join; never cancel it
    // inside the bounded contention scenario below.
    let prepared = transitions::prepare_observed_incoming(&later_context, inputs, blank).await;
    let prepared = match prepared {
        Ok(value) => value,
        Err(error) => {
            probe.finish().await?;
            return Err(error);
        }
    };
    let later_backing = prepared.backing;
    let preparation = prepared.receipt;
    let mut incoming = Some(IdlePoolIncoming::park(prepared.candidate));
    let mut batch = match start(&context, inputs).await {
        Ok(value) => value,
        Err(error) => {
            proof.retain(incoming.take().and_then(IdlePoolIncoming::into_owner));
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let mut completion = Box::pin(batch.join());
    let mut completed = None;
    let mut pool_hold = None;
    let mut status_hold = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        gate.wait_entered().await?;
        pending(completion.as_mut(), &mut completed).await?;
        if context.budget.allocated() != (4,8192,2) {
            return Err(io::Error::other("later parking lost a full lease").into());
        }
        let original_entries = context.pool.lock().await.status_snapshot();
        if !original_entries.idle_sandboxes.is_empty() || !original_entries.blank_sandboxes.is_empty() {
            return Err(io::Error::other("original batch did not detach its captured selection").into());
        }
        proof.later_parking_witness("tail_blocked", json!({
            "policy": serde_json::to_value(inputs)?, "published_status": published,
            "status_path": status_path, "receiver_polled_pending": true,
            "preparation": preparation, "later_reuse_key": later_context.reuse_key,
            "blank": blank, "profile_name": fixture::PROFILE,
            "coverage": coverage(&context, inputs, proof, false)?,
        }))?;
        let inserted_ns = evidence::clocks()?.0;
        let candidate = incoming.as_mut().ok_or_else(|| io::Error::other("later owner missing"))?;
        let mut inserted = context.tracker.insert_pool_entry(&context.pool, candidate,
            &context.operations, inputs.envelope(), "native_later_insert").await?;
        // Preserve any unexpected accepted retirement and join it before refusal.
        if let Some(task) = inserted.retirement.as_mut() {
            let result = task.join().await;
            proof.retain(task.take_completed_lease());
            result??;
            return Err(io::Error::other("later parking unexpectedly replaced a victim").into());
        }
        if let Some(owner) = incoming.take().and_then(IdlePoolIncoming::into_owner) {
            proof.retain(owner);
            return Err(io::Error::other("later parking did not consume its owner").into());
        }
        let revision = inserted.snapshot.revision;
        let id: SandboxId = preparation.sandbox_id.parse()?;
        pool_hold = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        if !pool_hold.as_ref().is_some_and(|pool| pool.contains_sandbox_id(id)) {
            return Err(io::Error::other("later inventory missing after insertion").into());
        }
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        let mut waits = context.status.idle_snapshot_waits_for_test();
        let before = *waits.borrow_and_update();
        probe.request()?;
        {
            let heartbeat = probe.complete();
            tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("later heartbeat ignored held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observation = foreground_probe::observe().await?;
        proof.later_parking_witness("pool_wait_progress", json!({
            "inserted_ns": inserted_ns, "revision": revision,
            "pool_held_ns": pool_held_ns, "status_held_ns": status_held_ns,
            "heartbeat_pending_ns": heartbeat_pending_ns, "heartbeat_polled_pending": true,
            "observer": observation, "coverage": coverage(&context, inputs, proof, false)?,
        }))?;
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let heartbeat = probe.complete().await?;
        pending(completion.as_mut(), &mut completed).await?;
        proof.later_parking_witness("tail_wait_progress", json!({
            "pool_released_ns": pool_released_ns, "heartbeat": heartbeat,
            "receiver_polled_pending": true, "coverage": coverage(&context, inputs, proof, false)?,
        }))?;
        let io_released_ns = evidence::clocks()?.0;
        gate.release()?;
        while *waits.borrow_and_update() == before { waits.changed().await?; }
        let after = *waits.borrow();
        let status_wait_polled_ns = evidence::clocks()?.0;
        if after != before + 1 || context.budget.allocated() != (2,4096,1)
            || !original.exit_confirmed().await {
            return Err(io::Error::other("later parking final wait lost exact original completion").into());
        }
        proof.require_original_lease_released()?;
        if futures_util::poll!(Box::pin(later_backing.exit_confirmed()).as_mut()).is_ready() {
            return Err(io::Error::other("later backing completed in the original batch").into());
        }
        // The result receiver can wake before the producer drops its final
        // tracking token. Observe that completion without closing admission,
        // which is still needed for the separate later batch below.
        while context.operations.snapshot()?.tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
        let idle = accounting(&context.operations.snapshot()?);
        let zero = json!({"registered_operations":0,"queued":0,"granted":0,"started":0,
            "uncertain":0,"ordinary_growth_bytes":0,"cleanup_growth_bytes":0,"tracked_tasks":0,"closed":false});
        if idle != zero { return Err(io::Error::other("later preparation/retirement did not settle open accounting").into()); }
        pending(completion.as_mut(), &mut completed).await?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        proof.later_parking_witness("status_wait_progress", json!({
            "io_released_ns": io_released_ns, "status_wait_polled_ns": status_wait_polled_ns,
            "status_waits_before": before, "status_waits_after": after,
            "receiver_polled_pending": true, "original_exit_confirmed": true,
            "original_lease_released": true, "later_exit_polled_pending": true,
            "allocated": context.budget.allocated(), "accounting": idle, "heartbeat": heartbeat,
        }))?;
        let status_released_ns = evidence::clocks()?.0;
        drop(status_hold.take());
        let report = completed.insert(completion.as_mut().await);
        let report = report.as_ref().map_err(|e| io::Error::other(e.to_string()))?;
        let batch_joined_ns = evidence::clocks()?.0;
        if (report.selected,report.completed,report.uncertain) != (1,1,0) || !report.is_complete() {
            return Err(io::Error::other("original fixed batch did not complete exactly its selection").into());
        }
        let current = context.pool.lock().await.status_snapshot();
        let expected = if blank { json!({"blank_sandboxes":[{"sandbox_id":id}]}) }
            else { json!({"idle_sandboxes":[{"reuse_key":later_context.reuse_key,"sandbox_id":id}]}) };
        let published_current = read_status(&status_path).await?;
        let other = if blank { "idle_sandboxes" } else { "blank_sandboxes" };
        let field = if blank { "blank_sandboxes" } else { "idle_sandboxes" };
        if current.revision != revision || published_current.get(field) != expected.get(field)
            || published_current.get(other).is_some() || context.budget.allocated() != (2,4096,1)
            || futures_util::poll!(Box::pin(later_backing.exit_confirmed()).as_mut()).is_ready() {
            return Err(io::Error::other("original batch publication lost later live inventory").into());
        }
        proof.later_parking_witness("original_completed", json!({
            "status_released_ns": status_released_ns, "batch_joined_ns": batch_joined_ns,
            "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
            "not_started":report.not_started.len(),"status_error":report.status_error.is_some(),
            "is_complete":report.is_complete(),"revision":current.revision,
            "published_status":published_current,"regular_file":true,
            "later_exit_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    drop(pool_hold.take());
    drop(status_hold.take());
    let release = gate.release();
    let first = match completed {
        Some(value) => value,
        None => completion.await,
    };
    // Refusal still owns the prepared capsule. Transfer it only through the
    // guarded insertion owner; preserve it if admission cannot accept it.
    let recovery: TestResult<()> = async {
        if let Some(mut capsule) = incoming.take() {
            let result = context
                .tracker
                .insert_pool_entry(
                    &context.pool,
                    &mut capsule,
                    &context.operations,
                    inputs.envelope(),
                    "native_later_refusal_cleanup",
                )
                .await;
            if let Some(owner) = capsule.into_owner() {
                proof.retain(owner);
            }
            let mut inserted = result?;
            if let Some(task) = inserted.retirement.as_mut() {
                let result = task.join().await;
                proof.retain(task.take_completed_lease());
                result??;
            }
        }
        Ok(())
    }
    .await;
    // The later entry belongs to another fixed batch, never recaptured by the
    // original. Do not cancel this accepted cleanup on scenario timeout.
    let final_started_ns = evidence::clocks();
    let cleanup: TestResult<()> = async {
        let mut later = start(&context, inputs).await?;
        let report = later.join().await?;
        if !report.is_complete() || report.selected != 1 || report.completed != 1
            || !later_backing.exit_confirmed().await || context.budget.allocated() != (0,0,0)
            || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("separate later batch did not settle its exact owner").into());
        }
        let published = read_status(&status_path).await?;
        if published.get("idle_sandboxes").is_some() || published.get("blank_sandboxes").is_some() {
            return Err(io::Error::other("separate later batch did not publish empty inventory").into());
        }
        if matches!(&outcome, Ok(Ok(()))) {
            proof.later_parking_witness("later_retired",json!({
                "started_ns":final_started_ns?.0,"joined_ns":evidence::clocks()?.0,
                "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
                "not_started":report.not_started.len(),"status_error":report.status_error.is_some(),
                "is_complete":report.is_complete(),"later_exit_confirmed":true,
                "published_status":published,"allocated":context.budget.allocated(),
            }))?;
        }
        Ok(())
    }.await;
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    let reporting = probe.finish().await;
    release?;
    first?;
    recovery?;
    cleanup?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    let operations = operations?;
    settled(&operations)?;
    let activation = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activation.is_empty() || !finalizing.is_empty() {
        proof.retain(activation);
        proof.retain(finalizing);
        return Err(io::Error::other("later parking retained unresolved owners").into());
    }
    proof.later_parking_witness("producers_joined",json!({
        "batch_joined":true,"later_batch_joined":true,"tracker_joined":true,"accounting_joined":true,
        "heartbeat_joined":true,"provider_joined":true,"peer_joined":true,
        "remaining_activation_owners":0,"remaining_finalizing_owners":0,
        "allocated":context.budget.allocated(),"accounting":accounting(&operations),
    }))?;
    Ok(())
}
