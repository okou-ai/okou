//! Claimed-run sandbox execution, session history, result composition, and telemetry.

pub mod executor;
pub mod http;
pub mod network_provider_adapter;
pub mod pre_spawn_admission;
pub mod telemetry;

mod error;
pub use error::{ExecutorError, ExecutorResult};

#[cfg(any(test, feature = "test-support"))]
pub mod test_fixtures;

use runner_lifecycle::{
    guest_timezone, idle_pool, resource_budget, restored_session_identity, workspace_image_cache,
    workspace_mount, workspace_promotion,
};
use runner_network::{dns, network_log_drain, network_log_manager, network_logs, proxy};
use runner_remote::guest_rpc;

#[cfg(test)]
use runner_lifecycle::idle_reuse_preparation;
#[cfg(test)]
use runner_remote::ssh;
use runner_storage::{storage_cache, storage_fingerprints, storage_plan};
use sandbox::helper_exec;

mod duration {
    pub fn duration_ms(duration: std::time::Duration) -> u64 {
        u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
    }
}
