//! Full-budget logical transfer with independently funded physical preparation.

use runner_lifecycle::host_memory_operations::{MemoryGrowthPermit, MemoryOperation};
use runner_lifecycle::resource_budget::BudgetLease;
use sandbox::SandboxBackingProcess;
use serde_json::json;

use super::*;

pub struct Request {
    pub context: transitions::Context,
    pub permit: MemoryGrowthPermit,
    pub envelope: runner_lifecycle::idle_pool::IdleRetirementEnvelope,
    pub max_sample_age: std::time::Duration,
    pub proof: Arc<evidence::Case>,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub pool_wait: tokio::sync::oneshot::Sender<u64>,
    pub join_wait: tokio::sync::oneshot::Sender<u64>,
}

async fn held<T>(
    future: impl std::future::Future<Output = T>,
    observed: impl FnOnce() -> TestResult<()>,
) -> TestResult<T> {
    tokio::pin!(future);
    if futures_util::poll!(&mut future).is_ready() {
        return Err(io::Error::other("logical dependency did not positively poll Pending").into());
    }
    observed()?;
    Ok(future.await)
}

pub async fn exercise(request: Request) -> TestResult<BudgetLease> {
    let Request {
        context,
        mut permit,
        envelope,
        max_sample_age,
        proof,
        backing,
        pool_wait,
        join_wait,
    } = request;
    let run = RunId::new_v4();
    let mut selected = held(
        select_idle_entries_for_guarded_pressure(
            &context.pool,
            &context.status,
            &context.tracker,
            &context.budget,
            &context.operations,
            Vec::new(),
            GuardedIdlePressureRequest {
                selection: IdlePressureRequest {
                    run_id: run,
                    reuse_key: None,
                    profile_name: fixture::PROFILE,
                    device_rate_limits: &None,
                    allow_compatible_blank: false,
                    blank_pool_diagnostics: None,
                    vcpu: 2,
                    memory_mb: 4096,
                    context: "native_logical_progress",
                },
                envelope,
            },
        ),
        || {
            pool_wait
                .send(evidence::clocks()?.0)
                .map_err(|_| io::Error::other("logical pool wait observer lost"))?;
            Ok(())
        },
    )
    .await?;
    if !selected.not_started.is_empty()
        || selected.status_error.is_some()
        || selected.retirements.len() != 1
    {
        proof.retain(selected);
        return Err(io::Error::other("logical acceptance/refusal/status contract failed").into());
    }
    let lease = match selected.selection {
        IdlePressureSelection::Fresh(lease) => lease,
        other => {
            proof.retain(other);
            proof.retain(selected.retirements);
            return Err(
                io::Error::other("logical substitution did not return a full lease").into(),
            );
        }
    };
    let outcome: TestResult<()> = async {
        if (lease.vcpu(), lease.memory_mb()) != (2, 4096)
            || !lease.witness().is_some_and(|w| w.is_active() && w.resources() == (2, 4096))
            || context.budget.allocated() != (2, 4096, 1)
            || !context.pool.lock().await.is_empty()
        {
            return Err(io::Error::other("logical atomic transfer lost full coverage").into());
        }
        proof.require_full_lease()?;
        // The returned status wait is outside inventory. Refresh the original
        // unused Fresh allowance before starting its independently tracked work.
        let refresh_started = evidence::clocks()?.0;
        let observation = loop {
            match permit.refresh().await {
                Ok(observation) => break observation,
                Err(MemoryOperationError::AccountingChanged) => tokio::task::yield_now().await,
                Err(error) => return Err(error.into()),
            }
        };
        let now = tokio::time::Instant::now();
        let age = observation.age_at(now)
            .ok_or_else(|| io::Error::other("logical Fresh refresh clock invalid"))?;
        let available = observation.available_bytes_at(now, max_sample_age)?;
        let refresh_finished = evidence::clocks()?.0;
        let operation_id = permit.id().ok_or_else(|| io::Error::other("logical Fresh permit missing"))?;
        let next_factory = context.factory.clone();
        let original = backing.identity();
        let work = permit.spawn(move |mut operation| async move {
            let id = SandboxId::new_v4();
            let mut next = next_factory.create(sandbox::SandboxConfig {
                id, resources: sandbox::ResourceLimits { cpu_count: 2, memory_mb: 4096 },
                device_rate_limits: None,
                home_drive: Some(sandbox::HomeDriveConfig {
                    size_mb: 16384, seed_image: None,
                    space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
                }),
            }).await?;
            let checked: TestResult<_> = async {
                fixture::start_guest(&mut *next, run).await?;
                let physical = next.backing_process()
                    .ok_or_else(|| io::Error::other("logical replacement backing missing"))?;
                if physical.identity() == original {
                    return Err(io::Error::other("logical replacement reused original backing").into());
                }
                operation.bind_backing(physical.clone())?;
                if fixture::exec(&*next, "printf native-logical-progress").await? != b"native-logical-progress" {
                    return Err(io::Error::other("logical replacement RPC incomplete").into());
                }
                settle(&mut operation).await?;
                Ok((id, physical))
            }.await;
            let physical = next.backing_process();
            next_factory.destroy(next).await;
            if let Some(physical) = physical
                && !physical.exit_confirmed().await
            {
                return Err(io::Error::other("logical replacement positive exit missing").into());
            }
            checked
        })?;
        let (id, physical) = work.join().await??;
        if !physical.exit_confirmed().await || physical.identity() == backing.identity() {
            return Err(io::Error::other("logical replacement exact exit identity changed").into());
        }
        proof.logical_witness("replacement_prepared", json!({
            "sandbox_id": id.to_string(), "backing_generation": physical.identity().generation().to_string(),
            "operation_id": operation_id.generation().to_string(), "guest_rpc_completed": true,
            "phase_settled": true, "new_backing_exit_confirmed": true,
            "allocated": context.budget.allocated(), "logical_lease_transferred": true,
            "refresh": {"started_ns": refresh_started, "finished_ns": refresh_finished,
                "available_bytes": available, "age_ns": u64::try_from(age.as_nanos())?,
                "read_duration_ns": u64::try_from(observation.read_duration().as_nanos())?},
        }))?;
        let retirement = selected.retirements.first_mut()
            .ok_or_else(|| io::Error::other("logical accepted old cleanup missing"))?;
        let completed = held(retirement.join(), || {
            let polled = evidence::clocks()?.0;
            proof.logical_witness("old_join_polled", json!({
                "polled_ns": polled, "retirements": 1, "allocated": context.budget.allocated(),
                "old_exit_dependency_added": false,
            }))?;
            join_wait.send(polled).map_err(|_| io::Error::other("logical join observer lost"))?;
            Ok(())
        }).await???;
        if completed.outcome != DestroyOutcome::Completed || !completed.home_cache_promoted {
            return Err(io::Error::other("logical original saving incomplete").into());
        }
        Ok(())
    }.await;
    if let Err(error) = outcome {
        proof.retain(lease);
        proof.retain(selected.retirements);
        return Err(error);
    }
    Ok(lease)
}

async fn settle(operation: &mut MemoryOperation) -> TestResult<()> {
    loop {
        match operation.complete_phase().await {
            Ok(()) => return Ok(()),
            Err(MemoryOperationError::AccountingChanged) => tokio::task::yield_now().await,
            Err(error) => return Err(error.into()),
        }
    }
}
