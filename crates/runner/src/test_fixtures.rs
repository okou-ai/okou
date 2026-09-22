pub(crate) mod execution_context;
pub(crate) mod firewall_base_url_contract;
pub(crate) mod http_body;
pub(crate) mod ignored_child;
pub(crate) mod raw_http;
pub(crate) mod session_history;

#[derive(Clone)]
pub(crate) struct ReapGate {
    pub(crate) entered: std::sync::Arc<tokio::sync::Notify>,
    pub(crate) release: std::sync::Arc<tokio::sync::Semaphore>,
}

impl ReapGate {
    pub(crate) fn new() -> Self {
        Self {
            entered: Default::default(),
            release: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
        }
    }

    pub(crate) async fn wait(&self) {
        self.entered.notify_one();
        self.release
            .acquire()
            .await
            .expect("reap gate closed")
            .forget();
    }
}

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
