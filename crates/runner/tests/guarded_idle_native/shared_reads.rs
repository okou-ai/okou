//! Two caller-orchestrated guarded readers, never production startup activation.

use std::time::Duration;

use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, GuardedPrefetchSnapshot, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::*;

const CHUNK: u64 = 1024 * 1024;

struct Reader {
    owner: MemoryPrefetchTasks,
    latest: watch::Receiver<GuardedPrefetchSnapshot>,
}

impl Reader {
    fn evidence(&self) -> Value {
        critical::read_evidence(&self.latest.borrow())
    }

    fn require(&self, completed: bool, cancelled: bool, bytes: u64) -> TestResult<()> {
        let value = self.latest.borrow();
        if value.accepted != 1
            || value.completed != usize::from(completed)
            || value.cancelled != usize::from(cancelled)
            || value.read_bytes != bytes
            || value.failed != 0
            || value.uncertain != 0
            || value.finished != (completed || cancelled)
        {
            return Err(io::Error::other(format!(
                "shared actual reader outcome changed: {value:?}"
            ))
            .into());
        }
        Ok(())
    }
}

fn accounting(context: &transitions::Context, readers: usize, growth: u64) -> TestResult<Value> {
    let value = context.operations.snapshot()?;
    if value.registered_operations != readers
        || value.started != readers
        || value.ordinary_growth_bytes != readers as u64 * growth
        || value.cleanup_growth_bytes != 0
        || value.uncertain != 0
        || value.tracked_tasks < readers
        || (readers == 0 && value.tracked_tasks != 0)
    {
        return Err(io::Error::other(format!(
            "shared actual readers lost aggregate custody: {value:?}"
        ))
        .into());
    }
    Ok(
        json!({"registered_operations": value.registered_operations, "started": value.started,
        "ordinary_growth_bytes": value.ordinary_growth_bytes, "tracked_tasks": value.tracked_tasks,
        "cleanup_growth_bytes": value.cleanup_growth_bytes, "uncertain": value.uncertain}),
    )
}

