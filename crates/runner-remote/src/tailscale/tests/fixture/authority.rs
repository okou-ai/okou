//! Compose the real assignment owner and SSH authority at the native IO boundary.

use crate::{native, ssh::cache};
use runner_types::ids::RunId;
use std::{ops::Deref, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) struct Cache {
    native: native::Runtime,
    authority: cache::Cache,
}

pub(crate) struct Registration {
    authority: Arc<cache::Registration>,
    pub(crate) native: Arc<native::Run>,
}

impl Cache {
    pub(crate) fn new() -> Self {
        Self {
            native: native::Runtime::new(),
            authority: cache::Cache::new(),
        }
    }

    pub(crate) fn register(&self, run: RunId) -> Arc<Registration> {
        let native = self
            .native
            .register_with_diagnostics(run, &CancellationToken::new(), false);
        Arc::new(Registration {
            authority: self.authority.register(run, Arc::clone(&native)),
            native,
        })
    }

    pub(crate) fn invalidate(&self, run: RunId, connection: Option<uuid::Uuid>) {
        self.authority.invalidate(run, connection);
    }
}

impl Registration {
    pub(crate) fn close(&self) {
        self.authority.close();
        self.native.close();
    }

    pub(crate) async fn shutdown_native(&self) -> Result<(), crate::tailscale::Failure> {
        self.native.shutdown().await
    }
}

impl Deref for Registration {
    type Target = Arc<cache::Registration>;
    fn deref(&self) -> &Self::Target {
        &self.authority
    }
}
