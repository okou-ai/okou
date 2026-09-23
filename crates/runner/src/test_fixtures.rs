pub(crate) mod execution_context;
pub(crate) mod http_body;
pub(crate) use runner_host::test_fixtures::ignored_child;
pub(crate) mod raw_http;
pub(crate) mod session_history;

pub(crate) use runner_network::ReapGate;

pub(crate) fn workspace_image_cache_key(reuse_key: &str, working_dir: &str) -> String {
    runner_host::paths::scoped_workspace_image_cache_key(
        "",
        "vm0/default",
        reuse_key,
        working_dir,
        5,
    )
}

pub(crate) fn runner_workspace_image_cache_dir(
    paths: &runner_host::paths::RunnerPaths,
) -> std::path::PathBuf {
    paths.base_dir().join("workspace-image-cache")
}
