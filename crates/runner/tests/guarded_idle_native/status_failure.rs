//! Real status publication failure remains distinct from accepted native saving.

use std::{path::Path, time::Duration};

use runner_lifecycle::status::StatusPersistenceError;
use serde_json::{Value, json};

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

async fn read_status(path: &Path) -> TestResult<Value> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other("native status is not a regular file").into());
    }
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

async fn remove_fault(path: &Path) -> TestResult<()> {
    if !tokio::fs::symlink_metadata(path).await?.is_dir() {
        return Err(io::Error::other("native status fault changed identity").into());
    }
    tokio::fs::remove_dir(path).await?;
    Ok(())
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
) -> TestResult<()> {
    let status_path = directory.join("status.json");
    let snapshot = context.pool.lock().await.status_snapshot();
    context.status.set_idle_snapshot(snapshot).await?;
    let published = read_status(&status_path).await?;
    let entries = published
        .get("idle_sandboxes")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::other("native initial parked status missing"))?;
    let [entry] = entries.as_slice() else {
        return Err(
            io::Error::other("native initial status does not have one original entry").into(),
        );
    };
    let started_at = published
        .get("started_at")
        .and_then(Value::as_str)
        .ok_or_else(|| io::Error::other("native original status timestamp missing"))?;
    if entry.get("reuse_key").and_then(Value::as_str) != Some(context.reuse_key.as_str())
        || !entry
            .get("sandbox_id")
            .and_then(Value::as_str)
            .is_some_and(|id| proof.owns(id))
        || !published
            .get("active_runs")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        || published.get("blank_sandboxes").is_some()
    {
        return Err(io::Error::other("native initial status changed original inventory").into());
    }
    let gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(gate.clone())?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool.clone(),
            context.status.clone(),
            context.operations.clone(),
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_status_failure",
            },
        )
        .await;
    let mut batch = match batch {
        Ok(batch) => batch,
        Err(error) => {
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let mut completion = Box::pin(batch.join());
    let mut batch_completed = None;
    let mut tracker_shutdown = Box::pin(context.tracker.close_and_wait());
    let mut accounting_shutdown = Box::pin(context.operations.close_and_wait());
    let mut tracker_completed = None;
    let mut accounting_completed = None;
    let mut pool_hold = None;
    let mut status_hold = None;
    let mut fault_injected = false;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        gate.wait_entered().await?;
        pending(completion.as_mut(), &mut batch_completed).await?;
        proof.status_failure_witness("tail_blocked", json!({
            "policy": serde_json::to_value(inputs)?, "published_status": published,
            "status_path": status_path, "receiver_polled_pending": true,
            "coverage": coverage(&context, inputs, proof, false)?,
        }))?;
        pending(tracker_shutdown.as_mut(), &mut tracker_completed).await?;
        pending(accounting_shutdown.as_mut(), &mut accounting_completed).await?;
        pool_hold = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        let mut status_waits = context.status.idle_snapshot_waits_for_test();
        let before = *status_waits.borrow_and_update();
        probe.request()?;
        {
            let heartbeat = probe.complete();
            tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("native status-failure heartbeat ignored held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observation = foreground_probe::observe().await?;
        proof.status_failure_witness("pool_wait_progress", json!({
            "pool_held_ns": pool_held_ns, "status_held_ns": status_held_ns,
            "heartbeat_pending_ns": heartbeat_pending_ns, "heartbeat_polled_pending": true,
            "observer": observation, "tracker_shutdown_pending": true,
            "accounting_shutdown_pending": true, "coverage": coverage(&context, inputs, proof, true)?,
        }))?;
        // Bound the release before unlocking: the other worker may receive
        // its heartbeat acknowledgement before this task is scheduled again.
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let heartbeat = probe.complete().await?;
        pending(completion.as_mut(), &mut batch_completed).await?;
        pending(tracker_shutdown.as_mut(), &mut tracker_completed).await?;
        pending(accounting_shutdown.as_mut(), &mut accounting_completed).await?;
        proof.status_failure_witness("tail_wait_progress", json!({
            "pool_released_ns": pool_released_ns, "status_held_ns": status_held_ns,
            "heartbeat": heartbeat, "receiver_polled_pending": true,
            "tracker_shutdown_pending": true, "accounting_shutdown_pending": true,
            "coverage": coverage(&context, inputs, proof, true)?,
        }))?;
        let io_released_ns = evidence::clocks()?.0;
        gate.release()?;
        while *status_waits.borrow_and_update() == before {
            status_waits.changed().await?;
        }
        let after = *status_waits.borrow();
        let status_wait_polled_ns = evidence::clocks()?.0;
        if after != before + 1 || context.budget.allocated() != (0, 0, 0) {
            return Err(io::Error::other("native status-failure wait or lease release changed").into());
        }
        pending(completion.as_mut(), &mut batch_completed).await?;
        pending(tracker_shutdown.as_mut(), &mut tracker_completed).await?;
        let completed = accounting_completed.insert(accounting_shutdown.as_mut().await);
        let value = completed.as_ref().map_err(|error| io::Error::other(error.to_string()))?;
        settled(value)?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        // Only this invocation's destination is faulted, after complete saving
        // and a positively observed wait before final status publication.
        tokio::fs::remove_file(&status_path).await?;
        tokio::fs::create_dir(&status_path).await?;
        fault_injected = true;
        let fault_injected_ns = evidence::clocks()?.0;
        proof.status_failure_witness("status_wait_progress", json!({
            "io_released_ns": io_released_ns, "status_held_ns": status_held_ns,
            "status_wait_polled_ns": status_wait_polled_ns,
            "status_waits_before": before, "status_waits_after": after,
            "receiver_polled_pending": true, "tracker_shutdown_pending": true,
            "accounting_joined": true, "accounting": accounting(value),
            "allocated": context.budget.allocated(), "heartbeat": heartbeat,
            "fault_injected_ns": fault_injected_ns, "status_destination_directory": true,
        }))?;
        let status_released_ns = evidence::clocks()?.0;
        drop(status_hold.take());
        let report = batch_completed.insert(completion.as_mut().await);
        let report = report.as_ref().map_err(|error| io::Error::other(error.to_string()))?;
        let batch_joined_ns = evidence::clocks()?.0;
        if (report.selected, report.completed, report.uncertain) != (1, 1, 0)
            || !report.not_started.is_empty() || report.is_complete()
            || !matches!(report.status_error.as_ref(),
                Some(StatusPersistenceError::Write { path, .. }) if path == &status_path)
            || !tokio::fs::symlink_metadata(&status_path).await?.is_dir()
        {
            return Err(io::Error::other("native saving did not expose its exact status-write failure").into());
        }
        proof.status_failure_witness("status_failed", json!({
            "status_released_ns": status_released_ns, "batch_joined_ns": batch_joined_ns,
            "selected": report.selected, "completed": report.completed, "uncertain": report.uncertain,
            "not_started": report.not_started.len(), "is_complete": report.is_complete(),
            "status_error_kind": "write", "status_error_path": status_path,
            "status_destination_directory": true,
        }))?;
        remove_fault(&status_path).await?;
        fault_injected = false;
        let retry_started_ns = evidence::clocks()?.0;
        context.status.retry_unpublished_snapshot().await?;
        let retried = read_status(&status_path).await?;
        let retry_completed_ns = evidence::clocks()?.0;
        if retried.get("idle_sandboxes").is_some()
            || retried.get("blank_sandboxes").is_some()
            || !retried.get("active_runs").and_then(Value::as_array).is_some_and(Vec::is_empty)
            || retried.get("started_at").and_then(Value::as_str) != Some(started_at)
            || report.is_complete()
        {
            return Err(io::Error::other("native status retry resurrected stale inventory").into());
        }
        proof.status_failure_witness("status_retried", json!({
            "retry_started_ns": retry_started_ns, "retry_completed_ns": retry_completed_ns,
            "published_status": retried, "regular_file": true,
            "original_batch_complete": report.is_complete(),
        }))?;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    // A refusal still releases only owned gates and joins the accepted work.
    drop(pool_hold.take());
    drop(status_hold.take());
    let release = gate.release();
    let batch_result = match batch_completed {
        Some(result) => result,
        None => completion.await,
    };
    if tracker_completed.is_none() {
        tracker_shutdown.await;
    }
    let completed = match accounting_completed {
        Some(result) => result,
        None => accounting_shutdown.await,
    };
    let reporting = probe.finish().await;
    let repair: TestResult<()> = async {
        if fault_injected {
            remove_fault(&status_path).await?;
            context.status.retry_unpublished_snapshot().await?;
        }
        Ok(())
    }
    .await;
    release?;
    batch_result?;
    let completed = completed?;
    reporting?;
    repair?;
    outcome.map_err(io::Error::other)??;
    settled(&completed)?;
    let activation = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activation.is_empty() || !finalizing.is_empty() {
        proof.retain(activation);
        proof.retain(finalizing);
        return Err(io::Error::other("native status failure left unresolved owners").into());
    }
    proof.status_failure_witness(
        "producers_joined",
        json!({
            "batch_joined": true, "tracker_joined": true, "accounting_joined": true,
            "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
            "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
            "allocated": context.budget.allocated(), "accounting": accounting(&completed),
        }),
    )?;
    Ok(())
}
