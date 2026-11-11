//! Explicit invocation routing for the real Guest listener and accepted stream.

use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::net::UnixStream;
use tokio::sync::Notify;

type Adapter = dyn Fn(UnixStream) -> io::Result<UnixStream> + Send + Sync;

struct Inner {
    sandbox_id: String,
    claimed: AtomicBool,
    listener_bound: Notify,
    adapter: Box<Adapter>,
}

/// One sandbox's listener readiness and stream adapter, excluded from default builds.
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
            listener_bound: Notify::new(),
            adapter: Box::new(adapter),
        })))
    }

    /// Capture only this task's scope before explicitly spawning a listener.
    pub fn current() -> Option<Self> {
        CONNECTION_SCOPE.try_with(Clone::clone).ok()
    }

    /// Install routing for this future; cancellation restores the previous scope.
    /// Heap-own the caller's future so large Executor work does not expand each
    /// task-local wrapper's stack frame in unoptimized native tests.
    pub fn scope<F: Future>(&self, future: F) -> impl Future<Output = F::Output> {
        CONNECTION_SCOPE.scope(self.clone(), Box::pin(future))
    }

    /// Wait once for this sandbox's real listener to finish binding.
    ///
    /// One waiter is supported per scope. The notification is retained if bind
    /// completes before the wait starts; it does not claim the accepted stream.
    pub async fn wait_for_listener(&self) {
        self.0.listener_bound.notified().await;
    }

    pub(crate) fn notify_listener_bound(sandbox_id: Option<&str>) {
        if let Some(scope) = Self::current()
            && sandbox_id == Some(scope.0.sandbox_id.as_str())
        {
            scope.0.listener_bound.notify_one();
        }
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
