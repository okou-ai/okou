//! Actual Critical own-idle waves sharing P2 with a pending guarded snapshot reader.

use std::time::Duration;

use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::idle_pool::{IdlePoolIncoming, IdlePoolIncomingOwner};
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, GuardedPrefetchSnapshot, MemoryPrefetchCandidate, MemoryPrefetchTasks,
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

fn no_reads(read: &GuardedPrefetchSnapshot, finished: bool) -> TestResult<()> {
    if read.accepted != 0
        || read.completed != 0
        || read.cancelled != 0
        || read.failed != 0
        || read.uncertain != 0
        || read.deferred != 0
        || read.read_bytes != 0
        || read.last_error.is_some()
        || read.finished != finished
    {
        return Err(io::Error::other(format!(
            "Critical optional reader was not suppressed: {read:?}"
        ))
        .into());
    }
    Ok(())
}

fn read_evidence(read: &GuardedPrefetchSnapshot) -> Value {
    json!({
        "accepted": read.accepted, "completed": read.completed,
        "cancelled": read.cancelled, "failed": read.failed,
        "uncertain": read.uncertain, "deferred": read.deferred,
        "read_bytes": read.read_bytes, "last_error": read.last_error,
        "finished": read.finished,
    })
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
) -> TestResult<()> {
    let proof = proof.ok_or_else(|| io::Error::other("Critical needs measured owners"))?;
    let policy = inputs.pressure_policy()?;
    if policy.max_wave_entries.get() != 1 {
        return Err(io::Error::other("Critical corpus requires single-entry wave bound").into());
    }
    let raw = std::fs::read(std::env::var("OKOU_TEST_OPTIONAL_MEMORY_POLICY")?)?;
    let supplied: Inputs = serde_json::from_slice(&raw)?;
    let original = PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?).join("memory.bin");
    let bytes = original.metadata()?.len();
    policy.bounds.growth_bytes(
        supplied.snapshot_memory_mb,
        supplied.prefetch_overhead_bytes,
    )?;
    if std::fs::canonicalize(&original)? != std::fs::canonicalize(&supplied.snapshot_path)?
        || supplied.snapshot_memory_mb != 4096
        || bytes != 4096 * 1024 * 1024
        || supplied.prefetch_overhead_bytes < 1024 * 1024
    {
        return Err(io::Error::other("Critical snapshot identity/shape is invalid").into());
    }
    let checked = original.clone();
    let expected = proof.snapshot_memory_hash()?.to_owned();
    let hash = expected.clone();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;

    let mut backings = Vec::new();
    let mut blanks = Vec::new();
    for _ in 0..2 {
        let candidate = transitions::prepare_incoming(&context, inputs, true).await?;
        let mut incoming = IdlePoolIncoming::park(candidate);
        if let Err(error) = incoming.capture_backing() {
            proof.retain(incoming);
            return Err(error.into());
        }
        let backing = match incoming.captured_backing() {
            Ok(backing) => backing,
            Err(error) => {
                proof.retain(incoming);
                return Err(error.into());
            }
        };
        let identity = backing.identity();
        let id = incoming
            .sandbox_id()
            .ok_or_else(|| io::Error::other("Critical incoming identity missing"))?;
        blanks.push(
            json!({"sandbox_id": id, "backing_generation": identity.generation().to_string()}),
        );
        backings.push((backing, identity));
        let candidate = match incoming.into_owner() {
            Some(IdlePoolIncomingOwner::Parked(candidate)) => candidate,
            owner => {
                proof.retain(owner);
                return Err(io::Error::other("Critical incoming lost its parked owner").into());
            }
        };
        let parked = context.pool.lock().await.park(candidate);
        if !matches!(parked, ParkResult::Parked) {
            proof.retain(parked);
            return Err(io::Error::other("Critical initial inventory displaced an owner").into());
        }
    }
    if context.budget.allocated() != (6, 12288, 3) || !context.budget.can_afford(2, 4096) {
        return Err(
            io::Error::other("Critical corpus lost full initial leases/spare capacity").into(),
        );
    }
    proof.critical_witness(
        "inputs_verified",
        json!({
            "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&raw),
            "snapshot_sha256": expected, "snapshot_bytes": bytes,
            "snapshot_memory_mb": supplied.snapshot_memory_mb,
            "prefetch_overhead_bytes": supplied.prefetch_overhead_bytes,
            "blanks": blanks, "allocated": context.budget.allocated(), "profile_can_fit": true,
        }),
    )?;

    source.pause();
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    })?;
    let control = pressure.optional_preparation();
    let spawned = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: original.clone(),
            memory_mb: supplied.snapshot_memory_mb,
        }],
        u64::from(supplied.snapshot_memory_mb),
        GuardedPrefetchConfig {
            pressure: control.clone(),
            overhead_bytes: supplied.prefetch_overhead_bytes,
        },
    );
    // Even a prefetch preflight error must positively join the held sampler.
    let (mut prefetch, reads) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            source.resume();
            let _ = pressure.shutdown().await?;
            return Err(error.into());
        }
    };
    let mut updates = pressure.subscribe();
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        no_reads(&reads.borrow(), false)?;
        let pending = context.operations.snapshot()?;
        if control.decision().state != HostPressureState::Unknown
            || pending.registered_operations != 0 || pending.tracked_tasks != 0
        {
            return Err(io::Error::other("Critical initial suppression is not Unknown/quiescent").into());
        }
        proof.critical_witness("initial_unknown", json!({
            "state": "Unknown", "reads": read_evidence(&reads.borrow()),
            "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
        }))?;
        // Let only the sampler classify real Critical first. Its first wave's
        // admission reads remain held until that classification is witnessed.
        source.one_read();
        let mut last = None;
        let mut completion_observed = None;
        let mut waves = 0;
        let mut observed = false;
        loop {
            let snapshot = updates.borrow_and_update().clone();
            no_reads(&reads.borrow(), false)?;
            if snapshot.producer_lost {
                return Err(io::Error::other("Critical pressure producer lost").into());
            }
            if snapshot.decision.state == HostPressureState::Critical && !observed {
                observed = true;
                proof.critical_witness("critical_observed", json!({
                    "state": "Critical", "available_bytes": snapshot.decision.available_bytes,
                    "wave_inflight": snapshot.decision.wave_inflight, "reads": read_evidence(&reads.borrow()),
                }))?;
                source.resume();
            } else if matches!(snapshot.decision.state, HostPressureState::Ready | HostPressureState::Recovering) {
                return Err(io::Error::other("Critical native condition changed to recovery").into());
            }
            if let Some(wave) = snapshot.last_wave.as_ref()
                && !last.as_ref().is_some_and(|last| Arc::ptr_eq(last, wave))
            {
                // A completed wave intentionally invalidates the old sample.
                // Require a new physical read after observing that completion;
                // Unknown/BeforeWaveCompletion cannot certify the next wave.
                let completed_at = *completion_observed.get_or_insert(evidence::clocks()?.0);
                let now = evidence::clocks()?.0;
                let fresh = source.samples()?.iter().any(|sample| {
                    sample["started_ns"].as_u64().is_some_and(|started| started > completed_at)
                        && sample["finished_ns"].as_u64().is_some_and(|finished| finished <= now)
                        && sample["available_bytes"].as_u64() == snapshot.decision.available_bytes
                });
                if snapshot.decision.state != HostPressureState::Critical || !fresh {
                    updates.changed().await?;
                    continue;
                }
                if !observed || wave.selected != 1 || wave.completed != 1 || wave.uncertain != 0
                    || !wave.not_started.is_empty() || wave.skipped != 0
                    || wave.stop.is_some() || wave.status_error.is_some() || !wave.is_resolved()
                {
                    return Err(io::Error::other(format!("Critical wave is incomplete: {wave:?}")).into());
                }
                waves += 1;
                let remaining = 3_u32.checked_sub(waves).ok_or_else(|| io::Error::other("extra Critical wave"))?;
                let allocated = context.budget.allocated();
                if allocated != (remaining * 2, remaining * 4096, usize::try_from(remaining)?) {
                    return Err(io::Error::other("Critical wave lost its full logical ownership").into());
                }
                proof.critical_witness("wave_completed", json!({
                    "index": waves, "selected": wave.selected, "completed": wave.completed,
                    "completion_observed_ns": completed_at,
                    "uncertain": wave.uncertain, "not_started": wave.not_started.len(),
                    "skipped": wave.skipped, "stop": null, "status_error": false, "resolved": wave.is_resolved(),
                    "state": "Critical", "available_bytes": snapshot.decision.available_bytes,
                    "allocated": allocated, "reads": read_evidence(&reads.borrow()),
                }))?;
                last = Some(wave.clone());
                completion_observed = None;
                if waves == 3 { break; }
            }
            updates.changed().await?;
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    // Reopen every external reader and join actual owners even after refusal.
    source.resume();
    prefetch.cancel();
    prefetch.drain().await;
    let stopped = pressure.shutdown().await?;
    outcome.map_err(io::Error::other)??;
    no_reads(&reads.borrow(), true)?;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("Critical pressure shutdown unresolved").into());
    }
    let mut exits = Vec::new();
    for (backing, identity) in backings {
        if !backing.exit_confirmed().await || backing.identity() != identity {
            return Err(
                io::Error::other("Critical blank original backing exit unconfirmed").into(),
            );
        }
        exits.push(json!({"backing_generation": identity.generation().to_string(), "exit_confirmed": true}));
    }
    if !context.pool.lock().await.is_empty() || context.budget.allocated() != (0, 0, 0) {
        return Err(io::Error::other("Critical inventory/leases remain after joined waves").into());
    }
    let pending = context.operations.snapshot()?;
    if pending.registered_operations != 0 || pending.tracked_tasks != 0 {
        return Err(io::Error::other("Critical shared P2 still has physical work").into());
    }
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&original, &hash)).await??;
    proof.critical_witness("producers_joined", json!({
        "waves": 3, "reads": read_evidence(&reads.borrow()),
        "prefetch_drained": true, "pressure_stopped": stopped.stopped, "producer_lost": stopped.producer_lost,
        "wave_inflight": stopped.decision.wave_inflight, "blank_exits": exits,
        "allocated": context.budget.allocated(), "inventory_empty": true,
        "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
        "snapshot_reverified": true, "samples": source.samples()?,
    }))?;
    Ok(())
}
