//! Actual returned preparation stays owned through cancellation and late cleanup.

use std::collections::BTreeMap;
use std::time::Duration;

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_supervisor::blank_pool::{
    BlankPoolReplenisher, BlankProfile, OptionalBlankPoolRequest, OptionalBlankResult,
};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde_json::{Value, json};

use super::returned_guest_probe::{Probe, accounting};
use super::*;

struct Release<'a>(&'a Probe);
impl Drop for Release<'_> {
    fn drop(&mut self) {
        let _ = self.0.stage_gate.release();
        let _ = self.0.cleanup_gate.release();
    }
}

fn snapshot(result: &OptionalBlankResult) -> Value {
    let value = result.snapshot();
    json!({"finished":value.finished,"prepared":value.prepared,"published":value.published,
        "retained_resource":value.retained_resource,"error":value.error})
}

fn held(context: &transitions::Context, growth: u64) -> TestResult<Value> {
    let value = accounting(&context.operations)?;
    let tracked = value
        .get("tracked_tasks")
        .and_then(Value::as_u64)
        .ok_or_else(|| io::Error::other("returned Guest tracking count invalid"))?;
    if context.budget.allocated() != (4, 8192, 2)
        || tracked == 0
        || value
            != json!({
        "registered_operations":1,"started":1,"ordinary_growth_bytes":growth,
        "cleanup_growth_bytes":0,"tracked_tasks":tracked,"uncertain":0})
    {
        return Err(
            io::Error::other(format!("returned Guest lost actual full custody: {value}")).into(),
        );
    }
    Ok(value)
}

