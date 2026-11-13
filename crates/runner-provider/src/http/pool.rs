//! Replace failed API pools without cancelling their active connections.

use std::sync::{Arc, Mutex, MutexGuard};

use reqwest::Client;

use super::{ConnectionDiagnosticsLayer, DEFAULT_TIMEOUT, ProviderError, ProviderResult};

pub(super) struct ClientPool {
    current: Mutex<Arc<Client>>,
    build: Box<dyn Fn() -> ProviderResult<Client> + Send + Sync>,
}

impl ClientPool {
    pub(super) fn new(
        build: impl Fn() -> ProviderResult<Client> + Send + Sync + 'static,
    ) -> ProviderResult<Self> {
        Ok(Self {
            current: Mutex::new(Arc::new(build()?)),
            build: Box::new(build),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Arc<Client>> {
        self.current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn current(&self) -> Arc<Client> {
        self.lock().clone()
    }

    pub(super) fn retire(&self, failed: &Arc<Client>) -> ProviderResult<()> {
        if !Arc::ptr_eq(&self.current(), failed) {
            return Ok(());
        }

        // Client setup may load TLS/proxy state. Do not hold the dispatch lock
        // while building, and do not let a late old failure replace a new pool.
        let replacement = Arc::new((self.build)()?);
        let mut current = self.lock();
        if Arc::ptr_eq(&current, failed) {
            *current = replacement;
        }
        // Active sends retain their client. Hyper's busy connection driver also
        // outlives the pool while a returned response body is being consumed.
        Ok(())
    }
}

pub(super) fn build_client() -> ProviderResult<Client> {
    Client::builder()
        .gzip(true)
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .timeout(DEFAULT_TIMEOUT)
        .connector_layer(ConnectionDiagnosticsLayer)
        .build()
        .map_err(|error| ProviderError::Internal(format!("http client: {error}")))
}
