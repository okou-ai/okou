use clap::Args;
use serde::Serialize;

use crate::error::{RunnerError, RunnerResult};

use super::systemctl::{ServiceUnitState, read_service_unit_state};
use super::target::RunnerServiceUnit;

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
        .map(|name| RunnerServiceUnit::from_suffix(name))
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

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn service_unit(suffix: &str) -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix(suffix).unwrap()
    }

    #[test]
    fn unit_state_output_uses_stable_wrapper_shape() {
        let state = ServiceUnitState::for_test("loaded", "deactivating", "stop-sigterm", "success");
        let output = UnitStateOutput {
            services: vec![unit_state_entry(service_unit("v1.2.3"), state)],
        };

        let value = serde_json::to_value(output).unwrap();

        assert_eq!(
            value,
            json!({
                "services": [
                    {
                        "name": "v1.2.3",
                        "unit": "vm0-runner-v1.2.3.service",
                        "loadState": "loaded",
                        "activeState": "deactivating",
                        "subState": "stop-sigterm",
                        "result": "success",
                        "normalizedState": "active-like",
                        "activeLike": true
                    }
                ]
            })
        );
    }

    #[test]
    fn unit_state_output_keeps_multiple_services_in_order() {
        let output = UnitStateOutput {
            services: vec![
                unit_state_entry(
                    service_unit("v1.2.3"),
                    ServiceUnitState::for_test("loaded", "active", "running", "success"),
                ),
                unit_state_entry(
                    service_unit("v1.2.2"),
                    ServiceUnitState::for_test("not-found", "inactive", "dead", "success"),
                ),
            ],
        };

        let value = serde_json::to_value(output).unwrap();

        assert_eq!(value["services"][0]["name"], "v1.2.3");
        assert_eq!(value["services"][1]["name"], "v1.2.2");
        assert_eq!(value["services"][0]["activeLike"], true);
        assert_eq!(value["services"][1]["activeLike"], false);
    }
});
