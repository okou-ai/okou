use runner_lifecycle::host_memory_operations::MemoryOperation;
use runner_lifecycle::idle_pool::BlankPreparationResource;

use super::retention::{CreateCustody, CreateHold};
use super::*;

pub(super) async fn prepare(
    mut context: Context,
    operation: MemoryOperation,
    lease: BudgetLease,
) -> Result<(), String> {
    let hold = Arc::new(CreateHold::new(operation, lease));
    context.result.lock().payload = Some(Payload::Creating(hold.clone()));
    let mut slot = context.result.slot().map_err(|e| e.to_string())?;
    if context.result.cancel.is_cancelled()
        || !context
            .opportunity
            .revalidate()
            .map_err(|e| e.to_string())?
    {
        return Err("optional preparation revoked before physical create".into());
    }
    let config = SandboxConfig {
        id: SandboxId::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: context.plan.profile.vcpu,
            memory_mb: context.plan.profile.memory_mb,
        },
        device_rate_limits: context.plan.device_rate_limits.clone(),
        home_drive: Some(sandbox::HomeDriveConfig {
            size_mb: context.plan.profile.home_disk_mb,
            seed_image: None,
        }),
    };
    let custody = sandbox::SandboxCreateCustody::new(Arc::new(CreateCustody {
        _hold: hold.clone(),
        _physical: hold.physical.token(),
    }));
    let created = {
        let create = AssertUnwindSafe(
            context
                .plan
                .factory
                .create_with_custody(config.clone(), custody),
        )
        .catch_unwind();
        tokio::pin!(create);
        tokio::select! {
            biased;
            () = context.result.cancel.cancelled() => { drop(context.pre_spawn.take()); None }
            result = &mut create => Some(result),
        }
        // Drop the acquisition future here, before joining only its independently
        // accepted physical IO/rollback. Do not wait on a canceled COW/netns wait.
    };
    let _ = hold.physical.close();
    tokio::select! {
        biased;
        () = context.result.cancel.cancelled() => {
            drop(context.pre_spawn.take());
            hold.physical.wait().await;
        }
        () = hold.physical.wait() => {}
    }
    let created = match created {
        Some(Ok(Ok(created))) => created,
        Some(Ok(Err(error))) => {
            drop(hold.take_operation());
            drop(hold.take_lease());
            slot.payload = None;
            return Err(error.to_string());
        }
        Some(Err(_)) | None => {
            drop(hold.take_operation());
            drop(hold.take_lease());
            slot.payload = None;
            return Err(
                "creation cancelled/lost; joined physical rollback, Fresh remains uncertain".into(),
            );
        }
    };
    let mut operation = hold.take_operation().map_err(|e| e.to_string())?;
    let lease = hold.take_lease().map_err(|e| e.to_string())?;
    slot.payload = Some(Payload::Preparing(Box::new(BlankPreparationResource::new(
        created,
        context.plan.factory.clone(),
        lease,
        config,
        context.plan.profile_name.clone(),
        context.plan.profile.rootfs_hash.clone(),
    ))));
    let Some(Payload::Preparing(resource)) = slot.payload.as_mut() else {
        return Err("blank preparation resource missing".into());
    };
    if !context
        .opportunity
        .revalidate()
        .map_err(|e| e.to_string())?
    {
        context.result.cancel();
    }
    let started = run_background_stage(
        resource.start(),
        &context.result.cancel,
        &mut context.pre_spawn,
    )
    .await;
    // Capture the actual generation even after a partial start error; retaining
    // this capsule cannot relabel the failed physical state as reusable.
    let backing = resource
        .bind_backing(&mut operation)
        .map_err(|e| e.to_string());
    stage_result(started, "start")?;
    backing?;
    if !context
        .opportunity
        .revalidate()
        .map_err(|e| e.to_string())?
    {
        context.result.cancel();
    }
    stage_result(
        run_background_stage(
            resource.mount_home(),
            &context.result.cancel,
            &mut context.pre_spawn,
        )
        .await,
        "home_mount",
    )?;
    resource
        .bind_backing(&mut operation)
        .map_err(|e| e.to_string())?;
    if !context
        .opportunity
        .revalidate()
        .map_err(|e| e.to_string())?
    {
        context.result.cancel();
    }
    stage_result(
        run_background_stage(
            resource.park(),
            &context.result.cancel,
            &mut context.pre_spawn,
        )
        .await,
        "park",
    )?;
    resource
        .bind_backing(&mut operation)
        .map_err(|e| e.to_string())?;
    if !resource.prepared() {
        return Err("blank provider did not establish reusable preparation".into());
    }
    drop(context.pre_spawn.take());
    operation
        .complete_phase()
        .await
        .map_err(|e| e.to_string())?;
    let Some(Payload::Preparing(resource)) = slot.payload.take() else {
        return Err("prepared blank resource missing".into());
    };
    match resource.into_incoming() {
        Ok(incoming) => {
            slot.payload = Some(Payload::Incoming(Box::new(incoming)));
            Ok(())
        }
        Err((resource, error)) => {
            slot.payload = Some(Payload::Preparing(resource));
            Err(error.to_string())
        }
    }
}

fn stage_result<T, E: std::fmt::Display>(
    stage: BackgroundStageResult<T, E>,
    name: &'static str,
) -> Result<(), String> {
    match stage {
        BackgroundStageResult::Completed(Ok(_)) => Ok(()),
        BackgroundStageResult::Completed(Err(error)) => Err(format!("{name}: {error}")),
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => Err(format!(
            "{name}: optional work cancelled; resource retained"
        )),
        BackgroundStageResult::Panicked => {
            Err(format!("{name}: provider panicked; resource retained"))
        }
    }
}
