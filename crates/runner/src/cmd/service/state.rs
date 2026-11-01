use clap::Args;
use serde::Serialize;

use crate::error::{RunnerError, RunnerResult};

use runner_host::service::{RunnerServiceUnit, ServiceUnitState, read_service_unit_state};

#[derive(Args)]
pub(super) struct UnitStateArgs {
    /// Service name suffix (repeat to query multiple runner services)
    #[arg(long = "name", value_name = "SUFFIX", required = true)]
    names: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitStateOutput {
    services: Vec<UnitStateEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitStateEntry {
    name: String,
    unit: String,
    #[serde(flatten)]
    state: ServiceUnitState,
}

pub(super) async fn run(args: UnitStateArgs) -> RunnerResult<()> {
    let units = args
        .names
        .iter()
        .map(|name| RunnerServiceUnit::from_suffix(name).map_err(RunnerError::from))
        .collect::<RunnerResult<Vec<_>>>()?;

    let mut services = Vec::with_capacity(units.len());
    for unit in units {
        let state = read_service_unit_state(&unit).await?;
        services.push(unit_state_entry(unit, state));
    }

    let output = UnitStateOutput { services };
    let json = serde_json::to_string(&output)
        .map_err(|e| RunnerError::Internal(format!("serialize unit state json: {e}")))?;
    println!("{json}");
    Ok(())
}

fn unit_state_entry(unit: RunnerServiceUnit, state: ServiceUnitState) -> UnitStateEntry {
    UnitStateEntry {
        name: unit.suffix().to_string(),
        unit: unit.service_name().to_string(),
        state,
    }
}

#[cfg(test)]
mod tests;
