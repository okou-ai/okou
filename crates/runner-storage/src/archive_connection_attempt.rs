use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures_util::future::{BoxFuture, FutureExt as _};
use serde::Serialize;
use tower_layer::Layer;
use tower_service::Service;

tokio::task_local! {
    static CURRENT_OBSERVER: ConnectionAttemptObserver;
}

/// Bounded connector lifecycle observed before one archive header phase ended.
///
/// Connector activity does not identify the transport that served the request:
/// hyper can let a pool checkout win after a connection attempt has started.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ArchiveConnectionAttempt {
    started: u8,
    succeeded: u8,
    failed: u8,
    dropped: u8,
    active_at_headers: u8,
    terminal_duration_ms: u32,
    saturated: bool,
}

#[derive(Clone, Default)]
pub(crate) struct ConnectionAttemptObserver {
    state: Arc<Mutex<ConnectionAttemptState>>,
}

#[derive(Default)]
struct ConnectionAttemptState {
    frozen: bool,
    started: u8,
    succeeded: u8,
    failed: u8,
    dropped: u8,
    active: u8,
    terminal_duration_ms: u32,
    saturated: bool,
}

impl ConnectionAttemptObserver {
    pub(crate) async fn scope<F>(&self, future: F) -> F::Output
    where
        F: Future,
    {
        CURRENT_OBSERVER.scope(self.clone(), future).await
    }

    pub(crate) fn freeze(&self) -> ArchiveConnectionAttempt {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.frozen = true;
        ArchiveConnectionAttempt {
            started: state.started,
            succeeded: state.succeeded,
            failed: state.failed,
            dropped: state.dropped,
            active_at_headers: state.active,
            terminal_duration_ms: state.terminal_duration_ms,
            saturated: state.saturated,
        }
    }

    fn start(&self) -> Option<ConnectionAttemptGuard> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.frozen {
            return None;
        }
        let ConnectionAttemptState {
            started,
            active,
            saturated,
            ..
        } = &mut *state;
        increment(started, saturated);
        increment(active, saturated);
        drop(state);
        Some(ConnectionAttemptGuard {
            observer: Some(self.clone()),
            started_at: Instant::now(),
        })
    }

    fn finish(&self, outcome: ConnectionAttemptOutcome, elapsed: Duration) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.frozen {
            return;
        }
        state.active = state.active.saturating_sub(1);
        let ConnectionAttemptState {
            succeeded,
            failed,
            dropped,
            terminal_duration_ms,
            saturated,
            ..
        } = &mut *state;
        match outcome {
            ConnectionAttemptOutcome::Succeeded => increment(succeeded, saturated),
            ConnectionAttemptOutcome::Failed => increment(failed, saturated),
            ConnectionAttemptOutcome::Dropped => increment(dropped, saturated),
        }
        add_duration(terminal_duration_ms, elapsed, saturated);
    }
}

fn increment(value: &mut u8, saturated: &mut bool) {
    match value.checked_add(1) {
        Some(next) => *value = next,
        None => *saturated = true,
    }
}

fn add_duration(total_ms: &mut u32, elapsed: Duration, saturated: &mut bool) {
    let elapsed_ms = match u32::try_from(elapsed.as_millis()) {
        Ok(value) => value,
        Err(_) => {
            *saturated = true;
            u32::MAX
        }
    };
    match total_ms.checked_add(elapsed_ms) {
        Some(next) => *total_ms = next,
        None => {
            *total_ms = u32::MAX;
            *saturated = true;
        }
    }
}

enum ConnectionAttemptOutcome {
    Succeeded,
    Failed,
    Dropped,
}

struct ConnectionAttemptGuard {
    observer: Option<ConnectionAttemptObserver>,
    started_at: Instant,
}

impl ConnectionAttemptGuard {
    fn finish(mut self, outcome: ConnectionAttemptOutcome) {
        let Some(observer) = self.observer.take() else {
            return;
        };
        observer.finish(outcome, self.started_at.elapsed());
    }
}

impl Drop for ConnectionAttemptGuard {
    fn drop(&mut self) {
        if let Some(observer) = self.observer.take() {
            observer.finish(ConnectionAttemptOutcome::Dropped, self.started_at.elapsed());
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ConnectionAttemptLayer;

impl<S> Layer<S> for ConnectionAttemptLayer {
    type Service = ConnectionAttemptService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ConnectionAttemptService { inner }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ConnectionAttemptService<S> {
    inner: S,
}

impl<S, Request> Service<Request> for ConnectionAttemptService<S>
where
    S: Service<Request>,
    S::Future: Send + 'static,
    S::Response: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = BoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let guard = CURRENT_OBSERVER
            .try_with(ConnectionAttemptObserver::start)
            .ok()
            .flatten();
        let future = self.inner.call(request);
        async move {
            let result = future.await;
            if let Some(guard) = guard {
                guard.finish(if result.is_ok() {
                    ConnectionAttemptOutcome::Succeeded
                } else {
                    ConnectionAttemptOutcome::Failed
                });
            }
            result
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests;
