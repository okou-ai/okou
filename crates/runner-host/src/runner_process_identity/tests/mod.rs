use super::*;

const RUNNER_ID: Uuid = Uuid::from_u128(1);

fn wire_value(heartbeat_generation: u64) -> serde_json::Value {
    serde_json::json!({
        "runnerId": RUNNER_ID,
        "heartbeatGeneration": heartbeat_generation,
    })
}

#[test]
fn construction_and_deserialization_accept_wire_bounds() {
    for heartbeat_generation in [1, JAVASCRIPT_MAX_SAFE_INTEGER] {
        let constructed = RunnerProcessIdentity::new(RUNNER_ID, heartbeat_generation).unwrap();
        let deserialized: RunnerProcessIdentity =
            serde_json::from_value(wire_value(heartbeat_generation)).unwrap();

        assert_eq!(constructed, deserialized);
        assert_eq!(constructed.runner_id(), RUNNER_ID);
        assert_eq!(constructed.heartbeat_generation(), heartbeat_generation);
    }
}

#[test]
fn construction_and_deserialization_reject_out_of_range_values() {
    for heartbeat_generation in [0, JAVASCRIPT_MAX_SAFE_INTEGER + 1] {
        assert!(RunnerProcessIdentity::new(RUNNER_ID, heartbeat_generation).is_err());
        assert!(
            serde_json::from_value::<RunnerProcessIdentity>(wire_value(heartbeat_generation))
                .is_err()
        );
    }
}

#[test]
fn serde_preserves_strict_camel_case_wire_shape() {
    let identity = RunnerProcessIdentity::new(RUNNER_ID, 7).unwrap();

    assert_eq!(serde_json::to_value(identity).unwrap(), wire_value(7));
    assert!(
        serde_json::from_value::<RunnerProcessIdentity>(serde_json::json!({
            "runnerId": RUNNER_ID,
            "heartbeatGeneration": 7,
            "unexpected": true,
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<RunnerProcessIdentity>(serde_json::json!({
            "runnerId": "not-a-uuid",
            "heartbeatGeneration": 7,
        }))
        .is_err()
    );
}
