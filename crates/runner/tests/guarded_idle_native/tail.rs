//! Actual bounded post-exit IO owned by the native test's required factory tail.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use sandbox::{
    Sandbox, SandboxConfig, SandboxCreateCustody, SandboxCreateObserver, SandboxFactory,
};
use serde_json::json;
use tokio_util::task::TaskTracker;

use super::evidence::{Case, TAIL_BYTES};

pub struct MeasuredFactory {
    pub inner: Box<dyn SandboxFactory>,
    pub case: Arc<Case>,
    pub directory: PathBuf,
    pub physical: TaskTracker,
}

#[async_trait]
impl SandboxFactory for MeasuredFactory {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }
    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }
    async fn create_with_custody(
        &self,
        config: SandboxConfig,
        custody: SandboxCreateCustody,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create_with_custody(config, custody).await
    }
    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        observer: &mut dyn SandboxCreateObserver,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create_with_observer(config, observer).await
    }
    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        let measured = self.case.owns(sandbox.id());
        self.inner.destroy(sandbox).await;
        if !measured {
            return;
        }
        if let Err(error) = self.run_required_tail().await {
            // The factory trait has no Result channel. Use Lifecycle's existing
            // unwind/NoProgress protocol to retain the original lease on failure.
            std::panic::resume_unwind(Box::new(error.to_string()));
        }
    }
    async fn shutdown(&mut self) {
        self.physical.close();
        self.physical.wait().await;
        self.inner.shutdown().await;
    }
}

impl MeasuredFactory {
    async fn run_required_tail(&self) -> std::io::Result<()> {
        // Positive exact backing observation precedes the growing physical tail.
        self.case.join_exit().await?;
        self.case.require_full_lease()?;
        self.case.event(
            "required_tail_started",
            json!({"bytes": TAIL_BYTES, "full_logical_lease": [2, 4096, 1]}),
        )?;
        let path = self.directory.join("required-post-exit.bin");
        let case = self.case.clone();
        let gate = self.case.foreground_io()?;
        let custody = self.physical.token();
        tokio::task::spawn_blocking(move || {
            let _custody = custody;
            if let Some(gate) = gate {
                gate.blocking_wait()?;
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            let mut buffer = vec![0x5a; 1024 * 1024];
            for _ in 0..TAIL_BYTES / buffer.len() {
                file.write_all(&buffer)?;
                // Each chunk is required durable work, not an artificial phase delay.
                file.sync_data()?;
            }
            file.sync_all()?;
            drop(file);
            let mut file = std::fs::File::open(&path)?;
            buffer.fill(0);
            let mut bytes = 0;
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                if buffer
                    .get(..count)
                    .ok_or_else(|| std::io::Error::other("invalid native tail read count"))?
                    .iter()
                    .any(|&byte| byte != 0x5a)
                {
                    return Err(std::io::Error::other("native tail bytes changed"));
                }
                bytes += count;
            }
            if bytes != TAIL_BYTES {
                return Err(std::io::Error::other("native tail incomplete"));
            }
            case.require_full_lease()?;
            case.complete_tail()
        })
        .await
        .map_err(std::io::Error::other)??;
        Ok(())
    }
}
