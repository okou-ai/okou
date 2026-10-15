//! Real observation gaps, revoked offers and complete owned runtime reads.

use std::time::Duration;

use runner_lifecycle::host_memory_operations::MemoryOperationPlan;
use runner_lifecycle::host_memory_pressure::{HostPressureState, OptionalPressureControl};
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde::Deserialize;
use serde_json::{Value, json};

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    snapshot_path: PathBuf,
    snapshot_memory_mb: u32,
    prefetch_overhead_bytes: u64,
}

fn decision(control: &OptionalPressureControl) -> Value {
    let current = control.decision();
    json!({"state": format!("{:?}", current.state),
        "available_bytes": current.available_bytes,
        "unknown": current.unknown.map(|reason| format!("{reason:?}")),
        "wave_inflight": current.wave_inflight})
}

async fn wait_state(control: &OptionalPressureControl, state: HostPressureState) {
    // The driver's periodic decision clock can expire a held observation even
    // while its independent sampler is waiting at the real read boundary.
    let mut ticks = tokio::time::interval(Duration::from_millis(5));
    while control.decision().state != state {
        ticks.tick().await;
    }
}

fn no_reads(
    latest: &tokio::sync::watch::Receiver<runner_lifecycle::prefetch::GuardedPrefetchSnapshot>,
) -> TestResult<()> {
    let read = latest.borrow();
    if read.accepted != 0 || read.completed != 0 || read.read_bytes != 0 {
        return Err(io::Error::other("native recovery started a read during suppression").into());
    }
    Ok(())
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    case_directory: &std::path::Path,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
) -> TestResult<()> {
    let proof =
        proof.ok_or_else(|| io::Error::other("recovery requires measured native owners"))?;
    let raw = std::fs::read(std::env::var("OKOU_TEST_OPTIONAL_MEMORY_POLICY")?)?;
    let supplied: Inputs = serde_json::from_slice(&raw)?;
    let original = PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?).join("memory.bin");
    let bytes = original.metadata()?.len();
    if std::fs::canonicalize(&supplied.snapshot_path)? != std::fs::canonicalize(&original)?
        || supplied.snapshot_memory_mb != 4096
        || bytes == 0
        || bytes > u64::from(supplied.snapshot_memory_mb) * 1024 * 1024
        || supplied.prefetch_overhead_bytes < 1024 * 1024
    {
        return Err(io::Error::other("native recovery snapshot shape/identity is invalid").into());
    }
    let growth_bytes = (u64::from(supplied.snapshot_memory_mb) * 1024 * 1024)
        .checked_add(supplied.prefetch_overhead_bytes)
        .ok_or_else(|| io::Error::other("native recovery read envelope overflow"))?;
    // The outer measured case retains this directory on failure and removes it
    // only after original data, backing, required tail and dependencies finish.
    let copies = case_directory.join("recovery-snapshots");
    std::fs::create_dir(&copies)?;
    let paths = [copies.join("recovery-a.bin"), copies.join("recovery-b.bin")];
    let expected = proof.snapshot_memory_hash()?.to_owned();
    let copied_paths = paths.clone();
    let copied_hash = expected.clone();
    tokio::task::spawn_blocking(move || -> TestResult<()> {
        evidence::verify_file(&original, &copied_hash)?;
        for path in copied_paths {
            // Preserve the original snapshot's sparse zero ranges without
            // changing any byte. Both readers still consume its complete size.
            let copied = std::process::Command::new("cp")
                .args(["--reflink=auto", "--sparse=always", "--"])
                .arg(&original)
                .arg(&path)
                .status()?;
            if !copied.success() {
                return Err(io::Error::other("native immutable snapshot copy failed").into());
            }
            evidence::verify_file(&path, &copied_hash)?;
        }
        Ok(())
    })
    .await??;
    proof.recovery_witness(
        "inputs_verified",
        json!({
            "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&raw),
            "snapshot_sha256": expected, "snapshot_bytes": bytes,
            "snapshot_memory_mb": supplied.snapshot_memory_mb,
            "prefetch_overhead_bytes": supplied.prefetch_overhead_bytes,
            "distinct_verified_copies": 2, "allocated": context.budget.allocated(),
        }),
    )?;
    source.pause();
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy: inputs.pressure_policy()?,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    })?;
    let control = pressure.optional_preparation();
    let mut admission = None;
    let mut prefetch = None;
    let result = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        if control.decision().state != HostPressureState::Unknown {
            return Err(io::Error::other("native recovery did not start Unknown").into());
        }
        proof.recovery_witness("initial_unknown", decision(&control))?;
        source.resume();
        wait_state(&control, HostPressureState::Recovering).await;
        proof.recovery_witness("initial_recovering", decision(&control))?;
        wait_state(&control, HostPressureState::Ready).await;
        proof.recovery_witness("initial_ready", decision(&control))?;
        let opportunity = control.take_optional_start()?.ok_or_else(|| io::Error::other("native initial Ready opportunity missing"))?;
        let offered = tokio::time::Instant::now();
        source.pause();
        let operations = context.operations.clone();
        admission = Some(tokio::spawn(async move {
            let mut request = operations.request(MemoryOperationPlan::HostIo { growth_bytes })?;
            request.try_grant().await
        }));
        source.wait_for_readers(2).await;
        wait_state(&control, HostPressureState::Unknown).await;
        if opportunity.revalidate()? {
            return Err(io::Error::other("native stale opportunity was not revoked").into());
        }
        proof.recovery_witness("stale_admission_wait", decision(&control))?;
        source.resume();
        let granted = admission.as_mut().ok_or_else(|| io::Error::other("native admission owner missing"))?.await;
        let _ = admission.take();
        let joined = granted??;
        // Recovery proves the controller itself consumed distinct fresh reads,
        // rather than mistaking an unread sampler update for cadence evidence.
        wait_state(&control, HostPressureState::Ready).await;
        let revoked = !opportunity.revalidate()?;
        drop(joined); // Proven unused grant; never submitted physical work.
        if !revoked {
            return Err(io::Error::other("fresh admission revived a revoked offer").into());
        }
        proof.recovery_witness("waited_grant_revoked", json!({"fresh_grant_joined": true, "old_offer_valid": false, "physical_work_started": false, "recovered_ready": true}))?;
        // This is the shared scheduling-offer contract. IO acceptance clocks
        // include admission/read latency and are recorded separately.
        if offered.elapsed() >= control.policy().optional_start_interval || control.take_optional_start()?.is_some() {
            return Err(io::Error::other("native optional cadence was not suppressed").into());
        }
        proof.recovery_witness("cadence_refused", json!({"elapsed_ns": u64::try_from(offered.elapsed().as_nanos())?, "fresh_read_since_offer": true, "second_offer": false}))?;
        source.pause();
        source.wait_for_readers(1).await;
        wait_state(&control, HostPressureState::Unknown).await;
        let (tasks, mut latest) = MemoryPrefetchTasks::spawn_guarded(
            paths.iter().map(|path| MemoryPrefetchCandidate { path: path.clone(), memory_mb: supplied.snapshot_memory_mb }),
            2 * u64::from(supplied.snapshot_memory_mb),
            GuardedPrefetchConfig { pressure: control.clone(), overhead_bytes: supplied.prefetch_overhead_bytes },
        )?;
        prefetch = Some(tasks);
        no_reads(&latest)?;
        proof.recovery_witness("burst_armed", decision(&control))?;
        source.one_read();
        wait_state(&control, HostPressureState::Recovering).await;
        no_reads(&latest)?;
        proof.recovery_witness("burst_recovering", decision(&control))?;
        wait_state(&control, HostPressureState::Unknown).await;
        no_reads(&latest)?;
        proof.recovery_witness("burst_expired", decision(&control))?;
        let suppressed = context.operations.snapshot()?;
        if suppressed.registered_operations != 0 || suppressed.tracked_tasks != 0 {
            return Err(io::Error::other("short recovery burst queued physical work").into());
        }
        proof.recovery_witness("sustained_started", json!({"accepted": latest.borrow().accepted,
            "registered_operations": suppressed.registered_operations, "tracked_tasks": suppressed.tracked_tasks}))?;
        source.resume();
        wait_state(&control, HostPressureState::Recovering).await;
        proof.recovery_witness("sustained_recovering", decision(&control))?;
        wait_state(&control, HostPressureState::Ready).await;
        proof.recovery_witness("sustained_ready", decision(&control))?;
        for accepted in 1..=2 {
            loop {
                let snapshot = latest.borrow_and_update().clone();
                if snapshot.accepted > accepted {
                    return Err(io::Error::other("native acceptance clock was missed").into());
                }
                if snapshot.accepted == accepted {
                    proof.recovery_witness("read_accepted", json!({"accepted": accepted, "completed": snapshot.completed, "read_bytes": snapshot.read_bytes}))?;
                    break;
                }
                latest.changed().await?;
            }
            // Do not let the next iteration reuse the same acceptance event.
            if accepted == 1 {
                while latest.borrow_and_update().accepted == 1 {
                    latest.changed().await?;
                }
            }
        }
        while !latest.borrow_and_update().finished {
            latest.changed().await?;
        }
        let final_read = latest.borrow().clone();
        if final_read.accepted != 2 || final_read.completed != 2 || final_read.cancelled != 0
            || final_read.failed != 0 || final_read.uncertain != 0 || final_read.read_bytes != 2 * bytes
            || final_read.deferred != 0 || final_read.last_error.is_some()
        {
            return Err(io::Error::other(format!("native recovery reads incomplete: {final_read:?}")).into());
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(final_read)
    }).await;
    // Reopen before joining even a failed/timed-out waiter. Cancellation of a
    // receiver is never evidence that its actual accepted read has completed.
    source.resume();
    let admission_join = match admission {
        Some(admission) => admission.await.map(drop),
        None => Ok(()),
    };
    if let Some(mut prefetch) = prefetch {
        prefetch.cancel();
        prefetch.drain().await;
    }
    let stopped = pressure.shutdown().await;
    admission_join?;
    let stopped = stopped?;
    let read = result.map_err(io::Error::other)??;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("native recovery pressure join unresolved").into());
    }
    // Reverify actual immutable bytes after both physical readers have joined.
    let checked_paths = paths.clone();
    let checked_hash = expected;
    tokio::task::spawn_blocking(move || -> TestResult<()> {
        for path in checked_paths {
            evidence::verify_file(&path, &checked_hash)?;
        }
        Ok(())
    })
    .await??;
    proof.recovery_witness("producers_joined", json!({
        "accepted": read.accepted, "completed": read.completed, "cancelled": read.cancelled,
        "failed": read.failed, "uncertain": read.uncertain, "read_bytes": read.read_bytes,
        "deferred": read.deferred, "last_error": read.last_error,
        "finished": read.finished, "prefetch_drained": true, "pressure_stopped": stopped.stopped,
        "producer_lost": stopped.producer_lost, "admission_joined": true,
        "copies_reverified": true, "samples": source.samples()?,
    }))?;
    let mut saving = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::Exact,
                envelope: inputs.envelope(),
                context: "native_recovery_final_inventory",
            },
        )
        .await?;
    let report = saving.join().await?;
    if !report.is_complete() {
        return Err(
            io::Error::other(format!("native recovery saving incomplete: {report:?}")).into(),
        );
    }
    Ok(())
}
