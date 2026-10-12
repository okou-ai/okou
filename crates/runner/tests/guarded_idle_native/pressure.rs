use runner_lifecycle::host_memory_operations::HostMemoryOperations;
use runner_lifecycle::status::StatusTracker;
use runner_supervisor::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};

use super::*;

pub async fn exercise(
    pool: &SharedIdlePool,
    status: &Arc<StatusTracker>,
    tracker: &IdleDestroyTracker,
    operations: &HostMemoryOperations,
    inputs: &fixture::Inputs,
) -> TestResult<()> {
    let owner = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: pool.clone(),
        status: status.clone(),
        tracker: tracker.clone(),
        operations: operations.clone(),
        policy: inputs.pressure_policy()?,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    })?;
    let mut updates = owner.subscribe();
    let completion = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let snapshot = updates.borrow_and_update().clone();
            if snapshot.producer_lost {
                return Err(io::Error::other("native pressure producer lost"));
            }
            if let Some(report) = snapshot.last_wave {
                if report.selected != 1
                    || report.completed != 1
                    || report.uncertain != 0
                    || !report.not_started.is_empty()
                    || report.skipped != 0
                    || report.status_error.is_some()
                    || !report.is_resolved()
                {
                    return Err(io::Error::other(format!(
                        "native pressure did not prove saving: {report:?}"
                    )));
                }
                return Ok(());
            }
            updates.changed().await.map_err(io::Error::other)?;
        }
    })
    .await;
    // Always positively join the actual owner before the fixture's dependencies,
    // including on an absent-critical-sample timeout or refusal. A timeout is
    // never converted into native saving or physical completion proof.
    let stopped = owner.shutdown().await?;
    completion.map_err(io::Error::other)??;
    if stopped.producer_lost || stopped.decision.wave_inflight {
        return Err(io::Error::other("native pressure shutdown remains unresolved").into());
    }
    Ok(())
}
