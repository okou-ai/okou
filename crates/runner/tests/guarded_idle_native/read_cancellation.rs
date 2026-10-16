//! Actual original-file reads retain physical custody through cancelled drains.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, GuardedPrefetchSnapshot, MemoryPrefetchCandidate, MemoryPrefetchTasks,
    PrefetchReadCheckpoint,
};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::*;

const CHUNK: u64 = 1024 * 1024;

struct Reader {
    owner: MemoryPrefetchTasks,
    runtime: Option<watch::Receiver<GuardedPrefetchSnapshot>>,
}

impl Reader {
    fn report(&self) -> TestResult<Value> {
        Ok(match &self.runtime {
            Some(latest) => critical::read_evidence(&latest.borrow()),
            None => startup::read_evidence(&self.owner.startup_snapshot()?),
        })
    }

    fn cancelled(&self) -> TestResult<Value> {
        let value = self.report()?;
        let expected = if self.runtime.is_some() {
            json!({"accepted": 1, "completed": 0, "cancelled": 1,
                "failed": 0, "read_bytes": CHUNK, "last_error": null,
                "uncertain": 0, "deferred": 0, "finished": true})
        } else {
            json!({"accepted": 1, "completed": 0, "cancelled": 1,
                "failed": 0, "read_bytes": CHUNK, "last_error": null})
        };
        if value != expected {
            return Err(
                io::Error::other(format!("actual cancelled read did not join: {value}")).into(),
            );
        }
        Ok(value)
    }
}

fn accounting(context: &transitions::Context, growth: u64) -> TestResult<Value> {
    let value = context.operations.snapshot()?;
    if value.registered_operations != usize::from(growth > 0)
        || value.started != usize::from(growth > 0)
        || value.ordinary_growth_bytes != growth
        || value.cleanup_growth_bytes != 0
        || value.uncertain != 0
        || (growth > 0 && value.tracked_tasks == 0)
        || (growth == 0 && value.tracked_tasks != 0)
    {
        return Err(
            io::Error::other(format!("actual read lost original P2 custody: {value:?}")).into(),
        );
    }
    Ok(
        json!({"registered_operations": value.registered_operations, "started": value.started,
        "ordinary_growth_bytes": value.ordinary_growth_bytes, "tracked_tasks": value.tracked_tasks,
        "cleanup_growth_bytes": value.cleanup_growth_bytes, "uncertain": value.uncertain}),
    )
}

