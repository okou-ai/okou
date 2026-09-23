//! Idle sandbox and workspace image lifecycle owned below the Runner process.

// The opt-in test-support build compiles fixture-only branches without the
// crate's own tests. Default production builds keep the workspace lint policy.
#![cfg_attr(
    feature = "test-support",
    allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

mod error;
pub mod guest_timezone;
pub mod idle_pool;
pub mod idle_reuse_preparation;
pub mod lifecycle;
pub mod resource_budget;
pub mod restored_session_identity;
pub mod status;
pub mod workspace_image_cache;
pub mod workspace_mount;
pub mod workspace_promotion;

pub use error::{LifecycleError, LifecycleResult};

use runner_storage::storage_fingerprints;
use sandbox::helper_exec;

mod duration {
    pub fn duration_ms(duration: std::time::Duration) -> u64 {
        u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
    }
}

#[cfg(any(test, feature = "test-support"))]
mod test_fixtures {
    #[cfg(test)]
    pub mod ignored_child;

    pub fn workspace_image_cache_key(reuse_key: &str, working_dir: &str) -> String {
        runner_host::paths::scoped_workspace_image_cache_key(
            "",
            "vm0/default",
            reuse_key,
            working_dir,
            5,
        )
    }

    pub fn runner_workspace_image_cache_dir(
        paths: &runner_host::paths::RunnerPaths,
    ) -> std::path::PathBuf {
        paths.base_dir().join("workspace-image-cache")
    }
}
