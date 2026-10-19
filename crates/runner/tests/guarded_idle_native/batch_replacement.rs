//! A captured old batch cannot consume a distinct same-key replacement Guest.

use std::{path::Path, time::Duration};

use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdlePoolIncoming, IdleSandboxIdentity,
};
use runner_supervisor::idle_lifecycle::{IdleCleanupTask, IdlePoolRetirementBatchReport};
use serde_json::{Value, json};

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

async fn read_status(path: &Path) -> TestResult<Value> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other("replacement status is not a regular file").into());
    }
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

async fn start(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
) -> Result<IdleCleanupTask<IdlePoolRetirementBatchReport>, MemoryOperationError> {
    context
        .tracker
        .start_pool_retirement_batch(
            context.pool.clone(),
            context.status.clone(),
            context.operations.clone(),
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_batch_replacement",
            },
        )
        .await
}

fn open_zero() -> Value {
    json!({"registered_operations":0,"queued":0,"granted":0,"started":0,
        "uncertain":0,"ordinary_growth_bytes":0,"cleanup_growth_bytes":0,"tracked_tasks":0,"closed":false})
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &recovery_source::Source,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    original: Arc<dyn sandbox::SandboxBackingProcess>,
) -> TestResult<()> {
    let initial = context.pool.lock().await.status_snapshot();
    let [entry] = initial.idle_sandboxes.as_slice() else {
        return Err(io::Error::other("replacement needs exactly its original entry").into());
    };
    let old_id = entry.sandbox_id;
    let selected_revision = initial.revision;
    if entry.reuse_key != context.reuse_key
        || !proof.owns(&old_id.to_string())
        || !initial.blank_sandboxes.is_empty()
    {
        return Err(io::Error::other("replacement original identity changed").into());
    }
    context.status.set_idle_snapshot(initial).await?;
    let status_path = directory.join("status.json");
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
    // Preparation and its full owner are never inside the scenario's timeout.
    let prepared = match transitions::prepare_observed_incoming(&context, inputs, false).await {
        Ok(prepared) => prepared,
        Err(error) => {
            probe.finish().await?;
            return Err(error);
        }
    };
    let incoming_backing = prepared.backing;
    let preparation = prepared.receipt;
    let incoming_id = preparation.sandbox_id.clone();
    let mut incoming = Some(IdlePoolIncoming::park(prepared.candidate));
    let initialization: TestResult<_> = async {
        while context.operations.snapshot()?.tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
        Ok((source.samples()?.len(), source.hold_next_read()?))
    }
    .await;
    let (first_sample, read_gate) = match initialization {
        Ok(value) => value,
        Err(error) => {
            proof.retain(incoming.take().and_then(IdlePoolIncoming::into_owner));
            probe.finish().await?;
            return Err(error);
        }
    };
    let mut old = match start(&context, inputs).await {
        Ok(task) => task,
        Err(error) => {
            read_gate.release();
            proof.retain(incoming.take().and_then(IdlePoolIncoming::into_owner));
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let mut completion = Box::pin(old.join());
    let mut completed = None;
    let mut inserted = None;
    let mut replacement_joined = false;
    let mut replacement_lease_released = false;
    let mut pool_hold = None;
    let mut status_hold = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        read_gate.wait_entered().await?;
        pending(completion.as_mut(), &mut completed).await?;
        proof.require_full_lease()?;
        let queued = accounting(&context.operations.snapshot()?);
        if queued != json!({"registered_operations":2,"queued":2,"granted":0,"started":0,
            "uncertain":0,"ordinary_growth_bytes":0,"cleanup_growth_bytes":0,"tracked_tasks":0,"closed":false})
            || context.budget.allocated() != (4,8192,2)
            || original.identity() == incoming_backing.identity()
            || futures_util::poll!(Box::pin(original.exit_confirmed()).as_mut()).is_ready()
            || futures_util::poll!(Box::pin(incoming_backing.exit_confirmed()).as_mut()).is_ready() {
            return Err(io::Error::other("replacement lost its two live full owners/unused old claims").into());
        }
        proof.batch_replacement_witness("admission_blocked", json!({
            "policy":serde_json::to_value(inputs)?,"status_path":status_path,"published_status":published,
            "selected_revision":selected_revision,"preparation":preparation,"same_reuse_key":context.reuse_key,
            "source_read_blocked":true,"receiver_polled_pending":true,"accounting":queued,
            "allocated":context.budget.allocated(),"original_full_lease_active":true,
            "original_exit_polled_pending":true,"incoming_exit_polled_pending":true,
        }))?;
        let insertion_started_ns = evidence::clocks()?.0;
        inserted = Some(context.tracker.insert_pool_entry(&context.pool,
            incoming.as_mut().ok_or_else(|| io::Error::other("replacement incoming missing"))?,
            &context.operations, inputs.envelope(), "native_same_key_replacement").await?);
        if let Some(owner) = incoming.take().and_then(IdlePoolIncoming::into_owner) {
            proof.retain(owner);
            return Err(io::Error::other("replacement failed to transfer incoming custody").into());
        }
        gate.wait_entered().await?;
        if !original.exit_confirmed().await {
            return Err(io::Error::other("replacement original backing exit unconfirmed").into());
        }
        let revision = context.pool.lock().await.status_snapshot().revision;
        if revision <= selected_revision { return Err(io::Error::other("replacement revision did not advance").into()); }
        pending(completion.as_mut(), &mut completed).await?;
        proof.batch_replacement_witness("tail_blocked", json!({
            "insertion_started_ns":insertion_started_ns,"revision":revision,"original_exit_confirmed":true,
            "receiver_polled_pending":true,"coverage":coverage(&context,inputs,proof,false)?,
        }))?;
        pool_hold = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        probe.request()?;
        {
            let heartbeat = probe.complete();
            tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("replacement heartbeat ignored held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        proof.batch_replacement_witness("pool_wait_progress",json!({
            "pool_held_ns":pool_held_ns,"heartbeat_pending_ns":heartbeat_pending_ns,
            "heartbeat_polled_pending":true,"observer":observer,"coverage":coverage(&context,inputs,proof,false)?,
        }))?;
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let heartbeat = probe.complete().await?;
        proof.batch_replacement_witness("tail_wait_progress",json!({
            "pool_released_ns":pool_released_ns,"heartbeat":heartbeat,
            "receiver_polled_pending":true,"coverage":coverage(&context,inputs,proof,false)?,
        }))?;
        let io_released_ns = evidence::clocks()?.0;
        gate.release()?;
        let task = inserted.as_mut().and_then(|value| value.retirement.as_mut())
            .ok_or_else(|| io::Error::other("replacement did not accept original retirement"))?;
        let saved = task.join().await;
        replacement_joined = true;
        if !matches!(saved??, ActivationCleanupOutcome::Completed { home_cache_promoted:true }) {
            return Err(io::Error::other("replacement original required home did not complete").into());
        }
        drop(task.take_completed_lease()?);
        replacement_lease_released = true;
        proof.require_original_lease_released()?;
        pending(completion.as_mut(), &mut completed).await?;
        if context.budget.allocated() != (2,4096,1)
            || futures_util::poll!(Box::pin(incoming_backing.exit_confirmed()).as_mut()).is_ready() {
            return Err(io::Error::other("replacement saving consumed incoming").into());
        }
        proof.batch_replacement_witness("original_saved",json!({
            "io_released_ns":io_released_ns,"retirement_joined_ns":evidence::clocks()?.0,
            "home_cache_promoted":true,"original_exit_confirmed":true,"original_lease_released":true,
            "incoming_exit_polled_pending":true,"receiver_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        let mut waits = context.status.idle_snapshot_waits_for_test();
        let before = *waits.borrow_and_update();
        let source_resumed_ns = evidence::clocks()?.0;
        read_gate.release();
        while *waits.borrow_and_update() == before { waits.changed().await?; }
        let after = *waits.borrow();
        let status_wait_polled_ns = evidence::clocks()?.0;
        while context.operations.snapshot()?.tracked_tasks != 0 { tokio::task::yield_now().await; }
        let idle = accounting(&context.operations.snapshot()?);
        if after != before+1 || idle != open_zero() {
            return Err(io::Error::other("replacement old claims/accounting did not settle before status wait").into());
        }
        pending(completion.as_mut(), &mut completed).await?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        proof.batch_replacement_witness("status_wait_progress",json!({
            "status_held_ns":status_held_ns,"source_resumed_ns":source_resumed_ns,
            "status_wait_polled_ns":status_wait_polled_ns,"status_waits_before":before,"status_waits_after":after,
            "heartbeat":heartbeat,"accounting":idle,"samples":source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "receiver_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        let status_released_ns = evidence::clocks()?.0;
        drop(status_hold.take());
        let report = completed.insert(completion.as_mut().await);
        let report = report.as_ref().map_err(|error| io::Error::other(error.to_string()))?;
        let [refusal] = report.not_started.as_slice() else {
            return Err(io::Error::other("replacement old batch did not refuse exactly its captured original").into());
        };
        if (report.selected,report.completed,report.uncertain) != (1,0,0) || report.is_complete()
            || report.status_error.is_some() || refusal.identity != IdleSandboxIdentity::Exact(context.reuse_key.clone())
            || refusal.sandbox_id != old_id || refusal.error != MemoryOperationError::AccountingChanged {
            return Err(io::Error::other("replacement old batch lost exact accounting refusal").into());
        }
        let current = context.pool.lock().await.status_snapshot();
        let published = read_status(&status_path).await?;
        if current.revision != revision || published.get("idle_sandboxes") != Some(&json!([
            {"reuse_key":context.reuse_key,"sandbox_id":incoming_id}])) || published.get("blank_sandboxes").is_some()
            || context.budget.allocated() != (2,4096,1)
            || futures_util::poll!(Box::pin(incoming_backing.exit_confirmed()).as_mut()).is_ready() {
            return Err(io::Error::other("replacement old publication lost distinct live incoming").into());
        }
        proof.batch_replacement_witness("batch_refused",json!({
            "status_released_ns":status_released_ns,"batch_joined_ns":evidence::clocks()?.0,
            "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
            "not_started":report.not_started.len(),"status_error":report.status_error.is_some(),"is_complete":report.is_complete(),
            "refused_sandbox_id":refusal.sandbox_id,"refused_reuse_key":context.reuse_key,"error":"AccountingChanged",
            "revision":revision,"published_status":published,"regular_file":true,
            "incoming_exit_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    drop(pool_hold.take());
    drop(status_hold.take());
    read_gate.release();
    let released = gate.release();
    let old_result = match completed {
        Some(result) => result,
        None => completion.await,
    };
    // Accepted physical producers stay outside the timeout, even on refusal.
    let replacement: TestResult<()> = async {
        if let Some(task) = inserted
            .as_mut()
            .and_then(|value| value.retirement.as_mut())
        {
            if !replacement_joined {
                task.join().await??;
            }
            if !replacement_lease_released {
                drop(task.take_completed_lease()?);
            }
        }
        if let Some(mut capsule) = incoming.take() {
            let result = context
                .tracker
                .insert_pool_entry(
                    &context.pool,
                    &mut capsule,
                    &context.operations,
                    inputs.envelope(),
                    "native_replacement_refusal_cleanup",
                )
                .await;
            if let Some(owner) = capsule.into_owner() {
                proof.retain(owner);
            }
            let mut inserted = result?;
            if let Some(task) = inserted.retirement.as_mut() {
                let joined = task.join().await;
                proof.retain(task.take_completed_lease());
                joined??;
            }
        }
        Ok(())
    }
    .await;
    let final_started_ns = evidence::clocks();
    let cleanup: TestResult<()> = async {
        let mut batch = start(&context,inputs).await?;
        let report = batch.join().await?;
        if !report.is_complete() || report.selected != 1 || report.completed != 1
            || !incoming_backing.exit_confirmed().await || context.budget.allocated() != (0,0,0)
            || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("replacement separate incoming batch did not complete").into());
        }
        let published = read_status(&status_path).await?;
        if published.get("idle_sandboxes").is_some() || published.get("blank_sandboxes").is_some() {
            return Err(io::Error::other("replacement final status not empty").into());
        }
        if matches!(&outcome,Ok(Ok(()))) {
            proof.batch_replacement_witness("incoming_retired",json!({
                "started_ns":final_started_ns?.0,"joined_ns":evidence::clocks()?.0,
                "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
                "not_started":report.not_started.len(),"status_error":report.status_error.is_some(),"is_complete":report.is_complete(),
                "incoming_exit_confirmed":true,"published_status":published,"allocated":context.budget.allocated(),
            }))?;
        }
        Ok(())
    }.await;
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    let reporting = probe.finish().await;
    released?;
    old_result?;
    replacement?;
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
        return Err(io::Error::other("replacement retained unresolved owners").into());
    }
    proof.batch_replacement_witness("producers_joined",json!({
        "old_batch_joined":true,"replacement_joined":true,"incoming_batch_joined":true,
        "tracker_joined":true,"accounting_joined":true,"heartbeat_joined":true,"provider_joined":true,"peer_joined":true,
        "remaining_activation_owners":0,"remaining_finalizing_owners":0,
        "allocated":context.budget.allocated(),"accounting":accounting(&operations),
    }))?;
    Ok(())
}
