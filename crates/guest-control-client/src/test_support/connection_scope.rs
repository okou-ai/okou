//! Explicit invocation routing for the real accepted Guest stream.

use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::net::UnixStream;

type Adapter = dyn Fn(UnixStream) -> io::Result<UnixStream> + Send + Sync;

struct Inner {
    sandbox_id: String,
    claimed: AtomicBool,
    adapter: Box<Adapter>,
}

/// One sandbox's accepted-stream adapter, excluded from default builds.
///
/// Task scopes do not propagate through `tokio::spawn`. The spawning owner must
/// capture [`Self::current`] and explicitly reinstall it around the listener.
/// Clones share one acceptance claim; they cannot intercept another connection.
#[derive(Clone)]
pub struct ConnectionScope(Arc<Inner>);

tokio::task_local! {
    static CONNECTION_SCOPE: ConnectionScope;
}

impl ConnectionScope {
    /// Bind one real accepted stream to its immutable sandbox attribution.
    pub fn new(
        sandbox_id: String,
        adapter: impl Fn(UnixStream) -> io::Result<UnixStream> + Send + Sync + 'static,
    ) -> io::Result<Self> {
        if sandbox_id.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "empty sandbox id",
            ));
        }
        Ok(Self(Arc::new(Inner {
            sandbox_id,
            claimed: AtomicBool::new(false),
            adapter: Box::new(adapter),
        })))
    }

    /// Capture only this task's scope before explicitly spawning a listener.
    pub fn current() -> Option<Self> {
        CONNECTION_SCOPE.try_with(Clone::clone).ok()
    }

    /// Install routing for this future; cancellation restores the previous scope.
    pub async fn scope<F: Future>(&self, future: F) -> F::Output {
        CONNECTION_SCOPE.scope(self.clone(), future).await
    }

    pub(crate) fn adapt(stream: UnixStream, sandbox_id: Option<&str>) -> io::Result<UnixStream> {
        let Some(scope) = Self::current() else {
            return Ok(stream);
        };
        if sandbox_id != Some(scope.0.sandbox_id.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "accepted Guest stream belongs to another sandbox",
            ));
        }
        if scope.0.claimed.swap(true, Ordering::AcqRel) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Guest connection scope already claimed",
            ));
        }
        (scope.0.adapter)(stream)
    }
}