async fn join_accounting(context: &transitions::Context) -> TestResult<()> {
    // Readers have positively drained. Result delivery can precede the last
    // P2 callback-tracking drop, which must finish before zero-custody evidence.
    tokio::time::timeout(Duration::from_secs(5), async {
        while context.operations.snapshot()?.tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
        Ok::<(), MemoryOperationError>(())
    })
    .await
    .map_err(io::Error::other)??;
    Ok(())
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
    directory: &std::path::Path,
) -> TestResult<()> {
    let proof = proof.ok_or_else(|| io::Error::other("shared reads require measured owners"))?;
    let original = startup::original(&context.budget, inputs, proof).await?;
    let growth = original
        .bytes
        .checked_add(original.overhead)
        .ok_or_else(|| io::Error::other("shared read growth overflow"))?;
    let first_sample = source.samples()?.len();
    let policy = inputs.pressure_policy()?;
    let gates = [
        Arc::new(foreground_io::Gate::new()?),
        Arc::new(foreground_io::Gate::new()?),
    ];
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    source.pause();
    let pressure = match IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    }) {
        Ok(owner) => owner,
        Err(error) => {
            source.resume();
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let control = pressure.optional_preparation();
    let mut readers = Vec::<Reader>::new();
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        proof.shared_reads_witness("inputs_verified", json!({
            "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&original.raw),
            "snapshot_sha256": proof.snapshot_memory_hash()?, "snapshot_bytes": original.bytes,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": original.overhead,
            "checkpoint_bytes": CHUNK, "production_startup_integrated": false,
            "checkpoint_models_stalled_storage": false, "allocated": context.budget.allocated(),
        }))?;
        for gate in &gates {
            let held = gate.clone();
            let (owner, latest) = MemoryPrefetchTasks::spawn_guarded_with_read_checkpoint_for_test(
                [MemoryPrefetchCandidate { path: original.path.clone(), memory_mb: 4096 }], 4096,
                GuardedPrefetchConfig { pressure: control.clone(), overhead_bytes: original.overhead },
                Arc::new(move |bytes| {
                    if bytes == CHUNK { held.blocking_wait()?; }
                    Ok(())
                }),
            )?;
            readers.push(Reader { owner, latest });
        }
        source.wait_for_readers(1).await;
        let [first, second] = readers.as_slice() else { return Err(io::Error::other("shared read owners missing").into()); };
        critical::no_reads(&first.latest.borrow(), false)?;
        critical::no_reads(&second.latest.borrow(), false)?;
        if control.decision().state != HostPressureState::Unknown {
            return Err(io::Error::other("shared readers bypassed initial Unknown").into());
        }
        proof.shared_reads_witness("initial_unknown", json!({"state": "Unknown",
            "first": first.evidence(), "second": second.evidence(), "accounting": accounting(&context, 0, growth)?}))?;
        source.resume();
        for gate in &gates { gate.wait_entered().await?; }
        for reader in &mut readers {
            loop {
                if reader.latest.borrow_and_update().accepted == 1 { break; }
                reader.latest.changed().await?;
            }
            reader.require(false, false, 0)?;
        }
        let [first, second] = readers.as_mut_slice() else { return Err(io::Error::other("shared read owners missing").into()); };
        let decision = control.decision();
        if decision.state != HostPressureState::Ready {
            return Err(io::Error::other("concurrent actual reads lack sustained Ready").into());
        }
        proof.require_full_lease()?;
        proof.shared_reads_witness("both_accepted", json!({"state": "Ready", "available_bytes": decision.available_bytes,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "first": first.evidence(), "second": second.evidence(), "accounting": accounting(&context, 2, growth)?,
            "checkpoint_bytes": [CHUNK, CHUNK], "release_bytes_withheld": true, "allocated": context.budget.allocated()}))?;
        first.owner.cancel();
        let cancelled_ns = evidence::clocks()?.0;
        {
            let drain = first.owner.drain();
            tokio::pin!(drain);
            if futures_util::poll!(&mut drain).is_ready() {
                return Err(io::Error::other("first shared drain abandoned physical IO").into());
            }
        }
        let first_drain_dropped_ns = evidence::clocks()?.0;
        let first_release_ns;
        {
            let drain = first.owner.drain();
            tokio::pin!(drain);
            if futures_util::poll!(&mut drain).is_ready() {
                return Err(io::Error::other("replacement shared drain forgot physical IO").into());
            }
            let second_pending_ns = evidence::clocks()?.0;
            probe.request()?;
            let heartbeat = probe.complete().await?;
            let observer = foreground_probe::observe().await?;
            proof.require_full_lease()?;
            proof.shared_reads_witness("cancel_wait", json!({"cancelled_ns": cancelled_ns,
                "first_drain_dropped_ns": first_drain_dropped_ns, "second_pending_ns": second_pending_ns,
                "first_drain_pending": true, "first_drain_dropped": true, "second_drain_pending": true,
                "release_bytes_withheld": true, "accounting": accounting(&context, 2, growth)?,
                "second": second.evidence(), "heartbeat": heartbeat, "observer": observer,
                "allocated": context.budget.allocated()}))?;
            first_release_ns = evidence::clocks()?.0;
            gates[0].release()?;
            drain.await;
        }
        let first_joined_ns = evidence::clocks()?.0;
        first.require(false, true, CHUNK)?;
        second.require(false, false, 0)?;
        proof.shared_reads_witness("first_joined", json!({"first": first.evidence(), "second": second.evidence(),
            "release_ns": first_release_ns, "joined_ns": first_joined_ns, "physical_drain_joined": true,
            "accounting": accounting(&context, 1, growth)?, "second_release_withheld": true,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "allocated": context.budget.allocated()}))?;
        let release_ns = evidence::clocks()?.0;
        gates[1].release()?;
        second.owner.drain().await;
        join_accounting(&context).await?;
        let joined_ns = evidence::clocks()?.0;
        second.require(true, false, original.bytes)?;
        proof.shared_reads_witness("second_joined", json!({"first": first.evidence(), "second": second.evidence(),
            "release_ns": release_ns, "joined_ns": joined_ns, "physical_drain_joined": true,
            "accounting": accounting(&context, 0, growth)?,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "allocated": context.budget.allocated()}))?;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    // Refusal/timeout cannot abandon either accepted File producer or its dependencies.
    for reader in &readers {
        reader.owner.cancel();
    }
    let releases = gates.iter().map(|gate| gate.release()).collect::<Vec<_>>();
    source.resume();
    for reader in &mut readers {
        reader.owner.drain().await;
    }
    pressure.stop();
    let stopped = pressure.shutdown().await;
    let reporting = probe.finish().await;
    for released in releases {
        released?;
    }
    let stopped = stopped?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("shared reader pressure dependencies did not join").into());
    }
    let [first, second] = readers.as_slice() else {
        return Err(io::Error::other("shared read owners missing").into());
    };
    first.require(false, true, CHUNK)?;
    second.require(true, false, original.bytes)?;
    let checked = original.path.clone();
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
    proof.require_full_lease()?;
    proof.shared_reads_witness(
        "producers_joined",
        json!({"first": first.evidence(), "second": second.evidence(),
        "readers_drained": true, "pressure_stopped": true, "heartbeat_joined": true,
        "provider_joined": true, "peer_joined": true, "snapshot_reverified": true,
        "accounting": accounting(&context, 0, growth)?, "allocated": context.budget.allocated()}),
    )?;
    let mut batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_shared_reads_required_saving",
            },
        )
        .await?;
    let result = batch.join().await?;
    if !result.is_complete() || result.selected != 1 || result.completed != 1 {
        return Err(io::Error::other("shared readers original saving incomplete").into());
    }
    Ok(())
}
