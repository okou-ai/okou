//! Assignment-owned native resources, independent of each consumer's authority.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use runner_types::ids::RunId;
use tokio_util::sync::CancellationToken;

use crate::tailscale::{Failure, Pool, Registry};

#[derive(Clone)]
pub(crate) struct Runtime {
    inner: Arc<Inner>,
}

struct Inner {
    pool: Arc<Pool>,
    runs: Mutex<HashMap<RunId, Registration>>,
}

struct Registration {
    registry: Arc<Registry>,
    cancel: CancellationToken,
}

pub(crate) struct Run {
    runtime: Runtime,
    run: RunId,
    pub(crate) registry: Arc<Registry>,
    cancel: CancellationToken,
}

impl Runtime {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                pool: Arc::new(Pool::new()),
                runs: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn register(&self, run: RunId, cancel: &CancellationToken) -> Arc<Run> {
        let mut runs = self.inner.runs.lock().unwrap_or_else(|p| p.into_inner());
        let registry = Arc::new(match runs.get(&run) {
            Some(previous) => {
                previous.cancel.cancel();
                Registry::replacement(Arc::clone(&self.inner.pool), &previous.registry)
            }
            None => Registry::new(Arc::clone(&self.inner.pool)),
        });
        runs.insert(
            run,
            Registration {
                registry: Arc::clone(&registry),
                cancel: cancel.clone(),
            },
        );
        Arc::new(Run {
            runtime: self.clone(),
            run,
            registry,
            cancel: cancel.clone(),
        })
    }
}

impl Run {
    pub(crate) fn cancelled(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub(crate) fn close(&self) {
        self.cancel.cancel();
        self.registry.close();
    }

    pub(crate) async fn shutdown(&self) -> Result<(), Failure> {
        self.close();
        self.registry.shutdown().await?;
        // Keep failed/unfinished receipts available to same-Run replacement.
        // A stale successful shutdown must never remove its winning successor.
        let mut runs = self
            .runtime
            .inner
            .runs
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if runs
            .get(&self.run)
            .is_some_and(|entry| Arc::ptr_eq(&entry.registry, &self.registry))
        {
            runs.remove(&self.run);
        }
        Ok(())
    }

    pub(crate) fn retain_cleanup(
        &self,
        task: tokio::task::JoinHandle<()>,
    ) -> tokio::sync::oneshot::Receiver<bool> {
        self.runtime.inner.pool.retain_cleanup(task)
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.close();
    }
}
