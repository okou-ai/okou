//! Complete readers and independent reporting through actual incoming waits.

use std::time::Duration;

use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_lifecycle::resource_budget::BudgetLease;
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use sandbox::SandboxBackingProcess;
use serde_json::json;

use super::*;

pub struct Request<'a> {
    pub context: transitions::Context,
    pub inputs: &'a fixture::Inputs,
    pub source: &'a Arc<recovery_source::Source>,
    pub proof: &'a Arc<evidence::Case>,
    pub directory: &'a std::path::Path,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub scope: NativeScope,
}

pub async fn exercise(request: Request<'_>) -> TestResult<BudgetLease> {
    let Request {
        context,
        inputs,
        source,
        proof,
        directory,
        backing,
        scope,
    } = request;
    let original = startup::original(&context.budget, inputs, proof).await?;
    let original_id = {
        let pool = context.pool.lock().await;
        let snapshot = pool.status_snapshot();
        let [entry] = snapshot.idle_sandboxes.as_slice() else {
            return Err(io::Error::other("incoming original inventory is not singular").into());
        };
        entry.sandbox_id
    };
    proof.incoming_witness("inputs_verified", json!({
        "kind": incoming_work::kind(scope)?, "policy": serde_json::to_value(inputs)?,
        "inputs_sha256": continuation::digest(&original.raw), "snapshot_sha256": proof.snapshot_memory_hash()?,
        "snapshot_bytes": original.bytes, "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": original.overhead,
        "allocated": context.budget.allocated(), "startup_pressure_guarded": false,
        "physical_credit_from_logical_transfer": false,
    }))?;
    proof.observe_incoming_creations(true);
    let mut setup = Some(incoming_work::prepare(&context, inputs, scope, source, proof).await?);
    let incoming_id = setup.as_ref().and_then(|s| s.incoming_id);
    let first_sample = source.samples()?.len();
    let gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(gate.clone())?;
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
        policy: inputs.pressure_policy()?,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    }) {
        Ok(owner) => owner,
        Err(error) => {
            source.resume();
            proof.retain(setup);
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let control = pressure.optional_preparation();
    let (mut runtime, reads) = match MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: original.path.clone(),
            memory_mb: 4096,
        }],
        4096,
        GuardedPrefetchConfig {
            pressure: control.clone(),
            overhead_bytes: original.overhead,
        },
    ) {
        Ok(tasks) => tasks,
        Err(error) => {
            pressure.stop();
            source.resume();
            proof.retain(setup);
            let stopped = pressure.shutdown().await;
            let reporting = probe.finish().await;
            stopped?;
            reporting?;
            return Err(error.into());
        }
    };
    let mut pool_hold = None;
    let mut status_hold = None;
    let mut startup = None;
    let mut work = None;
    let mut lease = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        pool_hold = Some(context.pool.lock().await);
        let pool_held = evidence::clocks()?.0;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held = evidence::clocks()?.0;
        let mut status_waits = context.status.idle_snapshot_waits_for_test();
        let baseline = *status_waits.borrow_and_update();
        let (pool_wait, pool_entered) = tokio::sync::oneshot::channel();
        let (join_wait, join_entered) = tokio::sync::oneshot::channel();
        work = Some(tokio::spawn(incoming_work::exercise(incoming_work::Request {
            context: context.clone(), inputs: inputs.clone(), scope,
            setup: setup.take().ok_or_else(|| io::Error::other("incoming setup consumed"))?,
            proof: proof.clone(), original: backing, pool_wait, join_wait,
        })));
        let pool_polled = pool_entered.await?;
        source.wait_for_readers(1).await;
        let owner = startup.insert(MemoryPrefetchTasks::spawn([MemoryPrefetchCandidate {
            path: original.path.clone(), memory_mb: 4096 }], 4096));
        owner.drain().await;
        let completed = owner.startup_snapshot()?;
        startup::completed(&completed, original.bytes)?;
        critical::no_reads(&reads.borrow(), false)?;
        if control.decision().state != HostPressureState::Unknown || probe.has_receipts()? {
            return Err(io::Error::other("incoming held pool did not retain Unknown").into());
        }
        let observed = foreground_probe::observe().await?;
        proof.require_full_lease()?;
        proof.incoming_witness("pool_wait_progress", json!({
            "startup": startup::read_evidence(&completed), "startup_drained": true,
            "reads": critical::read_evidence(&reads.borrow()), "state": "Unknown",
            "pool_held_ns": pool_held, "status_held_ns": status_held,
            "pool_wait_polled_ns": pool_polled, "pool_wait_polled_pending": true,
            "observer": observed, "allocated": context.budget.allocated(),
        }))?;
        source.resume();
        runtime.drain().await;
        foreground::runtime_complete(&reads.borrow(), original.bytes)?;
        if control.decision().state != HostPressureState::Ready {
            return Err(io::Error::other("incoming runtime lacks sustained actual Ready").into());
        }
        let runtime_completed = evidence::clocks()?.0;
        drop(pool_hold.take());
        let pool_released = evidence::clocks()?.0;
        loop {
            if *status_waits.borrow_and_update() > baseline { break; }
            status_waits.changed().await?;
        }
        let status_polled = evidence::clocks()?.0;
        if *status_waits.borrow() != baseline + 1 {
            return Err(io::Error::other("incoming specific status Pending wait missing").into());
        }
        let inventory_matches = {
            let pool = context.pool.lock().await;
            match incoming_id { Some(id) => pool.len() == 1 && pool.contains_sandbox_id(id), None => pool.is_empty() }
        };
        if !inventory_matches || matches!(scope, NativeScope::Restore) && incoming_id != Some(original_id) {
            return Err(io::Error::other("incoming accepted inventory/original restoration changed").into());
        }
        proof.require_full_lease()?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        let observed = foreground_probe::observe().await?;
        let decision = control.decision();
        if decision.state != HostPressureState::Ready { return Err(io::Error::other("incoming lost Ready").into()); }
        proof.incoming_witness("status_wait_progress", json!({
            "state": "Ready", "available_bytes": decision.available_bytes,
            "reads": critical::read_evidence(&reads.borrow()), "runtime_drained": true,
            "runtime_completed_ns": runtime_completed, "pool_released_ns": pool_released,
            "status_held_ns": status_held, "status_wait_polled_ns": status_polled,
            "status_waits_before": baseline, "status_waits_after": *status_waits.borrow(),
            "actual_idle_snapshot_wait": true, "inventory_matches_original_incoming": true,
            "original_owner_restored": matches!(scope, NativeScope::Restore),
            "status_publication": if matches!(scope, NativeScope::Aged) {"aged_internal"} else {"after_insertion"},
            "heartbeat": heartbeat, "observer": observed, "allocated": context.budget.allocated(),
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
        }))?;
        drop(status_hold.take());
        let join_polled = join_entered.await?;
        gate.wait_entered().await?;
        proof.require_full_lease()?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        let observed = foreground_probe::observe().await?;
        proof.require_full_lease()?;
        proof.incoming_witness("physical_io_wait_progress", json!({
            "join_polled_ns": join_polled, "join_kind": if matches!(scope, NativeScope::Aged) {"blank_preparation"} else {"original_cleanup"},
            "join_polled_pending": true, "kernel_io_entered": true, "release_byte_withheld": true,
            "full_original_lease": [2,4096,1], "allocated": context.budget.allocated(),
            "heartbeat": heartbeat, "observer": observed,
        }))?;
        gate.release()?;
        let completed = work.as_mut().ok_or_else(|| io::Error::other("incoming producer missing"))?.await;
        work.take(); lease = Some(completed??);
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    drop(pool_hold.take());
    drop(status_hold.take());
    let released = gate.release();
    pressure.stop();
    source.resume();
    runtime.cancel();
    runtime.drain().await;
    if let Some(owner) = &mut startup {
        owner.cancel();
        owner.drain().await;
    }
    let worker_result = match work {
        Some(work) => match work.await {
            Ok(Ok(held)) => {
                lease = Some(held);
                Ok(())
            }
            Ok(Err(error)) => Err(error),
            Err(error) => Err(Box::new(error) as Box<dyn Error + Send + Sync>),
        },
        None => Ok(()),
    };
    let stopped = pressure.shutdown().await;
    let reporting = probe.finish().await;
    let completed: TestResult<()> = async {
        outcome.map_err(io::Error::other)??;
        released?; worker_result?;
        let stopped = stopped?; reporting?;
        foreground::runtime_complete(&reads.borrow(), original.bytes)?;
        if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
            return Err(io::Error::other("incoming pressure owner incomplete").into());
        }
        context.tracker.close_and_wait().await;
        if !context.tracker.take_retained_activation_owners()?.is_empty() {
            return Err(io::Error::other("incoming retained uncertain cleanup").into());
        }
        let pending = context.operations.close_and_wait().await?;
        if pending.registered_operations != 0 || pending.tracked_tasks != 0
            || context.budget.allocated() != (2,4096,1) || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("incoming producers/original full lease incomplete").into());
        }
        let startup = startup.as_ref().ok_or_else(|| io::Error::other("incoming startup owner missing"))?.startup_snapshot()?;
        startup::completed(&startup, original.bytes)?;
        let checked = original.path.clone(); let hash = proof.snapshot_memory_hash()?.to_owned();
        tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
        proof.require_full_lease()?;
        proof.observe_incoming_creations(false);
        proof.incoming_witness("producers_joined", json!({
            "startup": startup::read_evidence(&startup), "reads": critical::read_evidence(&reads.borrow()),
            "startup_drained": true, "runtime_drained": true, "incoming_work_joined": true,
            "pressure_stopped": true, "producer_lost": false, "wave_inflight": false,
            "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
            "snapshot_reverified": true, "original_full_lease_retained": true,
            "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
            "allocated": context.budget.allocated(), "inventory_empty": true,
        }))?;
        Ok(())
    }.await;
    if let Err(error) = completed {
        proof.retain(setup);
        proof.retain(lease);
        return Err(error);
    }
    lease.ok_or_else(|| io::Error::other("incoming original full lease missing").into())
}
