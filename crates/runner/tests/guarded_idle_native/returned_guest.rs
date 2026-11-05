//! Actual returned Guest custody through dropped stage and cleanup observation.

use std::time::Duration;

use runner_executor::pre_spawn_admission::{BackgroundPreSpawnAdmissionLease, PreSpawnAdmission};
use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::idle_pool::{ActivationCleanupOutcome, BlankPreparationResource};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use sandbox::{SandboxConfig, SandboxCreateCustody};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::returned_guest_probe::{Probe, accounting};
use super::*;

struct Release<'a>(&'a Probe);
impl Drop for Release<'_> {
    fn drop(&mut self) {
        let _ = self.0.stage_gate.release();
        let _ = self.0.cleanup_gate.release();
    }
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
            != json!({"registered_operations":1,"started":1,"ordinary_growth_bytes":growth,
            "cleanup_growth_bytes":0,"tracked_tasks":tracked,"uncertain":0})
    {
        return Err(io::Error::other(format!("returned Guest lost full custody: {value}")).into());
    }
    Ok(value)
}

// Release speculative CPU on cancellation, retaining the entered provider future.
async fn stage<T>(
    future: impl std::future::Future<Output = T>,
    cancel: &CancellationToken,
    cpu: &mut Option<BackgroundPreSpawnAdmissionLease>,
) -> T {
    tokio::pin!(future);
    tokio::select! {
        biased;
        () = cancel.cancelled() => { drop(cpu.take()); future.await }
        result = &mut future => result,
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
    let original = snapshot_inputs::original(&context.budget, proof).await?;
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
    let growth = 4096 * 1024 * 1024 + inputs.preparation_bytes();
    let mut preparation = None;
    let mut returned = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        proof.returned_guest_witness("inputs_verified",json!({"policy":serde_json::to_value(inputs)?,
            "inputs_sha256":continuation::digest(&original.raw),"snapshot_sha256":proof.snapshot_memory_hash()?,
            "snapshot_bytes":original.bytes,"stage":probe.stage.label(),"allocated":context.budget.allocated(),
            "checkpoint_models_stalled_io":false}))?;
        let first_sample = source.samples()?.len();
        source.resume();
        loop {
            let changed = control.changed(); tokio::pin!(changed); changed.as_mut().enable();
            if control.decision().state == HostPressureState::Ready { break; }
            changed.await;
        }
        let mut request = context.operations.request(inputs.replacement_plan()?)?;
        let permit = request.try_grant().await?;
        let lease = ResourceBudget::try_reserve_lease(&context.budget, 2, 4096)
            .ok_or_else(|| io::Error::other("returned Guest full lease unavailable"))?;
        let cpu = admission.try_acquire_background(2)?
            .ok_or_else(|| io::Error::other("returned Guest CPU unavailable"))?;
        let cancel = cpu.cancellation_token();
        let cancelled = cancel.clone();
        let factory = context.factory.clone();
        let rootfs = context.rootfs_hash.clone();
        let selected = probe.stage;
        let work = permit.spawn(move |mut operation| async move {
            let config = SandboxConfig {
                id: SandboxId::new_v4(),
                resources: sandbox::ResourceLimits { cpu_count: 2, memory_mb: 4096 },
                device_rate_limits: None,
                home_drive: Some(sandbox::HomeDriveConfig {
                    size_mb: fixture::HOME_DISK_MB, seed_image: None,
                    space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
                }),
            };
            let sandbox = factory.create_with_custody(
                config.clone(), SandboxCreateCustody::new(Arc::new(())),
            ).await?;
            let mut resource = Box::new(BlankPreparationResource::new(
                sandbox, factory, lease, config, fixture::PROFILE.into(), rootfs,
            ));
            let mut cpu = Some(cpu);
            let result: TestResult<()> = async {
                stage(resource.start(), &cancelled, &mut cpu).await?;
                resource.bind_backing(&mut operation)?;
                if selected != sandbox_firecracker::GuestPreparationStage::Start {
                    stage(resource.mount_home(), &cancelled, &mut cpu).await.map_err(io::Error::other)?;
                    if selected == sandbox_firecracker::GuestPreparationStage::Park {
                        stage(resource.park(), &cancelled, &mut cpu).await.map_err(io::Error::other)?;
                    }
                }
                if !cancelled.is_cancelled() {
                    return Err(io::Error::other("native stage returned without cancellation").into());
                }
                Ok(())
            }.await;
            // No completed Fresh settlement: the row remains uncertain while
            // the returned concrete capsule retains the original full lease.
            Ok::<_, Box<dyn Error + Send + Sync>>((resource, result))
        })?;
        preparation = Some(tokio::spawn(work.join()));
        let joined = preparation.as_mut().ok_or_else(|| io::Error::other("preparation join absent"))?;
        probe.stage_gate.wait_entered().await?;
        proof.require_full_lease()?;
        proof.returned_guest_witness("stage_accepted",json!({"actual":probe.snapshot()?,
            "samples":source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "available_bytes":control.decision().available_bytes,"allocated":context.budget.allocated(),
            "accounting":held(&context,growth)?,"release_byte_withheld":true}))?;
        cancel.cancel();
        let cancelled_ns = evidence::clocks()?.0;
        {
            let first = &mut *joined; tokio::pin!(first);
            if futures_util::poll!(&mut first).is_ready() { return Err(io::Error::other("first wait was not pending").into()); }
        }
        let first_dropped_ns = evidence::clocks()?.0;
        let released_ns;
        {
            let second = &mut *joined; tokio::pin!(second);
            if futures_util::poll!(&mut second).is_ready() { return Err(io::Error::other("replacement wait was not pending").into()); }
            let second_pending_ns = evidence::clocks()?.0;
            let foreground = admission.acquire(2,&CancellationToken::new()).await?;
            let foreground_acquired_ns = evidence::clocks()?.0;
            heartbeat.request()?; let acknowledged = heartbeat.complete().await?;
            let observed = foreground_probe::observe().await?;
            proof.require_full_lease()?;
            proof.returned_guest_witness("cancel_wait",json!({"cancelled_ns":cancelled_ns,"first_dropped_ns":first_dropped_ns,
                "second_pending_ns":second_pending_ns,"foreground_acquired_ns":foreground_acquired_ns,
                "first_pending":true,"first_dropped":true,"second_pending":true,"release_byte_withheld":true,
                "allocated":context.budget.allocated(),"accounting":held(&context,growth)?,"heartbeat":acknowledged,"observer":observed}))?;
            drop(foreground);
            released_ns = evidence::clocks()?.0; probe.stage_gate.release()?;
            let finished = second.await;
            preparation.take();
            let (resource, result) = finished???;
            returned = Some(resource);
            result?;
        }
        while context.operations.snapshot()?.tracked_tasks != 0 { tokio::task::yield_now().await; }
        let joined_ns = evidence::clocks()?.0;
        let resource = returned.as_ref().ok_or_else(|| io::Error::other("returned resource absent"))?;
        let resource_id = resource.sandbox_id();
        let prepared = resource.prepared();
        if prepared != (probe.stage == sandbox_firecracker::GuestPreparationStage::Park)
            || context.budget.allocated() != (4,8192,2) {
            return Err(io::Error::other("late stage lost actual preparation/full lease").into());
        }
        proof.returned_guest_witness("late_joined",json!({"released_ns":released_ns,"joined_ns":joined_ns,
            "resource_id":resource_id,"prepared":prepared,"allocated":context.budget.allocated(),
            "accounting":accounting(&context.operations)?}))?;
        let resource = returned.take().ok_or_else(|| io::Error::other("returned resource absent"))?;
        let mut owner = Some(resource.into_required_cleanup().map_err(|(_, error)| error)?);
        let mut cleanup = context.tracker.retire_activation_owner(
            &mut owner, &context.operations, inputs.envelope(), "native_returned_guest_required_cleanup",
        ).await?;
        if owner.is_some() { return Err(io::Error::other("cleanup custody was not transferred").into()); }
        probe.cleanup_gate.wait_entered().await?;
        {
            let finish = cleanup.join(); tokio::pin!(finish);
            if futures_util::poll!(&mut finish).is_ready() { return Err(io::Error::other("cleanup escaped held IO").into()); }
        }
        let pending_ns = evidence::clocks()?.0;
        heartbeat.request()?; let acknowledged = heartbeat.complete().await?;
        let observed = foreground_probe::observe().await?;
        proof.require_full_lease()?;
        proof.returned_guest_witness("cleanup_held",json!({"actual":probe.snapshot()?,"pending_ns":pending_ns,
            "cleanup_pending":true,"release_byte_withheld":true,"allocated":context.budget.allocated(),
            "accounting":accounting(&context.operations)?,"heartbeat":acknowledged,"observer":observed}))?;
        let release_ns = evidence::clocks()?.0; probe.cleanup_gate.release()?;
        if !matches!(cleanup.join().await??, ActivationCleanupOutcome::Completed { .. }) {
            return Err(io::Error::other("required cleanup did not complete").into());
        }
        drop(cleanup.take_completed_lease()?);
        while context.operations.snapshot()?.tracked_tasks != 0 { tokio::task::yield_now().await; }
        let joined_ns = evidence::clocks()?.0;
        if context.pool.lock().await.blank_len()!=0 || context.budget.allocated()!=(2,4096,1)
            || !probe.backing()?.exit_confirmed().await {
            return Err(io::Error::other("Guest cleanup/full lease not joined").into());
        }
        proof.returned_guest_witness("cleanup_joined",json!({"release_ns":release_ns,"joined_ns":joined_ns,
            "positive_backing_wait":true,"blank_count":0,"resource_id":resource_id,
            "allocated":context.budget.allocated(),"accounting":accounting(&context.operations)?}))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    let stage_release = probe.stage_gate.release();
    let cleanup_release = probe.cleanup_gate.release();
    source.resume();
    let recovered = async {
        if let Some(joined) = preparation.take() {
            let (resource, _) = joined.await???;
            returned = Some(resource);
        }
        if let Some(resource) = returned.take() {
            let mut owner = Some(
                resource
                    .into_required_cleanup()
                    .map_err(|(_, error)| error)?,
            );
            let mut cleanup = context
                .tracker
                .retire_activation_owner(
                    &mut owner,
                    &context.operations,
                    inputs.envelope(),
                    "native_returned_guest_failed_observer",
                )
                .await?;
            if matches!(
                cleanup.join().await??,
                ActivationCleanupOutcome::Completed { .. }
            ) {
                drop(cleanup.take_completed_lease()?);
            }
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }
    .await;
    let pressure_stopped = pressure.shutdown().await;
    let reporting = heartbeat.finish().await;
    stage_release?;
    cleanup_release?;
    let stopped = pressure_stopped?;
    reporting?;
    recovered?;
    outcome.map_err(io::Error::other)??;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("returned Guest dependencies not joined").into());
    }
    let expected = proof.snapshot_memory_hash()?.to_owned();
    let path = original.path;
    tokio::task::spawn_blocking(move || evidence::verify_file(&path, &expected)).await??;
    proof.require_full_lease()?;
    proof.returned_guest_witness("producers_joined",json!({"preparation_joined":true,"pressure_stopped":true,"heartbeat_joined":true,
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
