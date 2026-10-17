//! Accepted File readers retain cancellation and custody across actual stale recovery.

use std::time::Duration;

use runner_host::host_memory::HostMemoryUnknown;
use runner_lifecycle::host_memory_pressure::{
    HostPressureState, HostPressureUnknown, OptionalPressureControl,
};
use runner_lifecycle::prefetch::GuardedPrefetchConfig;
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde_json::json;

use super::*;

use super::guarded_readers::{CHUNK, Reader, accounting, join_accounting};

fn ready_available(control: &OptionalPressureControl) -> TestResult<u64> {
    let decision = control.decision();
    match (decision.state, decision.available_bytes) {
        (HostPressureState::Ready, Some(available)) => Ok(available),
        _ => Err(io::Error::other(format!(
            "revoked readers lost recovered Ready: {decision:?}"
        ))
        .into()),
    }
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
    directory: &std::path::Path,
) -> TestResult<()> {
    let proof = proof.ok_or_else(|| io::Error::other("read revocation require measured owners"))?;
    let original = startup::original(&context.budget, inputs, proof).await?;
    let growth = original
        .bytes
        .checked_add(original.overhead)
        .ok_or_else(|| io::Error::other("revoked read growth overflow"))?;
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
    let mut readers = Vec::<Reader>::new();
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        proof.read_revocation_witness("inputs_verified", json!({
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
        let [first, second] = readers.as_slice() else { return Err(io::Error::other("revoked read owners missing").into()); };
        critical::no_reads(&first.latest.borrow(), false)?;
        critical::no_reads(&second.latest.borrow(), false)?;
        if control.decision().state != HostPressureState::Unknown {
            return Err(io::Error::other("revoked readers bypassed initial Unknown").into());
        }
        proof.read_revocation_witness("initial_unknown", json!({"state": "Unknown",
            "first": first.evidence(), "second": second.evidence(), "accounting": accounting(&context, 0, growth)?}))?;
        source.resume();
        for gate in &gates[..2] { gate.wait_entered().await?; }
        for reader in &mut readers {
            loop {
                if reader.latest.borrow_and_update().accepted == 1 { break; }
                reader.latest.changed().await?;
            }
            reader.require(false, false, 0)?;
        }
        let [first, second] = readers.as_mut_slice() else { return Err(io::Error::other("revoked read owners missing").into()); };
        let decision = control.decision();
        if decision.state != HostPressureState::Ready {
            return Err(io::Error::other("concurrent actual reads lack sustained Ready").into());
        }
        proof.require_full_lease()?;
        proof.read_revocation_witness("both_accepted", json!({"state": "Ready", "available_bytes": decision.available_bytes,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "first": first.evidence(), "second": second.evidence(), "accounting": accounting(&context, 2, growth)?,
            "checkpoint_bytes": [CHUNK, CHUNK], "release_bytes_withheld": true, "allocated": context.budget.allocated()}))?;
        source.pause();
        source.wait_for_readers(1).await;
        let frozen = source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>();
        proof.read_revocation_witness("observation_held", json!({
            "samples": frozen, "first": first.evidence(), "second": second.evidence(),
            "accounting": accounting(&context, 2, growth)?, "release_bytes_withheld": true,
            "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        // Admission can have read this shared source after the controller's
        // last sample. Wait for every actual retained read's freshness deadline,
        // rather than presenting the controller's earlier expiry as theirs.
        let maximum_age = u64::try_from(policy.max_sample_age.as_nanos())?;
        let expires_ns = frozen.iter().try_fold(0_u64, |latest, sample| {
            let finished = sample["finished_ns"].as_u64()
                .ok_or_else(|| io::Error::other("held observation finish missing"))?;
            let age = sample["age_ns"].as_u64()
                .ok_or_else(|| io::Error::other("held observation age missing"))?;
            let expires = finished.checked_add(maximum_age).and_then(|end| end.checked_sub(age))
                .ok_or_else(|| io::Error::other("held observation expiry invalid"))?;
            Ok::<_, io::Error>(latest.max(expires))
        })?;
        tokio::time::sleep(Duration::from_nanos(expires_ns.saturating_sub(evidence::clocks()?.0))).await;
        loop {
            let changed = control.changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if matches!(control.decision().unknown, Some(HostPressureUnknown::Observation(HostMemoryUnknown::Stale))) { break; }
            changed.await;
        }
        proof.read_revocation_witness("stale_unknown", json!({
            "state": "Unknown", "reason": "Stale", "samples": frozen,
            "first": first.evidence(), "second": second.evidence(),
            "accounting": accounting(&context, 2, growth)?, "release_bytes_withheld": true,
            "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        {
            let drain = first.owner.drain();
            tokio::pin!(drain);
            if futures_util::poll!(&mut drain).is_ready() {
                return Err(io::Error::other("stale drain abandoned physical IO").into());
            }
        }
        let first_drain_dropped_ns = evidence::clocks()?.0;
        {
            let drain = first.owner.drain();
            tokio::pin!(drain);
            if futures_util::poll!(&mut drain).is_ready() {
                return Err(io::Error::other("replacement stale drain forgot physical IO").into());
            }
            let second_pending_ns = evidence::clocks()?.0;
            {
                let peer = second.owner.drain();
                tokio::pin!(peer);
                if futures_util::poll!(&mut peer).is_ready() {
                    return Err(io::Error::other("stale peer drain abandoned physical IO").into());
                }
            }
            let peer_pending_ns = evidence::clocks()?.0;
            probe.request()?;
            let heartbeat = probe.complete().await?;
            let observer = foreground_probe::observe().await?;
            if source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>() != frozen
                || !matches!(control.decision().unknown, Some(HostPressureUnknown::Observation(HostMemoryUnknown::Stale))) {
                return Err(io::Error::other("stale source returned or renewed observations").into());
            }
            proof.read_revocation_witness("stale_wait_progress", json!({
                "state": "Unknown", "reason": "Stale", "samples": frozen,
                "first": critical::read_evidence(&first.latest.borrow()), "second": second.evidence(),
                "first_drain_dropped_ns": first_drain_dropped_ns, "second_pending_ns": second_pending_ns,
                "peer_pending_ns": peer_pending_ns, "peer_drain_pending": true,
                "first_drain_pending": true, "first_drain_dropped": true, "second_drain_pending": true,
                "release_bytes_withheld": true, "explicit_old_cancel_requested": false,
                "accounting": accounting(&context, 2, growth)?,
                "heartbeat": heartbeat, "observer": observer, "allocated": context.budget.allocated()}))?;
        }
        let resumed_ns = evidence::clocks()?.0;
        source.resume();
        loop {
            let changed = control.changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if control.decision().state == HostPressureState::Ready { break; }
            changed.await;
        }
        proof.read_revocation_witness("recovered_ready", json!({
            "state": "Ready", "available_bytes": ready_available(&control)?, "resumed_ns": resumed_ns,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "first": first.evidence(), "second": second.evidence(),
            "accounting": accounting(&context, 2, growth)?, "release_bytes_withheld": true,
            "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        readers.push(Reader::spawn(original.path.clone(), GuardedPrefetchConfig {
            pressure: control.clone(), overhead_bytes: original.overhead,
        }, gates[2].clone())?);
        gates[2].wait_entered().await?;
        let [first, second, fresh] = readers.as_mut_slice() else {
            return Err(io::Error::other("revocation reader owners missing").into());
        };
        while fresh.latest.borrow_and_update().accepted != 1 { fresh.latest.changed().await?; }
        fresh.require(false, false, 0)?;
        proof.read_revocation_witness("fresh_accepted", json!({
            "state": "Ready", "available_bytes": ready_available(&control)?,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "first": first.evidence(), "second": second.evidence(), "fresh": fresh.evidence(),
            "checkpoint_bytes": [CHUNK, CHUNK, CHUNK],
            "accounting": accounting(&context, 3, growth)?, "release_bytes_withheld": true,
            "explicit_old_cancel_requested": false, "allocated": context.budget.allocated()}))?;
        let release_available_bytes = ready_available(&control)?;
        let release_ns = evidence::clocks()?.0;
        gates[2].release()?;
        fresh.owner.drain().await;
        let joined_ns = evidence::clocks()?.0;
        fresh.require(true, false, original.bytes)?;
        first.require(false, false, 0)?;
        second.require(false, false, 0)?;
        proof.read_revocation_witness("fresh_joined", json!({
            "first": first.evidence(), "second": second.evidence(), "fresh": fresh.evidence(),
            "release_ns": release_ns, "joined_ns": joined_ns, "physical_drain_joined": true,
            "release_state": "Ready", "release_available_bytes": release_available_bytes,
            "state": "Ready", "available_bytes": ready_available(&control)?,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "accounting": accounting(&context, 2, growth)?, "explicit_old_cancel_requested": false,
            "allocated": context.budget.allocated()}))?;
        let release_available_bytes = ready_available(&control)?;
        let release_ns = evidence::clocks()?.0;
        gates[0].release()?;
        first.owner.drain().await;
        let joined_ns = evidence::clocks()?.0;
        first.require(false, true, CHUNK)?;
        second.require(false, false, 0)?;
        proof.read_revocation_witness("first_joined", json!({
            "first": first.evidence(), "second": second.evidence(), "fresh": fresh.evidence(),
            "release_ns": release_ns, "joined_ns": joined_ns, "physical_drain_joined": true,
            "release_state": "Ready", "release_available_bytes": release_available_bytes,
            "state": "Ready", "available_bytes": ready_available(&control)?,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "accounting": accounting(&context, 1, growth)?, "explicit_old_cancel_requested": false,
            "allocated": context.budget.allocated()}))?;
        let release_available_bytes = ready_available(&control)?;
        let release_ns = evidence::clocks()?.0;
        gates[1].release()?;
        second.owner.drain().await;
        join_accounting(&context).await?;
        let joined_ns = evidence::clocks()?.0;
        second.require(false, true, CHUNK)?;
        proof.read_revocation_witness("second_joined", json!({
            "first": first.evidence(), "second": second.evidence(), "fresh": fresh.evidence(),
            "release_ns": release_ns, "joined_ns": joined_ns, "physical_drain_joined": true,
            "release_state": "Ready", "release_available_bytes": release_available_bytes,
            "state": "Ready", "available_bytes": ready_available(&control)?,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "accounting": accounting(&context, 0, growth)?, "explicit_old_cancel_requested": false,
            "allocated": context.budget.allocated()}))?;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    // Refusal/timeout cannot abandon either accepted File producer or its dependencies.
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
        return Err(io::Error::other("revoked reader pressure dependencies did not join").into());
    }
    let [first, second, fresh] = readers.as_slice() else {
        return Err(io::Error::other("revoked read owners missing").into());
    };
    first.require(false, true, CHUNK)?;
    second.require(false, true, CHUNK)?;
    fresh.require(true, false, original.bytes)?;
    let checked = original.path.clone();
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
    proof.require_full_lease()?;
    proof.read_revocation_witness(
        "producers_joined",
        json!({"first": first.evidence(), "second": second.evidence(), "fresh": fresh.evidence(),
        "explicit_old_cancel_requested": false,
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
                context: "native_read_revocation_required_saving",
            },
        )
        .await?;
    let result = batch.join().await?;
    if !result.is_complete() || result.selected != 1 || result.completed != 1 {
        return Err(io::Error::other("revoked readers original saving incomplete").into());
    }
    Ok(())
}
