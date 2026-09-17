//! Run-scoped observation of the addon's accepted JSONL prefix before upload.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::ids::RunId;

use super::control::{self, ControlHandle, ControlTarget};

const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Tracks launch availability; each job freezes its target before execution.
#[derive(Clone, Default)]
pub struct MitmJsonlFlushHandle {
    control: ControlHandle,
}

pub struct MitmRunLogFlush {
    target: Option<ControlTarget>,
    run_id: RunId,
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Params<'a> {
    run_id: RunId,
    path: &'a std::path::Path,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlushResult {
    run_id: RunId,
    path: PathBuf,
    boundary: u64,
    pending: u64,
    state: FlushState,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum FlushState {
    Processed,
    Deadline,
}

impl MitmJsonlFlushHandle {
    pub(super) fn new(control: ControlHandle) -> Self {
        Self { control }
    }

    #[cfg(test)]
    pub(super) fn set_target(&self, target: Option<ControlTarget>) {
        self.control.set_target(target);
    }

    pub fn for_run(&self, run_id: RunId, path: PathBuf) -> MitmRunLogFlush {
        let target = self.control.target();
        MitmRunLogFlush {
            target,
            run_id,
            path,
        }
    }
}

impl MitmRunLogFlush {
    /// True means this generation processed the prefix, including failed append
    /// attempts. It never confirms persistence or follows a replacement launch.
    pub async fn flush(&self) -> bool {
        let Some(target) = &self.target else {
            return false;
        };
        let result: std::io::Result<FlushResult> = control::exchange(
            &target.directory,
            &target.generation,
            "logs.flush",
            Params {
                run_id: self.run_id,
                path: &self.path,
            },
            tokio::time::Instant::now() + FLUSH_TIMEOUT,
        )
        .await;
        match result {
            Ok(result)
                if result.run_id == self.run_id
                    && result.path == self.path
                    && result.pending <= result.boundary =>
            {
                matches!(result.state, FlushState::Processed) && result.pending == 0
            }
            Ok(_) => {
                warn!(run_id = %self.run_id, "addon log flush response identity or boundary mismatch");
                false
            }
            Err(error) => {
                warn!(run_id = %self.run_id, %error, "addon log flush outcome not confirmed");
                false
            }
        }
    }
}

#[cfg(test)]
mod tests;
