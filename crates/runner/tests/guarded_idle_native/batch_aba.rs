//! A restored original needs a new captured batch, despite unchanged Guest identity.

use std::{path::Path, time::Duration};

use runner_lifecycle::idle_pool::{IdleSandboxIdentity, RestoreReservedIdleResult};
use runner_supervisor::idle_lifecycle::{IdleCleanupTask, IdlePoolRetirementBatchReport};
use sandbox::{BackingProcessIdentity, SandboxBackingProcess};
use serde_json::{Value, json};

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

async fn read_status(path: &Path) -> TestResult<Value> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other("batch ABA status is not a regular file").into());
    }
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

fn open_zero() -> Value {
    json!({"registered_operations":0,"queued":0,"granted":0,"started":0,
        "uncertain":0,"ordinary_growth_bytes":0,"cleanup_growth_bytes":0,"tracked_tasks":0,"closed":false})
}

fn queued(context: &transitions::Context) -> TestResult<Value> {
    let value = accounting(&context.operations.snapshot()?);
    let expected = json!({"registered_operations":2,"queued":2,"granted":0,"started":0,
        "uncertain":0,"ordinary_growth_bytes":0,"cleanup_growth_bytes":0,"tracked_tasks":0,"closed":false});
    if value != expected {
        return Err(io::Error::other("batch ABA did not retain two unused queued claims").into());
    }
    Ok(value)
}

