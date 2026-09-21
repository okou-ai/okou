use serde::{Deserialize, Serialize};
use uuid::Uuid;

const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Stable identity of one runner process generation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", try_from = "RunnerProcessIdentityInput")]
pub(crate) struct RunnerProcessIdentity {
    runner_id: Uuid,
    heartbeat_generation: u64,
}

#[derive(Debug, thiserror::Error)]
#[error("heartbeat generation must be a positive JavaScript safe integer")]
pub(crate) struct RunnerProcessIdentityError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerProcessIdentityInput {
    runner_id: Uuid,
    heartbeat_generation: u64,
}

impl RunnerProcessIdentity {
    pub(crate) fn new(
        runner_id: Uuid,
        heartbeat_generation: u64,
    ) -> Result<Self, RunnerProcessIdentityError> {
        if heartbeat_generation == 0 || heartbeat_generation > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(RunnerProcessIdentityError);
        }
        Ok(Self {
            runner_id,
            heartbeat_generation,
        })
    }

    pub(crate) const fn runner_id(self) -> Uuid {
        self.runner_id
    }

    pub(crate) const fn heartbeat_generation(self) -> u64 {
        self.heartbeat_generation
    }
}

impl TryFrom<RunnerProcessIdentityInput> for RunnerProcessIdentity {
    type Error = RunnerProcessIdentityError;

    fn try_from(input: RunnerProcessIdentityInput) -> Result<Self, Self::Error> {
        Self::new(input.runner_id, input.heartbeat_generation)
    }
}

runner_test_group!(runtime_control; #[cfg(test)]
mod tests {
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
});
