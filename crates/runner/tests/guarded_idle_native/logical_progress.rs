//! Real readers and independent reporting across full-budget logical handoff.

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
}

pub async fn exercise(request: Request<'_>) -> TestResult<BudgetLease> {
    let Request {
        context,
        inputs,
        source,
        proof,
        directory,
        backing,
    } = request;
    let original = startup::original(&context.budget, inputs, proof).await?;
    if context.budget.can_afford(2, 4096) {
        return Err(io::Error::other("logical fixture unexpectedly has spare capacity").into());
    }
    let grant_started = evidence::clocks()?.0;
    let first = source.samples()?.len();
    let mut growth = context.operations.request(inputs.replacement_plan()?)?;
    let permit = growth.try_grant().await?;
    let grant_finished = evidence::clocks()?.0;
    let operation_id = permit
        .id()
        .ok_or_else(|| io::Error::other("logical original Fresh permit missing"))?;
    proof.logical_witness("inputs_verified", json!({
        "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&original.raw),
        "snapshot_sha256": proof.snapshot_memory_hash()?, "snapshot_bytes": original.bytes,
        "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": original.overhead,
        "allocated": context.budget.allocated(), "profile_can_fit": false,
        "startup_pressure_guarded": false, "physical_credit_from_logical_transfer": false,
        "fresh_grant": {"started_ns": grant_started, "finished_ns": grant_finished,
            "operation_id": operation_id.generation().to_string(),
            "samples": source.samples()?.into_iter().skip(first).collect::<Vec<_>>()},
    }))?;
    let first_sample = source.samples()?.len();
    let mut permit = Some(permit);
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
    let mut pool_hold = None;
    let mut status_hold = None;
    let mut startup = None;
    let mut work = None;
    let mut lease = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        pool_hold = Some(context.pool.lock().await);
        let held_ns = evidence::clocks()?.0;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        let mut status_waits = context.status.idle_snapshot_waits_for_test();
        let baseline = *status_waits.borrow_and_update();
        let (pool_wait, pool_entered) = tokio::sync::oneshot::channel();
        let (join_wait, join_entered) = tokio::sync::oneshot::channel();
        work = Some(tokio::spawn(logical_work::exercise(
            logical_work::Request {
                context: context.clone(),
                permit: permit
                    .take()
                    .ok_or_else(|| io::Error::other("logical Fresh permit consumed"))?,
                envelope: inputs.envelope(),
                max_sample_age: inputs.pressure_policy()?.max_sample_age,
                proof: proof.clone(),
                backing,
                pool_wait,
                join_wait,
            },
        )));
        let pool_polled_ns = pool_entered.await?;
        source.wait_for_readers(1).await;
        let tasks = startup.insert(MemoryPrefetchTasks::spawn(
            [MemoryPrefetchCandidate {
                path: original.path.clone(),
                memory_mb: 4096,
            }],
            4096,
        ));
        tasks.drain().await;
        let startup_read = tasks.startup_snapshot()?;
        startup::completed(&startup_read, original.bytes)?;
        critical::no_reads(&reads.borrow(), false)?;
        if control.decision().state != HostPressureState::Unknown || probe.has_receipts()? {
            return Err(io::Error::other("logical initial Unknown/pool wait changed").into());
        }
        let observed = foreground_probe::observe().await?;
        proof.logical_witness(
            "pool_wait_progress",
            json!({
                "startup": startup::read_evidence(&startup_read), "startup_drained": true,
                "reads": critical::read_evidence(&reads.borrow()), "state": "Unknown",
                "pool_held_ns": held_ns, "status_held_ns": status_held_ns,
                "pool_wait_polled_ns": pool_polled_ns, "pool_wait_polled_pending": true,
                "observer": observed, "allocated": context.budget.allocated(),
            }),
        )?;
        // Only the sampler/runtime proceed. Logical selection still waits on
        // the actual pool until its complete independent read has settled.
        source.resume();
        runtime.drain().await;
        foreground::runtime_complete(&reads.borrow(), original.bytes)?;
        if control.decision().state != HostPressureState::Ready {
            return Err(io::Error::other("logical runtime lacks sustained actual Ready").into());
        }
        let runtime_completed_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let pool_released_ns = evidence::clocks()?.0;
        loop {
            if *status_waits.borrow_and_update() > baseline {
                break;
            }
            status_waits.changed().await?;
        }
        let status_polled_ns = evidence::clocks()?.0;
        if *status_waits.borrow() != baseline + 1
            || !context.pool.lock().await.is_empty()
            || context.budget.allocated() != (2, 4096, 1)
            || context.budget.can_afford(2, 4096)
        {
            return Err(
                io::Error::other("logical specific status wait/atomic transfer missing").into(),
            );
        }
        proof.require_full_lease()?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        let observed = foreground_probe::observe().await?;
        let decision = control.decision();
        if decision.state != HostPressureState::Ready {
            return Err(io::Error::other("logical status progress lost Ready").into());
        }
        proof.logical_witness(
            "status_wait_progress",
            json!({
                "state": "Ready", "available_bytes": decision.available_bytes,
            "reads": critical::read_evidence(&reads.borrow()), "runtime_drained": true,
            "runtime_completed_ns": runtime_completed_ns,
                "pool_released_ns": pool_released_ns, "status_held_ns": status_held_ns,
                "status_wait_polled_ns": status_polled_ns, "status_waits_before": baseline,
                "status_waits_after": *status_waits.borrow(), "actual_idle_snapshot_wait": true,
                "heartbeat": heartbeat, "observer": observed,
                "allocated": context.budget.allocated(), "logical_lease_transferred": true,
                "original_full_lease_retained": true,
                "profile_can_fit": false, "inventory_empty": true,
                "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            }),
        )?;
        drop(status_hold.take());
        let joined_polled_ns = join_entered.await?;
        gate.wait_entered().await?;
        proof.require_full_lease()?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        let observed = foreground_probe::observe().await?;
        proof.require_full_lease()?;
        proof.logical_witness("physical_io_wait_progress", json!({
            "old_join_polled_ns": joined_polled_ns, "kernel_io_entered": true,
            "release_byte_withheld": true, "full_logical_lease": [2, 4096, 1],
            "allocated": context.budget.allocated(), "heartbeat": heartbeat, "observer": observed,
        }))?;
        gate.release()?;
        let completed = work
            .as_mut()
            .ok_or_else(|| io::Error::other("logical producer missing"))?
            .await;
        work.take();
        lease = Some(completed??);
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    })
    .await;
    // Release only fixture-owned waits, then join all accepted work even after
    // failure. A successful worker's full lease is retained on any later error.
    drop(pool_hold.take());
    drop(status_hold.take());
    let released = gate.release();
    pressure.stop();
    source.resume();
    runtime.cancel();
    runtime.drain().await;
    if let Some(startup) = &mut startup {
        startup.cancel();
        startup.drain().await;
    }
    let worker_result = match work {
        Some(work) => match work.await {
            Ok(Ok(owned)) => {
                lease = Some(owned);
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
        let stopped = stopped?;
        reporting?;
        foreground::runtime_complete(&reads.borrow(), original.bytes)?;
        if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
            return Err(io::Error::other("logical pressure owner did not join").into());
        }
        context.tracker.close_and_wait().await;
        if !context.tracker.take_retained_activation_owners()?.is_empty() {
            return Err(io::Error::other("logical cleanup retained uncertainty").into());
        }
        let pending = context.operations.close_and_wait().await?;
        if pending.registered_operations != 0 || pending.tracked_tasks != 0
            || context.budget.allocated() != (2, 4096, 1)
        {
            return Err(io::Error::other("logical joined owners lost full coverage").into());
        }
        let startup = startup.as_ref().ok_or_else(|| io::Error::other("logical startup owner missing"))?.startup_snapshot()?;
        startup::completed(&startup, original.bytes)?;
        let checked = original.path.clone();
        let hash = proof.snapshot_memory_hash()?.to_owned();
        tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
        proof.require_full_lease()?;
        proof.logical_witness("producers_joined", json!({
            "startup": startup::read_evidence(&startup), "reads": critical::read_evidence(&reads.borrow()),
            "startup_drained": true, "runtime_drained": true, "logical_work_joined": true,
            "pressure_stopped": true, "producer_lost": false, "wave_inflight": false,
            "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
            "snapshot_reverified": true, "original_full_lease_retained": true,
            "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
            "allocated": context.budget.allocated(), "physical_credit_from_logical_transfer": false,
        }))?;
        Ok(())
    }.await;
    if let Err(error) = completed {
        proof.retain(lease);
        return Err(error);
    }
    lease.ok_or_else(|| io::Error::other("logical completed full lease missing").into())
}
