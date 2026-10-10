//! Active-run handoff, idle sandbox, memory prefetch, and home image lifecycle owned below the Runner process.

// The opt-in test-support build compiles fixture-only branches without the
// crate's own tests. Default production builds keep the workspace lint policy.
#![cfg_attr(
    feature = "test-support",
    allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod active_runs;
mod error;
pub mod guest_timezone;
pub mod home_image_cache;
pub mod home_mount;
pub mod home_promotion;
pub mod host_memory_operations;
pub mod host_memory_policy;
pub mod idle_pool;
pub mod idle_reuse_preparation;
pub mod lifecycle;
pub mod prefetch;
pub mod resource_budget;
pub mod restored_session_identity;
pub mod status;

pub use error::{LifecycleError, LifecycleResult};

use runner_storage::storage_fingerprints;
use sandbox::helper_exec;

mod duration {
    pub fn duration_ms(duration: std::time::Duration) -> u64 {
        u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_fixtures {
    #[cfg(test)]
    pub use runner_host::test_fixtures::ignored_child;

    pub fn home_image_cache_key(reuse_key: &str) -> String {
        runner_host::paths::scoped_home_image_cache_key(
            "",
            "vm0/default",
            "test-rootfs",
            reuse_key,
            1024 * 1024,
        )
    }

    pub fn runner_home_image_cache_dir(
        paths: &runner_host::paths::RunnerPaths,
    ) -> std::path::PathBuf {
        paths.base_dir().join("home-image-cache")
    }
}
