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
pub(crate) struct ArchiveConnectionAttempt {
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
mod tests {
    use std::convert::Infallible;
    use std::future::{Pending, Ready, pending, ready};

    use super::*;

    #[derive(Clone)]
    struct ReadyService(Result<u8, &'static str>);

    impl Service<()> for ReadyService {
        type Response = u8;
        type Error = &'static str;
        type Future = Ready<Result<u8, &'static str>>;

        fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, (): ()) -> Self::Future {
            ready(self.0)
        }
    }

    #[derive(Clone)]
    struct PendingService;

    impl Service<()> for PendingService {
        type Response = ();
        type Error = Infallible;
        type Future = Pending<Result<(), Infallible>>;

        fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, (): ()) -> Self::Future {
            pending()
        }
    }

    #[tokio::test]
    async fn records_success_and_failure_without_changing_results() {
        for (result, succeeded, failed) in [(Ok(7), 1u8, 0u8), (Err("nope"), 0, 1)] {
            let observer = ConnectionAttemptObserver::default();
            let mut service = ConnectionAttemptLayer.layer(ReadyService(result));
            let actual = observer.scope(async { service.call(()).await }).await;
            assert_eq!(actual, result);
            let frozen = observer.freeze();
            assert_eq!(frozen.started, 1);
            assert_eq!(frozen.succeeded, succeeded);
            assert_eq!(frozen.failed, failed);
            assert_eq!(frozen.dropped, 0);
            assert_eq!(frozen.active_at_headers, 0);
            assert!(!frozen.saturated);
        }
    }

    #[tokio::test]
    async fn freeze_rejects_late_completion() {
        let observer = ConnectionAttemptObserver::default();
        let mut service = ConnectionAttemptLayer.layer(PendingService);
        let mut future = Box::pin(observer.scope(async { service.call(()).await }));
        assert!(futures_util::poll!(&mut future).is_pending());
        let frozen = observer.freeze();
        assert_eq!(frozen.started, 1);
        assert_eq!(frozen.active_at_headers, 1);
        drop(future);
        assert_eq!(observer.freeze(), frozen);
    }

    #[tokio::test]
    async fn dropped_future_is_terminal_before_freeze() {
        let observer = ConnectionAttemptObserver::default();
        let mut service = ConnectionAttemptLayer.layer(PendingService);
        let mut future = Box::pin(observer.scope(async { service.call(()).await }));
        assert!(futures_util::poll!(&mut future).is_pending());
        drop(future);
        let frozen = observer.freeze();
        assert_eq!(frozen.started, 1);
        assert_eq!(frozen.succeeded, 0);
        assert_eq!(frozen.failed, 0);
        assert_eq!(frozen.dropped, 1);
        assert_eq!(frozen.active_at_headers, 0);
        assert!(!frozen.saturated);
    }

    #[tokio::test]
    async fn absent_scope_does_not_record_an_attempt() {
        let observer = ConnectionAttemptObserver::default();
        let mut service = ConnectionAttemptLayer.layer(ReadyService(Ok(1)));
        assert_eq!(service.call(()).await, Ok(1));
        assert_eq!(observer.freeze().started, 0);
    }

    #[test]
    fn counters_and_duration_saturate() {
        let observer = ConnectionAttemptObserver::default();
        let guards = (0..=u8::MAX)
            .map(|_| observer.start().unwrap())
            .collect::<Vec<_>>();
        let frozen = observer.freeze();
        assert_eq!(frozen.started, u8::MAX);
        assert_eq!(frozen.active_at_headers, u8::MAX);
        assert!(frozen.saturated);
        drop(guards);

        let mut duration = 1;
        let mut saturated = false;
        add_duration(
            &mut duration,
            Duration::from_millis(u64::from(u32::MAX)),
            &mut saturated,
        );
        assert_eq!(duration, u32::MAX);
        assert!(saturated);
    }
}
