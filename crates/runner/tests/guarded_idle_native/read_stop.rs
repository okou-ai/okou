//! Pressure/sampler shutdown cannot discharge independently accepted File producers.

use std::time::Duration;

use runner_lifecycle::host_memory_pressure::{HostPressureState, OptionalPressureControl};
use runner_lifecycle::prefetch::GuardedPrefetchConfig;
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde_json::json;

use super::guarded_readers::{CHUNK, Reader, accounting, join_accounting};
use super::*;

fn require_closed(control: &OptionalPressureControl) -> TestResult<()> {
    if !control.stopped().is_cancelled()
        || control.decision().state != HostPressureState::Unknown
        || !matches!(
            control.take_optional_start(),
            Err(MemoryOperationError::Closed)
        )
    {
        return Err(io::Error::other("stopped pressure still offers optional growth").into());
    }
    Ok(())
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
    directory: &std::path::Path,
) -> TestResult<()> {
    let proof = proof.ok_or_else(|| io::Error::other("read stop requires measured owners"))?;
    let original = startup::original(&context.budget, inputs, proof).await?;
    let growth = original
        .bytes
        .checked_add(original.overhead)
        .ok_or_else(|| io::Error::other("read stop growth overflow"))?;
    let first_sample = source.samples()?.len();
    let policy = inputs.pressure_policy()?;
    let gates = [
        Arc::new(foreground_io::Gate::new()?),
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
    let mut updates = pressure.subscribe();
    // Constructing this lazy future does not stop the owner. Retain it through
    // all Pending observations and refusal cleanup, including timeout.
    let mut shutdown = Box::pin(pressure.shutdown());
    let mut shutdown_result = None;
    let mut readers = Vec::<Reader>::new();
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        proof.read_stop_witness("inputs_verified", json!({
            "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&original.raw),
            "snapshot_sha256": proof.snapshot_memory_hash()?, "snapshot_bytes": original.bytes,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": original.overhead,
            "checkpoint_bytes": CHUNK, "production_startup_integrated": false,
            "checkpoint_models_stalled_storage": false, "allocated": context.budget.allocated(),
        }))?;
        for gate in &gates[..2] {
            readers.push(Reader::spawn(original.path.clone(), GuardedPrefetchConfig {
                pressure: control.clone(), overhead_bytes: original.overhead,
            }, gate.clone())?);
        }
        source.wait_for_readers(1).await;
        for reader in &readers { critical::no_reads(&reader.latest.borrow(), false)?; }
        let [first, second] = readers.as_slice() else {
            return Err(io::Error::other("read stop initial owners missing").into());
        };
        if control.decision().state != HostPressureState::Unknown {
            return Err(io::Error::other("read stop bypassed initial Unknown").into());
        }
        proof.read_stop_witness("initial_unknown", json!({"state": "Unknown",
            "first": first.evidence(), "second": second.evidence(),
            "accounting": accounting(&context, 0, growth)?}))?;
        source.resume();
        for gate in &gates[..2] { gate.wait_entered().await?; }
        for reader in &mut readers {
            while reader.latest.borrow_and_update().accepted != 1 { reader.latest.changed().await?; }
            reader.require(false, false, 0)?;
        }
        let [first, second] = readers.as_slice() else {
            return Err(io::Error::other("read stop accepted owners missing").into());
        };
        let decision = control.decision();
        if decision.state != HostPressureState::Ready {
            return Err(io::Error::other("read stop lacks actual sustained Ready").into());
        }
        proof.require_full_lease()?;
        proof.read_stop_witness("both_accepted", json!({"state": "Ready", "available_bytes": decision.available_bytes,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "first": first.evidence(), "second": second.evidence(),
            "accounting": accounting(&context, 2, growth)?, "checkpoint_bytes": [CHUNK, CHUNK],
            "release_bytes_withheld": true, "allocated": context.budget.allocated()}))?;
        source.pause();
        source.wait_for_readers(1).await;
        let frozen = source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>();
        proof.read_stop_witness("observation_held", json!({"samples": frozen,
            "first": first.evidence(), "second": second.evidence(),
            "accounting": accounting(&context, 2, growth)?, "release_bytes_withheld": true,
            "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        let shutdown_requested_ns = evidence::clocks()?.0;
        if let std::task::Poll::Ready(result) = futures_util::poll!(shutdown.as_mut()) {
            shutdown_result = Some(result);
            return Err(io::Error::other("shutdown forgot accepted observation").into());
        }
        let shutdown_pending_ns = evidence::clocks()?.0;
        loop {
            if updates.borrow_and_update().stopped { break; }
            updates.changed().await?;
        }
        require_closed(&control)?;
        readers.push(Reader::spawn(original.path.clone(), GuardedPrefetchConfig {
            pressure: control.clone(), overhead_bytes: original.overhead,
        }, gates[2].clone())?);
        let [first, second, refused] = readers.as_mut_slice() else {
            return Err(io::Error::other("read stop owners missing").into());
        };
        refused.owner.drain().await;
        critical::no_reads(&refused.latest.borrow(), true)?;
        for reader in [&mut *first, &mut *second] {
            for _ in 0..2 {
                let drain = reader.owner.drain();
                tokio::pin!(drain);
                if futures_util::poll!(&mut drain).is_ready() {
                    return Err(io::Error::other("stopped drain forgot physical File producer").into());
                }
            }
        }
        let readers_pending_ns = evidence::clocks()?.0;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        let observer = foreground_probe::observe().await?;
        if let std::task::Poll::Ready(result) = futures_util::poll!(shutdown.as_mut()) {
            shutdown_result = Some(result);
            return Err(io::Error::other("shutdown forgot held sampler during foreground progress").into());
        }
        if source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>() != frozen {
            return Err(io::Error::other("held observation completed during shutdown wait").into());
        }
        let shutdown_still_pending_ns = evidence::clocks()?.0;
        proof.read_stop_witness("shutdown_wait_progress", json!({
            "shutdown_requested_ns": shutdown_requested_ns, "shutdown_pending_ns": shutdown_pending_ns,
            "readers_pending_ns": readers_pending_ns, "shutdown_still_pending_ns": shutdown_still_pending_ns,
            "shutdown_pending": true, "controller_stopped": true, "sampler_release_withheld": true,
            "first_drain_pending": true, "second_drain_pending": true, "drain_observers_dropped": true,
            "optional_closed": true, "first": first.evidence(), "second": second.evidence(), "refused": refused.evidence(),
            "samples": frozen, "accounting": accounting(&context, 2, growth)?, "heartbeat": heartbeat, "observer": observer,
            "release_bytes_withheld": true, "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        let observation_released_ns = evidence::clocks()?.0;
        source.resume();
        let stopped = shutdown_result.insert(shutdown.as_mut().await);
        let pressure_joined_ns = evidence::clocks()?.0;
        let stopped = stopped.as_ref()
            .map_err(|error| io::Error::other(error.to_string()))?;
        if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
            return Err(io::Error::other("read stop pressure dependencies unresolved").into());
        }
        require_closed(&control)?;
        first.require(false, false, 0)?;
        second.require(false, false, 0)?;
        proof.read_stop_witness("pressure_joined", json!({
            "observation_released_ns": observation_released_ns, "pressure_joined_ns": pressure_joined_ns,
            "controller_joined": true, "sampler_joined": true, "producer_lost": false, "wave_inflight": false,
            "optional_closed": true, "first": first.evidence(), "second": second.evidence(), "refused": refused.evidence(),
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "accounting": accounting(&context, 2, growth)?, "release_bytes_withheld": true,
            "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        for (index, (reader, gate)) in [first, second].into_iter().zip(&gates).enumerate() {
            let release_ns = evidence::clocks()?.0;
            gate.release()?;
            reader.owner.drain().await;
            reader.require(false, true, CHUNK)?;
            if index == 1 { join_accounting(&context).await?; }
            let joined_ns = evidence::clocks()?.0;
            require_closed(&control)?;
            proof.read_stop_witness(if index == 0 { "first_joined" } else { "second_joined" }, json!({
                "read": reader.evidence(), "release_ns": release_ns, "joined_ns": joined_ns,
                "physical_drain_joined": true, "optional_closed": true,
                "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
                "accounting": accounting(&context, 1-index, growth)?, "explicit_old_cancel_requested": false,
                "allocated": context.budget.allocated()}))?;
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    if !matches!(&outcome, Ok(Ok(()))) {
        for reader in &readers {
            reader.owner.cancel();
        }
    }
    let releases = gates.iter().map(|gate| gate.release()).collect::<Vec<_>>();
    source.resume();
    for reader in &mut readers {
        reader.owner.drain().await;
    }
    let stopped = match shutdown_result {
        Some(result) => result,
        None => shutdown.await,
    };
    let reporting = probe.finish().await;
    for released in releases {
        released?;
    }
    stopped?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    let [first, second, refused] = readers.as_slice() else {
        return Err(io::Error::other("read stop final owners missing").into());
    };
    first.require(false, true, CHUNK)?;
    second.require(false, true, CHUNK)?;
    critical::no_reads(&refused.latest.borrow(), true)?;
    let checked = original.path.clone();
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
    proof.require_full_lease()?;
    proof.read_stop_witness("producers_joined", json!({
        "first": first.evidence(), "second": second.evidence(), "refused": refused.evidence(),
        "controller_joined": true, "sampler_joined": true, "readers_drained": true,
        "heartbeat_joined": true, "provider_joined": true, "peer_joined": true, "snapshot_reverified": true,
        "optional_closed": true, "explicit_old_cancel_requested": false,
        "accounting": accounting(&context, 0, growth)?, "allocated": context.budget.allocated()}))?;
    let mut batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_read_stop_required_saving",
            },
        )
        .await?;
    let result = batch.join().await?;
    if !result.is_complete() || result.selected != 1 || result.completed != 1 {
        return Err(io::Error::other("read stop original saving incomplete").into());
    }
    Ok(())
}
