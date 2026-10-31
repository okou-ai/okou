use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod persistence;
pub use persistence::load_runner_process_identity;

const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Stable identity of one runner process generation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", try_from = "RunnerProcessIdentityInput")]
pub struct RunnerProcessIdentity {
    runner_id: Uuid,
    heartbeat_generation: u64,
}

#[derive(Debug, thiserror::Error)]
#[error("heartbeat generation must be a positive JavaScript safe integer")]
pub struct RunnerProcessIdentityError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerProcessIdentityInput {
    runner_id: Uuid,
    heartbeat_generation: u64,
}

impl RunnerProcessIdentity {
    pub fn new(
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

    pub const fn runner_id(self) -> Uuid {
        self.runner_id
    }

    pub const fn heartbeat_generation(self) -> u64 {
        self.heartbeat_generation
    }
}

impl TryFrom<RunnerProcessIdentityInput> for RunnerProcessIdentity {
    type Error = RunnerProcessIdentityError;

    fn try_from(input: RunnerProcessIdentityInput) -> Result<Self, Self::Error> {
        Self::new(input.runner_id, input.heartbeat_generation)
    }
}

#[cfg(test)]
mod tests;
