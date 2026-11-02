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