async fn start<'a>(
    blank: &mut BlankPoolReplenisher,
    request: impl Fn() -> OptionalBlankPoolRequest<'a>,
) -> TestResult<()> {
    let mut ticks = tokio::time::interval(request().pressure.policy().optional_start_interval);
    loop {
        if blank.maybe_start_optional(request())? {
            return Ok(());
        }
        ticks.tick().await;
    }
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: &Arc<evidence::Case>,
    directory: &std::path::Path,
    probe: &Arc<Probe>,
) -> TestResult<()> {
    let _release = Release(probe);
    let original = startup::original(&context.budget, inputs, proof).await?;
    probe.bind(&context)?;
    let admission = PreSpawnAdmission::new(2)?;
    let mut heartbeat = foreground_probe::Probe::new(
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
        Ok(value) => value,
        Err(error) => {
            source.resume();
            heartbeat.finish().await?;
            return Err(error.into());
        }
    };
    let control = pressure.optional_preparation();
    let profiles = BTreeMap::from([(
        fixture::PROFILE.into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: context.rootfs_hash.clone(),
            home_disk_mb: fixture::HOME_DISK_MB,
        },
    )]);
    let factories = BTreeMap::from([(fixture::PROFILE.into(), (context.factory.clone(), true))]);
    let new_blank = || BlankPoolReplenisher::new(&profiles, &factories, &context.budget, 2, None);
    let request = || OptionalBlankPoolRequest {
        mode: RunnerMode::Running,
        pool: &context.pool,
        budget: &context.budget,
        admission: &admission,
        status: &context.status,
        tracker: &context.tracker,
        pressure: &control,
        preparation_bytes: inputs.preparation_bytes(),
        envelope: inputs.envelope(),
    };
    let mut unaccepted = new_blank();
    let mut queued = unaccepted.observe_optional_pool_wait_for_test()?;
    let mut blank = new_blank();
    let growth = 4096 * 1024 * 1024 + inputs.preparation_bytes();
    let stage = match probe.stage {
        sandbox_firecracker::GuestPreparationStage::Mount => "home_mount",
        stage => stage.label(),
    };
    let error = format!("{stage}: optional work cancelled; resource retained");
    let outcome = tokio::time::timeout(Duration::from_secs(90),async {
        source.wait_for_readers(1).await;
        proof.returned_guest_witness("inputs_verified",json!({"policy":serde_json::to_value(inputs)?,
            "inputs_sha256":continuation::digest(&original.raw),"snapshot_sha256":proof.snapshot_memory_hash()?,
            "snapshot_bytes":original.bytes,"prefetch_overhead_bytes":original.overhead,
            "stage":probe.stage.label(),"allocated":context.budget.allocated(),"checkpoint_models_stalled_io":false}))?;
        let first_sample = source.samples()?.len();
        source.resume();
        {
            let pool = context.pool.lock().await;
            start(&mut unaccepted,request).await?;
            while !*queued.borrow_and_update() { queued.changed().await?; }
            let pool_pending_ns = evidence::clocks()?.0;
            {
                let wait = unaccepted.wait_for_optional_preparation();tokio::pin!(wait);
                if futures_util::poll!(&mut wait).is_ready() { return Err(io::Error::other("unaccepted pool wait already finished").into()); }
            }
            let foreground = admission.acquire(2,&tokio_util::sync::CancellationToken::new()).await?;
            let foreground_acquired_ns = evidence::clocks()?.0;
            let result = unaccepted.wait_for_optional_preparation().await.ok_or_else(||io::Error::other("unaccepted result missing"))?;
            let joined_ns = evidence::clocks()?.0;
            let observed = foreground_probe::observe().await?;
            let value = snapshot(&result);
            let actual = probe.snapshot()?;
            if value != json!({"finished":true,"prepared":false,"published":false,"retained_resource":false,
                "error":"optional pool wait cancelled"}) || actual.get("created") != Some(&Value::Null)
                || context.budget.allocated() != (2,4096,1) || context.operations.snapshot()?.registered_operations != 0 {
                return Err(io::Error::other("unaccepted pool wait entered provider or lost original lease").into());
            }
            drop(pool);
            let pool_released_ns = evidence::clocks()?.0;
            proof.returned_guest_witness("unaccepted_pool_wait",json!({"pool_pending_ns":pool_pending_ns,
                "foreground_acquired_ns":foreground_acquired_ns,"joined_ns":joined_ns,"pool_released_ns":pool_released_ns,
                "wait_pending":true,"wait_dropped":true,"no_provider_create":true,"result":value,
                "observer":observed,"allocated":context.budget.allocated(),"accounting":accounting(&context.operations)?}))?;
            drop(foreground);
        }
        unaccepted.shutdown_optional(&context.tracker).await?;
        start(&mut blank,request).await?;
        probe.stage_gate.wait_entered().await?;
        proof.require_full_lease()?;
        let decision = control.decision();
        proof.returned_guest_witness("stage_accepted",json!({"actual":probe.snapshot()?,
            "samples":source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "available_bytes":decision.available_bytes,"allocated":context.budget.allocated(),
            "accounting":held(&context,growth)?,"release_byte_withheld":true}))?;
        blank.cancel_if_inactive(RunnerMode::Draining);
        let cancelled_ns = evidence::clocks()?.0;
        {
            let first = blank.wait_for_optional_preparation();tokio::pin!(first);
            if futures_util::poll!(&mut first).is_ready() { return Err(io::Error::other("returned first wait was not pending").into()); }
        }
        let first_dropped_ns = evidence::clocks()?.0;
        let released_ns;
        let result;
        {
            let second = blank.wait_for_optional_preparation();tokio::pin!(second);
            if futures_util::poll!(&mut second).is_ready() { return Err(io::Error::other("returned replacement wait was not pending").into()); }
            let second_pending_ns = evidence::clocks()?.0;
            let foreground = admission.acquire(2,&tokio_util::sync::CancellationToken::new()).await?;
            let foreground_acquired_ns = evidence::clocks()?.0;
            heartbeat.request()?;let acknowledged = heartbeat.complete().await?;
            let observed = foreground_probe::observe().await?;
            proof.require_full_lease()?;
            proof.returned_guest_witness("cancel_wait",json!({"cancelled_ns":cancelled_ns,"first_dropped_ns":first_dropped_ns,
                "second_pending_ns":second_pending_ns,"foreground_acquired_ns":foreground_acquired_ns,
                "first_pending":true,"first_dropped":true,"second_pending":true,"release_byte_withheld":true,
                "allocated":context.budget.allocated(),"accounting":held(&context,growth)?,"heartbeat":acknowledged,"observer":observed}))?;
            drop(foreground);
            released_ns=evidence::clocks()?.0;probe.stage_gate.release()?;
            result=second.await.ok_or_else(||io::Error::other("returned result owner absent"))?;
        }
        while context.operations.snapshot()?.tracked_tasks != 0 { tokio::task::yield_now().await; }
        let joined_ns=evidence::clocks()?.0;
        let late=snapshot(&result);
        if late != json!({"finished":true,"prepared":false,"published":false,"retained_resource":true,"error":error})
            || context.budget.allocated() != (4,8192,2) {
            return Err(io::Error::other(format!("returned cancelled stage lost actual resource: {late}")).into());
        }
        proof.returned_guest_witness("late_joined",json!({"released_ns":released_ns,"joined_ns":joined_ns,"result":late,
            "allocated":context.budget.allocated(),"accounting":accounting(&context.operations)?}))?;
        {
            let mut invalid=request();invalid.mode=RunnerMode::Draining;
            let finish=blank.finish_optional_preparation(&result,invalid);tokio::pin!(finish);
            tokio::select! {
                result=&mut finish=>{ result?; return Err(io::Error::other("late required cleanup escaped held IO").into()); },
                entered=probe.cleanup_gate.wait_entered()=>entered?,
            }
            if futures_util::poll!(&mut finish).is_ready() { return Err(io::Error::other("late cleanup did not retain its waiter").into()); }
            let pending_ns=evidence::clocks()?.0;
            heartbeat.request()?;let acknowledged=heartbeat.complete().await?;
            let observed=foreground_probe::observe().await?;
            proof.require_full_lease()?;
            proof.returned_guest_witness("cleanup_held",json!({"actual":probe.snapshot()?,"pending_ns":pending_ns,
                "invalid_mode":"Draining","cleanup_pending":true,"release_byte_withheld":true,
                "result":snapshot(&result),"allocated":context.budget.allocated(),"accounting":accounting(&context.operations)?,
                "heartbeat":acknowledged,"observer":observed}))?;
            let release_ns=evidence::clocks()?.0;probe.cleanup_gate.release()?;
            finish.await?;
            while context.operations.snapshot()?.tracked_tasks != 0 { tokio::task::yield_now().await; }
            let joined_ns=evidence::clocks()?.0;
            if result.snapshot().published || result.snapshot().retained_resource || context.pool.lock().await.blank_len()!=0
                || context.budget.allocated()!=(2,4096,1) || !probe.backing()?.exit_confirmed().await {
                return Err(io::Error::other("late Guest was published or cleanup/full lease not joined").into());
            }
            proof.returned_guest_witness("cleanup_joined",json!({"release_ns":release_ns,"joined_ns":joined_ns,
                "positive_backing_wait":true,"blank_count":0,"result":snapshot(&result),
                "allocated":context.budget.allocated(),"accounting":accounting(&context.operations)?}))?;
        }
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    let stage_release = probe.stage_gate.release();
    let cleanup_release = probe.cleanup_gate.release();
    source.resume();
    let unaccepted_stopped = unaccepted.shutdown_optional(&context.tracker).await;
    let blank_stopped = blank.shutdown_optional(&context.tracker).await;
    let pressure_stopped = pressure.shutdown().await;
    let reporting = heartbeat.finish().await;
    stage_release?;
    cleanup_release?;
    unaccepted_stopped?;
    blank_stopped?;
    let stopped = pressure_stopped?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("returned Guest dependencies not joined").into());
    }
    let expected = proof.snapshot_memory_hash()?.to_owned();
    let path = original.path;
    tokio::task::spawn_blocking(move || evidence::verify_file(&path, &expected)).await??;
    proof.require_full_lease()?;
    proof.returned_guest_witness("producers_joined",json!({"optional_joined":true,"pressure_stopped":true,"heartbeat_joined":true,
        "provider_joined":true,"peer_joined":true,"snapshot_reverified":true,"allocated":context.budget.allocated(),
        "accounting":accounting(&context.operations)?}))?;
    let mut retirement = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_returned_guest_original_saving",
            },
        )
        .await?;
    let completed = retirement.join().await?;
    if !completed.is_complete() || completed.selected != 1 || completed.completed != 1 {
        return Err(io::Error::other("returned Guest original saving incomplete").into());
    }
    Ok(())
}
