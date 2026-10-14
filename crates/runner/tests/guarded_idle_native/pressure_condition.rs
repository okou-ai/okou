//! Real scenario observations complement the original data/backing/tail proof.

use runner_lifecycle::host_memory_operations::HostMemoryOperations;
use runner_lifecycle::resource_budget::ResourceBudget;

use super::*;

pub async fn observe(
    operations: &HostMemoryOperations,
    budget: &ResourceBudget,
    inputs: &fixture::Inputs,
    scope: NativeScope,
    proof: &evidence::Case,
) -> TestResult<()> {
    let policy = inputs.pressure_policy()?;
    let observation = operations.observe_pressure().await;
    let now = tokio::time::Instant::now();
    let age = observation
        .age_at(now)
        .ok_or_else(|| io::Error::other("native observation clock is in the future"))?;
    let available = observation.available_bytes_at(now, policy.max_sample_age)?;
    let can_fit = budget.can_afford(2, 4096);
    let allocated = budget.allocated();
    if allocated != (2, 4096, 1) || available > policy.bounds.host_total_bytes {
        return Err(
            io::Error::other("native pressure observation lost its original budget/host").into(),
        );
    }
    let kind = match scope {
        NativeScope::Pressure if can_fit && available <= policy.bounds.critical_available_bytes => {
            "physical"
        }
        NativeScope::Logical if !can_fit && available >= policy.bounds.recovery_available_bytes => {
            let growth = policy
                .bounds
                .growth_bytes(4096, inputs.preparation_bytes())?;
            let required = policy
                .bounds
                .operating_floor_bytes
                .checked_add(policy.bounds.cleanup_reserve_bytes)
                .and_then(|v| v.checked_add(growth))
                .ok_or_else(|| io::Error::other("native logical headroom overflow"))?;
            if available < required {
                return Err(
                    io::Error::other("native logical replacement lacks fitting headroom").into(),
                );
            }
            "logical"
        }
        _ => {
            return Err(
                io::Error::other("actual native pressure scenario condition is absent").into(),
            );
        }
    };
    proof.event(
        "scenario_observed",
        serde_json::json!({
            "kind": kind,
            "policy": serde_json::to_value(inputs)?,
            "available_bytes": available,
            "age_ns": u64::try_from(age.as_nanos())?,
            "read_duration_ns": u64::try_from(observation.read_duration().as_nanos())?,
            "allocated": allocated,
            "profile_can_fit": can_fit,
        }),
    )?;
    Ok(())
}
