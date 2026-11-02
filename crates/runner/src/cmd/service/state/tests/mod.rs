use serde_json::json;

use super::*;
use runner_host::service::test_support;

fn service_unit(suffix: &str) -> RunnerServiceUnit {
    RunnerServiceUnit::from_suffix(suffix).unwrap()
}

#[test]
fn unit_state_output_uses_stable_wrapper_shape() {
    let state =
        test_support::service_unit_state("loaded", "deactivating", "stop-sigterm", "success")
            .unwrap();
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
                test_support::service_unit_state("loaded", "active", "running", "success").unwrap(),
            ),
            unit_state_entry(
                service_unit("v1.2.2"),
                test_support::service_unit_state("not-found", "inactive", "dead", "success")
                    .unwrap(),
            ),
        ],
    };

    let value = serde_json::to_value(output).unwrap();

    assert_eq!(value["services"][0]["name"], "v1.2.3");
    assert_eq!(value["services"][1]["name"], "v1.2.2");
    assert_eq!(value["services"][0]["activeLike"], true);
    assert_eq!(value["services"][1]["activeLike"], false);
}