fn checkpoint(gate: Arc<foreground_io::Gate>, bytes: Arc<AtomicU64>) -> PrefetchReadCheckpoint {
    Arc::new(move |count| {
        if count != CHUNK || bytes.swap(count, Ordering::SeqCst) != 0 {
            return Err(io::Error::other("actual original read checkpoint changed"));
        }
        gate.blocking_wait()
    })
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
    directory: &std::path::Path,
) -> TestResult<()> {
    let proof = proof.ok_or_else(|| io::Error::other("read cancellation needs measured owners"))?;
    let original = startup::original(&context.budget, inputs, proof).await?;
    let growth = original
        .bytes
        .checked_add(original.overhead)
        .ok_or_else(|| io::Error::other("original read growth overflow"))?;
    let policy = inputs.pressure_policy()?;
    let first_sample = source.samples()?.len();
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
        source.wait_for_readers(1).await;
        proof.read_cancellation_witness("inputs_verified", json!({
            "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&original.raw),
            "snapshot_sha256": proof.snapshot_memory_hash()?, "snapshot_bytes": original.bytes,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": original.overhead,
            "checkpoint_bytes": CHUNK, "startup_pressure_guarded": false,
            "checkpoint_models_stalled_storage": false, "allocated": context.budget.allocated(),
        }))?;
        for (index, gate) in gates.iter().enumerate() {
            let guarded = index == 1;
            let name = if guarded { "runtime" } else { "startup" };
            if guarded {
                source.resume();
                loop {
                    let changed = control.changed();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    if control.decision().state == HostPressureState::Ready { break; }
                    changed.await;
                }
            }
            let bytes = Arc::new(AtomicU64::new(0));
            let checkpoint = checkpoint(gate.clone(), bytes.clone());
            let candidates = [MemoryPrefetchCandidate { path: original.path.clone(), memory_mb: 4096 }];
            let reader = if guarded {
                let (owner, latest) = MemoryPrefetchTasks::spawn_guarded_with_read_checkpoint_for_test(
                    candidates, 4096, GuardedPrefetchConfig { pressure: control.clone(), overhead_bytes: original.overhead }, checkpoint)?;
                Reader { owner, runtime: Some(latest) }
            } else {
                Reader { owner: MemoryPrefetchTasks::spawn_with_read_checkpoint_for_test(candidates, 4096, checkpoint), runtime: None }
            };
            readers.push(reader);
            let reader = readers.last_mut().ok_or_else(|| io::Error::other("read owner missing"))?;
            gate.wait_entered().await?;
            let held_ns = evidence::clocks()?.0;
            if bytes.load(Ordering::SeqCst) != CHUNK {
                return Err(io::Error::other("actual original File bytes are absent").into());
            }
            if let Some(latest) = &mut reader.runtime {
                loop {
                    if latest.borrow_and_update().accepted == 1 { break; }
                    latest.changed().await?;
                }
            }
            let state = control.decision();
            if state.state != if guarded { HostPressureState::Ready } else { HostPressureState::Unknown } {
                return Err(io::Error::other("accepted read actual pressure state changed").into());
            }
            proof.require_full_lease()?;
            proof.read_cancellation_witness(&format!("{name}_accepted"), json!({
                "state": format!("{:?}",state.state), "available_bytes": state.available_bytes,
                "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
                "held_ns": held_ns, "checkpoint_bytes": bytes.load(Ordering::SeqCst),
                "read": reader.report()?, "accounting": accounting(&context, if guarded { growth } else { 0 })?,
                "allocated": context.budget.allocated(), "release_byte_withheld": true,
            }))?;
            reader.owner.cancel();
            let cancelled_ns = evidence::clocks()?.0;
            {
                let first = reader.owner.drain();
                tokio::pin!(first);
                if futures_util::poll!(&mut first).is_ready() {
                    return Err(io::Error::other("first drain abandoned accepted actual IO").into());
                }
            }
            let first_drain_dropped_ns = evidence::clocks()?.0;
            let release_ns;
            {
                let second = reader.owner.drain();
                tokio::pin!(second);
                if futures_util::poll!(&mut second).is_ready() {
                    return Err(io::Error::other("second drain forgot accepted actual IO").into());
                }
                let second_pending_ns = evidence::clocks()?.0;
                probe.request()?;
                let heartbeat = probe.complete().await?;
                let observer = foreground_probe::observe().await?;
                proof.require_full_lease()?;
                proof.read_cancellation_witness(&format!("{name}_cancel_wait"), json!({
                    "held_ns": held_ns, "cancelled_ns": cancelled_ns,
                    "first_drain_dropped_ns": first_drain_dropped_ns, "second_pending_ns": second_pending_ns,
                    "first_drain_pending": true, "first_drain_dropped": true, "second_drain_pending": true,
                    "release_byte_withheld": true, "checkpoint_bytes": bytes.load(Ordering::SeqCst),
                    "accounting": accounting(&context, if guarded { growth } else { 0 })?,
                    "allocated": context.budget.allocated(), "heartbeat": heartbeat, "observer": observer,
                }))?;
                release_ns = evidence::clocks()?.0;
                gate.release()?;
                second.await;
            }
            let released_ns = evidence::clocks()?.0;
            proof.require_full_lease()?;
            proof.read_cancellation_witness(&format!("{name}_joined"), json!({
                "read": reader.cancelled()?, "physical_drain_joined": true,
                "accounting": accounting(&context, 0)?, "allocated": context.budget.allocated(),
                "release_ns": release_ns, "joined_ns": released_ns,
                "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            }))?;
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    // Refusal and timeout also release only owned checkpoints, then positively
    // join accepted readers before the sampler, reporting and factory dependencies.
    let releases = gates.iter().map(|gate| gate.release()).collect::<Vec<_>>();
    source.resume();
    for reader in &mut readers {
        reader.owner.cancel();
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
        return Err(io::Error::other("read cancellation dependencies did not join").into());
    }
    let [startup, runtime] = readers.as_slice() else {
        return Err(
            io::Error::other("read cancellation did not join both original readers").into(),
        );
    };
    let checked = original.path.clone();
    let expected = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &expected)).await??;
    proof.require_full_lease()?;
    proof.read_cancellation_witness(
        "producers_joined",
        json!({
            "startup": startup.cancelled()?, "runtime": runtime.cancelled()?,
            "startup_drained": true, "runtime_drained": true, "pressure_stopped": true,
            "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
            "snapshot_reverified": true, "accounting": accounting(&context, 0)?,
            "allocated": context.budget.allocated(),
        }),
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
                context: "native_read_cancellation_required_saving",
            },
        )
        .await?;
    let completion = batch.join().await?;
    if !completion.is_complete() || completion.selected != 1 || completion.completed != 1 {
        return Err(io::Error::other("read cancellation original saving incomplete").into());
    }
    Ok(())
}
