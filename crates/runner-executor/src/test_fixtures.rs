// The opt-in feature builds assertion-heavy fixtures for dependent Runner tests.
// Keep these test-only allowances within the fixture module.
#![cfg_attr(
    feature = "test-support",
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod execution_context;
pub use runner_host::test_fixtures::ignored_child;
pub mod raw_http;
pub mod session_history;

pub use runner_network::ReapGate;

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