async fn live(
    context: &transitions::Context,
    proof: &evidence::Case,
    backing: &Arc<dyn SandboxBackingProcess>,
    original: &BackingProcessIdentity,
) -> TestResult<()> {
    proof.require_full_lease()?;
    if context.budget.allocated() != (2, 4096, 1)
        || backing.identity() != *original
        || futures_util::poll!(Box::pin(backing.exit_confirmed()).as_mut()).is_ready()
    {
        return Err(io::Error::other("batch ABA lost its live original full lease/backing").into());
    }
    Ok(())
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
                context: "native_batch_aba",
            },
        )
        .await
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &recovery_source::Source,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    backing: Arc<dyn SandboxBackingProcess>,
    physical_history: Option<RunId>,
) -> TestResult<()> {
    let identity = IdleSandboxIdentity::Exact(context.reuse_key.clone());
    let (initial, selected) = {
        let pool = context.pool.lock().await;
        (
            pool.status_snapshot(),
            pool.retirement_candidate(&identity)?,
        )
    };
    let [entry] = initial.idle_sandboxes.as_slice() else {
        return Err(io::Error::other("batch ABA requires its singular original inventory").into());
    };
    let id = entry.sandbox_id;
    if !initial.blank_sandboxes.is_empty()
        || entry.reuse_key != context.reuse_key
        || !proof.owns(&id.to_string())
    {
        return Err(io::Error::other("batch ABA changed original inventory").into());
    }
    let selected_revision = initial.revision;
    let original = backing.identity();
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
    let first_sample = source.samples()?.len();
    source.pause();
    let mut old = match start(&context, inputs).await {
        Ok(task) => task,
        Err(error) => {
            source.resume();
            let released = gate.release();
            let joined = probe.finish().await;
            released?;
            joined?;
            return Err(error.into());
        }
    };
    let mut completion = Box::pin(old.join());
    let mut completed = None;
    let mut pool_hold = None;
    let mut status_hold = None;
    // Borrowed physical transitions may be cancelled, but never their owner.
    let mut speculative = batch_repark::Owner::default();
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        pending(completion.as_mut(), &mut completed).await?;
        live(&context, proof, &backing, &original).await?;
        proof.batch_aba_witness("admission_blocked", json!({
            "policy":serde_json::to_value(inputs)?,"status_path":status_path,"published_status":published,
            "selected_revision":selected_revision,"source_read_blocked":true,"receiver_polled_pending":true,
            "accounting":queued(&context)?,"allocated":context.budget.allocated(),
            "original_full_lease_active":true,"original_exit_polled_pending":true,
        }))?;
        if let Some(history) = physical_history {
            speculative.exercise(&context, proof, history, &selected, &backing).await?;
            pending(completion.as_mut(), &mut completed).await?;
            live(&context, proof, &backing, &original).await?;
            queued(&context)?;
        }
        pool_hold = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        let mut waits = context.status.idle_snapshot_waits_for_test();
        let before = *waits.borrow_and_update();
        let pool = pool_hold.as_mut().ok_or_else(|| io::Error::other("batch ABA pool hold missing"))?;
        let reserved_ns = evidence::clocks()?.0;
        let reservation = pool.reserve_reusable(&context.reuse_key, fixture::PROFILE, &None)
            .ok_or_else(|| io::Error::other("batch ABA original reservation missing"))?;
        let reserved_id = reservation.sandbox_id();
        let restored = pool.restore_reserved(reservation);
        if !matches!(restored, RestoreReservedIdleResult::Restored) {
            proof.retain(restored);
            return Err(io::Error::other("batch ABA could not restore its complete original owner").into());
        }
        let restored_ns = evidence::clocks()?.0;
        let revision = pool.status_snapshot().revision;
        if reserved_id != id || revision <= selected_revision || pool.retirement_candidate(&identity)?.same_insertion(&selected) {
            return Err(io::Error::other("batch ABA did not change exactly its original insertion").into());
        }
        live(&context, proof, &backing, &original).await?;
        probe.request()?;
        {
            let heartbeat = probe.complete();
            tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("batch ABA heartbeat ignored held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        proof.batch_aba_witness("pool_wait_progress", json!({
            "pool_held_ns":pool_held_ns,"status_held_ns":status_held_ns,
            "reserved_ns":reserved_ns,"restored_ns":restored_ns,"revision":revision,
            "original_sandbox_id":reserved_id,"original_backing_generation":backing.identity().generation(),
            "same_insertion":false,"restored_original":true,"heartbeat_pending_ns":heartbeat_pending_ns,
            "heartbeat_polled_pending":true,"observer":observer,"accounting":queued(&context)?,
            "allocated":context.budget.allocated(),
        }))?;
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let heartbeat = probe.complete().await?;
        pending(completion.as_mut(), &mut completed).await?;
        live(&context, proof, &backing, &original).await?;
        proof.batch_aba_witness("admission_wait_progress", json!({
            "pool_released_ns":pool_released_ns,"heartbeat":heartbeat,"receiver_polled_pending":true,
            "source_read_blocked":true,"accounting":queued(&context)?,"allocated":context.budget.allocated(),
        }))?;
        let source_resumed_ns = evidence::clocks()?.0;
        source.resume();
        while *waits.borrow_and_update() == before { waits.changed().await?; }
        let after = *waits.borrow();
        let status_wait_polled_ns = evidence::clocks()?.0;
        let idle = accounting(&context.operations.snapshot()?);
        if after != before + 1 || idle != open_zero() {
            return Err(io::Error::other("batch ABA unused claims did not settle before status wait").into());
        }
        pending(completion.as_mut(), &mut completed).await?;
        live(&context, proof, &backing, &original).await?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        proof.batch_aba_witness("status_wait_progress", json!({
            "source_resumed_ns":source_resumed_ns,"status_wait_polled_ns":status_wait_polled_ns,
            "status_waits_before":before,"status_waits_after":after,"accounting":idle,
            "samples":source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "heartbeat":heartbeat,"receiver_polled_pending":true,"original_full_lease_active":true,
            "original_exit_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        let status_released_ns = evidence::clocks()?.0;
        drop(status_hold.take());
        let report = completed.insert(completion.as_mut().await);
        let report = report.as_ref().map_err(|error| io::Error::other(error.to_string()))?;
        let [refusal] = report.not_started.as_slice() else {
            return Err(io::Error::other("batch ABA did not refuse exactly its original selection").into());
        };
        if (report.selected,report.completed,report.uncertain) != (1,0,0) || report.is_complete()
            || report.status_error.is_some() || refusal.identity != identity || refusal.sandbox_id != id
            || refusal.error != MemoryOperationError::ResourceChanged {
            return Err(io::Error::other("batch ABA report lost its exact insertion refusal").into());
        }
        live(&context, proof, &backing, &original).await?;
        let current = context.pool.lock().await.status_snapshot();
        let published_current = read_status(&status_path).await?;
        if current.revision != revision || published_current.get("idle_sandboxes") != Some(&json!([
            {"reuse_key":context.reuse_key,"sandbox_id":id}])) || published_current.get("blank_sandboxes").is_some() {
            return Err(io::Error::other("batch ABA refusal lost current original inventory").into());
        }
        proof.batch_aba_witness("batch_refused", json!({
            "status_released_ns":status_released_ns,"batch_joined_ns":evidence::clocks()?.0,
            "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
            "not_started":report.not_started.len(),"status_error":false,"is_complete":false,
            "refusal_sandbox_id":refusal.sandbox_id,"refusal_reuse_key":context.reuse_key,
            "refusal_error":format!("{:?}",refusal.error),"revision":current.revision,
            "published_status":published_current,"regular_file":true,"original_exit_polled_pending":true,
            "original_full_lease_active":true,"allocated":context.budget.allocated(),
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    source.resume();
    drop(pool_hold.take());
    drop(status_hold.take());
    // Unexpected accepted old work must also be released before its join.
    let old_release = if matches!(&outcome, Ok(Ok(()))) {
        Ok(())
    } else {
        gate.release()
    };
    let first = match completed {
        Some(value) => value,
        None => completion.await,
    };
    // A failed physical rollback still owns mandatory original data. Attempt
    // guarded cleanup before the tracker closes, after releasing its IO gate.
    let physical_cleanup = speculative.finish(&context, inputs, proof).await;
    // Capture recovery outside the cancellable refusal block; accepted cleanup
    // survives cancellation of its progress observer.
    let recovery_started = evidence::clocks();
    let recovery: TestResult<()> = async {
        let mut batch = start(&context, inputs).await?;
        let mut completion = Box::pin(batch.join());
        let mut completed = None;
        let progress = tokio::time::timeout(Duration::from_secs(90), async {
            gate.wait_entered().await?;
            let kernel_io_entered_ns = evidence::clocks()?.0;
            pending(completion.as_mut(), &mut completed).await?;
            if !backing.exit_confirmed().await {
                return Err(io::Error::other("batch ABA recovery lacks original backing exit").into());
            }
            proof.require_full_lease()?;
            let observer = foreground_probe::observe().await?;
            probe.request()?;
            let heartbeat = probe.complete().await?;
            proof.batch_aba_witness("recovery_tail_progress", json!({
                "recovery_started_ns":recovery_started?.0,"kernel_io_entered_ns":kernel_io_entered_ns,
                "kernel_io_entered":true,"receiver_polled_pending":true,"original_exit_confirmed":true,
                "observer":observer,"heartbeat":heartbeat,"coverage":coverage(&context, inputs, proof, false)?,
            }))?;
            Ok::<(),Box<dyn Error+Send+Sync>>(())
        }).await;
        let io_released = evidence::clocks();
        let released = gate.release();
        let result = match completed { Some(value) => value, None => completion.await };
        released?;
        progress.map_err(io::Error::other)??;
        let report = result?;
        if (report.selected,report.completed,report.uncertain) != (1,1,0) || !report.is_complete()
            || !backing.exit_confirmed().await || context.budget.allocated() != (0,0,0)
            || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("new captured batch did not recover the restored original").into());
        }
        proof.require_original_lease_released()?;
        let published = read_status(&status_path).await?;
        if published.get("idle_sandboxes").is_some() || published.get("blank_sandboxes").is_some() {
            return Err(io::Error::other("batch ABA recovery did not publish empty inventory").into());
        }
        proof.batch_aba_witness("recovery_completed", json!({
            "io_released_ns":io_released?.0,"batch_joined_ns":evidence::clocks()?.0,
            "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
            "not_started":report.not_started.len(),"status_error":report.status_error.is_some(),"is_complete":report.is_complete(),
            "original_exit_confirmed":true,"original_lease_released":true,
            "published_status":published,"regular_file":true,"allocated":context.budget.allocated(),
        }))?;
        Ok(())
    }.await;
    let released = gate.release();
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    let reporting = probe.finish().await;
    old_release?;
    released?;
    first?;
    physical_cleanup?;
    recovery?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    let operations = operations?;
    settled(&operations)?;
    let activation = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activation.is_empty() || !finalizing.is_empty() {
        proof.retain(activation);
        proof.retain(finalizing);
        return Err(io::Error::other("batch ABA retained unresolved owners").into());
    }
    proof.batch_aba_witness("producers_joined", json!({
        "old_batch_joined":true,"recovery_batch_joined":true,"tracker_joined":true,"accounting_joined":true,
        "heartbeat_joined":true,"provider_joined":true,"peer_joined":true,
        "remaining_activation_owners":0,"remaining_finalizing_owners":0,
        "allocated":context.budget.allocated(),"accounting":accounting(&operations),
    }))?;
    Ok(())
}
