//! Actual foreground progress, with independently owned reporting and saving.

use std::time::Duration;

use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use sandbox::SandboxBackingProcess;
use serde_json::json;

use super::*;

fn runtime_complete(
    read: &runner_lifecycle::prefetch::GuardedPrefetchSnapshot,
    bytes: u64,
) -> TestResult<()> {
    if read.accepted != 1
        || read.completed != 1
        || read.cancelled != 0
        || read.failed != 0
        || read.uncertain != 0
        || read.read_bytes != bytes
        || read.last_error.is_some()
        || !read.finished
    {
        return Err(io::Error::other(format!(
            "native foreground runtime read incomplete: {read:?}"
        ))
        .into());
    }
    Ok(())
}

pub struct Request<'a> {
    pub context: transitions::Context,
    pub inputs: &'a fixture::Inputs,
    pub source: &'a Arc<recovery_source::Source>,
    pub proof: Option<&'a Arc<evidence::Case>>,
    pub directory: &'a std::path::Path,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub original_run: RunId,
    pub fresh: bool,
}

pub async fn exercise(request: Request<'_>) -> TestResult<()> {
    let Request {
        context,
        inputs,
        source,
        proof,
        directory,
        backing,
        original_run,
        fresh,
    } = request;
    let proof = proof.ok_or_else(|| io::Error::other("foreground requires measured owners"))?;
    let original = startup::original(&context.budget, inputs, proof).await?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(gate.clone())?;
    proof.foreground_witness("inputs_verified", json!({
        "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&original.raw),
        "snapshot_sha256": proof.snapshot_memory_hash()?, "snapshot_bytes": original.bytes,
        "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": original.overhead,
        "allocated": context.budget.allocated(), "startup_pressure_guarded": false,
        "kind": if fresh {"Fresh"} else {"Reuse"},
    }))?;
    source.pause();
    let spawned = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy: inputs.pressure_policy()?,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    });
    let pressure = match spawned {
        Ok(pressure) => pressure,
        Err(error) => {
            source.resume();
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let control = pressure.optional_preparation();
    let guarded = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: original.path.clone(),
            memory_mb: 4096,
        }],
        4096,
        GuardedPrefetchConfig {
            pressure: control.clone(),
            overhead_bytes: original.overhead,
        },
    );
    let (mut runtime, reads) = match guarded {
        Ok(guarded) => guarded,
        Err(error) => {
            pressure.stop();
            source.resume();
            let stopped = pressure.shutdown().await;
            let reporting = probe.finish().await;
            stopped?;
            reporting?;
            return Err(error.into());
        }
    };
    let mut pool_hold = Some(context.pool.lock().await);
    let pool_held_ns = evidence::clocks()?.0;
    let mut status_hold = Some(context.status.hold_state_for_test().await);
    let status_held_ns = evidence::clocks()?.0;
    let mut startup_owner = None;
    let mut foreground = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        let (pool_wait, pool_entered) = tokio::sync::oneshot::channel();
        let (status_wait, status_entered) = tokio::sync::oneshot::channel();
        foreground = Some(tokio::spawn(foreground_growth::exercise(
            foreground_growth::Request {
                context: context.clone(),
                plan: inputs.replacement_plan()?,
                preparation_bytes: inputs.preparation_bytes(),
                envelope: inputs.envelope(),
                proof: proof.clone(),
                backing,
                original: original_run,
                fresh,
                pool_wait,
                status_wait,
            },
        )));
        pool_entered.await?;
        let owner = startup_owner.insert(MemoryPrefetchTasks::spawn(
            [MemoryPrefetchCandidate {
                path: original.path.clone(),
                memory_mb: 4096,
            }],
            4096,
        ));
        owner.drain().await;
        let startup = owner.startup_snapshot()?;
        startup::completed(&startup, original.bytes)?;
        critical::no_reads(&reads.borrow(), false)?;
        let observed = foreground_probe::observe().await?;
        if probe.has_receipts()? || control.decision().state != HostPressureState::Unknown {
            return Err(io::Error::other("native held pool/Unknown was not preserved").into());
        }
        proof.foreground_witness(
            "pool_wait_progress",
            json!({
                "startup": startup::read_evidence(&startup), "startup_drained": true,
                "reads": critical::read_evidence(&reads.borrow()), "state": "Unknown",
            "pool_held": true, "status_held": true, "heartbeat_received": false,
            "foreground_pool_wait_polled": true,
            "pool_held_ns": pool_held_ns, "status_held_ns": status_held_ns,
                "observer": observed,
            }),
        )?;
        drop(pool_hold.take());
        let pool_released_ns = evidence::clocks()?.0;
        status_entered.await?;
        let status_wait_polled_ns = evidence::clocks()?.0;
        probe.request()?;
        source.resume();
        let heartbeat = probe.complete().await?;
        runtime.drain().await;
        runtime_complete(&reads.borrow(), original.bytes)?;
        let decision = control.decision();
        if decision.state != HostPressureState::Ready {
            return Err(
                io::Error::other("native runtime completion lacks actual sustained Ready").into(),
            );
        }
        let observed = foreground_probe::observe().await?;
        proof.foreground_witness(
            "status_wait_progress",
            json!({
                "state": "Ready", "available_bytes": decision.available_bytes,
            "status_held": true, "heartbeat": heartbeat, "observer": observed,
            "foreground_status_wait_polled": true,
            "status_held_ns": status_held_ns, "pool_released_ns": pool_released_ns,
            "status_wait_polled_ns": status_wait_polled_ns,
            "samples": source.samples()?,
                "reads": critical::read_evidence(&reads.borrow()), "runtime_drained": true,
            }),
        )?;
        drop(status_hold.take());
        gate.wait_entered().await?;
        proof.require_full_lease()?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        let observed = foreground_probe::observe().await?;
        proof.require_full_lease()?;
        proof.foreground_witness(
            "physical_io_wait_progress",
            json!({
                "kernel_io_entered": true, "release_byte_withheld": true,
                "full_original_lease": [2, 4096, 1], "allocated": context.budget.allocated(),
                "heartbeat": heartbeat, "observer": observed,
            }),
        )?;
        gate.release()?;
        let completed = foreground
            .as_mut()
            .ok_or_else(|| io::Error::other("foreground owner missing"))?
            .await;
        foreground.take();
        completed??;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    })
    .await;
    // Cancellation never retracts accepted kernel/Guest work. Retain handles,
    // release only our own waits, then join before returning the refusal.
    drop(pool_hold.take());
    drop(status_hold.take());
    let released = gate.release();
    pressure.stop();
    source.resume();
    runtime.cancel();
    runtime.drain().await;
    if let Some(owner) = &mut startup_owner {
        owner.cancel();
        owner.drain().await;
    }
    let foreground_join = match foreground {
        Some(work) => Some(work.await),
        None => None,
    };
    let stopped = pressure.shutdown().await;
    let reporting = probe.finish().await;
    outcome.map_err(io::Error::other)??;
    released?;
    if let Some(result) = foreground_join {
        result??;
    }
    let stopped = stopped?;
    reporting?;
    if stopped.producer_lost
        || !stopped.stopped
        || stopped.decision.wave_inflight
        || context.budget.allocated() != (0, 0, 0)
        || !context.pool.lock().await.is_empty()
    {
        return Err(io::Error::other(
            "native foreground producers/original ownership did not resolve",
        )
        .into());
    }
    runtime_complete(&reads.borrow(), original.bytes)?;
    let startup = startup_owner
        .as_ref()
        .ok_or_else(|| io::Error::other("startup owner missing"))?
        .startup_snapshot()?;
    startup::completed(&startup, original.bytes)?;
    let path = original.path;
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&path, &hash)).await??;
    let pending = context.operations.snapshot()?;
    if pending.registered_operations != 0 || pending.tracked_tasks != 0 {
        return Err(io::Error::other("native foreground shared P2 has unjoined work").into());
    }
    proof.foreground_witness("producers_joined", json!({
        "startup": startup::read_evidence(&startup), "reads": critical::read_evidence(&reads.borrow()),
        "startup_drained": true, "runtime_drained": true, "foreground_joined": true,
        "pressure_stopped": true, "producer_lost": false, "wave_inflight": false,
        "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
        "snapshot_reverified": true, "allocated": [0, 0, 0],
        "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
    }))?;
    Ok(())
}
