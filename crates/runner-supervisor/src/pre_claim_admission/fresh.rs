//! Tenant-free preparation on the selected Runner, owned by its claim task.

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::idle_pool::{BlankPreparationResource, DestroyOutcome, ReservedIdleSandbox};
use sandbox::{HomeDriveConfig, ResourceLimits, SandboxConfig, SandboxId};
use tokio_util::sync::CancellationToken;

use super::*;

pub(super) struct FreshProfile<'a> {
    pub factory: &'a crate::SharedFactory,
    pub rootfs_hash: &'a str,
    pub profile_name: &'a str,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub home_disk_mb: u32,
    pub device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
}

pub(super) enum Preparation {
    Ready(Box<ReservedIdleSandbox>),
    Unprepared(BudgetLease),
    Uncertain(String),
}

pub(super) async fn prepare(
    profile: FreshProfile<'_>,
    lease: BudgetLease,
    preference: runner_provider::ActiveRunnerPreference,
    admission: &PreSpawnAdmission,
    cancel: &CancellationToken,
    tracker: &IdleDestroyTracker,
) -> Preparation {
    // Wait for the same weighted CPU gate used by post-Claim fresh creation.
    // Expired advice cannot start speculative physical work after a gate wait.
    let permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Preparation::Unprepared(lease),
        _ = tokio::time::sleep_until(preference.deadline().into()) => {
            return Preparation::Unprepared(lease);
        }
        permit = admission.acquire(profile.vcpu, cancel) => match permit {
            Ok(permit) => permit,
            Err(_) => return Preparation::Unprepared(lease),
        },
    };
    if cancel.is_cancelled() || preference.is_expired() {
        return Preparation::Unprepared(lease);
    }
    let config = SandboxConfig {
        id: SandboxId::new_v4(),
        resources: ResourceLimits {
            cpu_count: profile.vcpu,
            memory_mb: profile.memory_mb,
        },
        device_rate_limits: profile.device_rate_limits.clone(),
        home_drive: Some(HomeDriveConfig {
            size_mb: profile.home_disk_mb,
            seed_image: None,
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
        }),
    };
    // Once create/start has begun, cancellation observes the operation rather
    // than dropping a future that may still own blocking IO or a physical VM.
    let sandbox = match AssertUnwindSafe(profile.factory.create(config.clone()))
        .catch_unwind()
        .await
    {
        Ok(Ok(sandbox)) => sandbox,
        Ok(Err(error)) => {
            warn!(%error, "pre-claim blank creation failed; keeping ordinary fresh admission");
            return Preparation::Unprepared(lease);
        }
        Err(_) => {
            tracker.retain_uncertain_preparation_lease(lease);
            return Preparation::Uncertain("pre-claim blank factory creation panicked".to_owned());
        }
    };
    let mut owner = Box::new(BlankPreparationResource::new(
        sandbox,
        Arc::clone(profile.factory),
        lease,
        config,
        profile.profile_name.to_owned(),
        profile.rootfs_hash.to_owned(),
    ));
    let prepared = AssertUnwindSafe(async {
        if cancel.is_cancelled() {
            return Err("pre-claim preparation cancelled".to_owned());
        }
        owner.start().await.map_err(|error| error.to_string())?;
        if cancel.is_cancelled() {
            return Err("pre-claim preparation cancelled".to_owned());
        }
        owner.mount_home().await?;
        if cancel.is_cancelled() {
            return Err("pre-claim preparation cancelled".to_owned());
        }
        owner.park().await?;
        if cancel.is_cancelled() {
            return Err("pre-claim preparation cancelled".to_owned());
        }
        Ok(())
    })
    .catch_unwind()
    .await;
    drop(permit);
    if matches!(prepared, Ok(Ok(()))) {
        owner = match owner.into_parked() {
            Ok(candidate) => return Preparation::Ready(Box::new(candidate.into_reservation())),
            Err(owner) => owner,
        };
    }
    let error = match prepared {
        Ok(Err(error)) => error,
        Err(_) => "pre-claim blank preparation panicked".to_owned(),
        Ok(Ok(())) => "pre-claim blank identity could not be verified".to_owned(),
    };
    warn!(%error, "retiring unsuccessful pre-claim blank preparation");
    retire(owner.into_destroy_job(), tracker).await
}

pub(super) async fn retire(
    job: runner_lifecycle::idle_pool::IdleDestroyJob,
    tracker: &IdleDestroyTracker,
) -> Preparation {
    let mut cleanup = tracker.spawn_job(job, "pre_claim_blank_cleanup");
    match cleanup.join().await {
        Ok(result) if result.outcome == DestroyOutcome::Completed => {
            Preparation::Unprepared(result.budget_lease)
        }
        Ok(result) => {
            tracker.retain_uncertain_preparation_lease(result.budget_lease);
            Preparation::Uncertain(
                "pre-claim blank cleanup was uncertain; replacement was not started".to_owned(),
            )
        }
        // Accepted cleanup lives in the tracker and owns its original lease.
        // A lost producer is a reactor ownership failure, not a fresh permit.
        Err(error) => {
            Preparation::Uncertain(format!("pre-claim blank cleanup producer lost: {error}"))
        }
    }
}
