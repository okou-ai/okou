#[derive(Clone)]
pub struct ReapGate {
    pub entered: std::sync::Arc<tokio::sync::Notify>,
    pub release: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Default for ReapGate {
    fn default() -> Self {
        Self::new()
    }
}

impl ReapGate {
    pub fn new() -> Self {
        Self {
            entered: Default::default(),
            release: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
        }
    }

    #[allow(clippy::expect_used)]
    pub async fn wait(&self) {
        self.entered.notify_one();
        self.release
            .acquire()
            .await
            .expect("reap gate closed")
            .forget();
    }
}
