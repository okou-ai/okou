use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use tracing_subscriber::prelude::*;
use tracing_test_support::{
    CapturedEvent, CapturedEvents, capture_current_thread_events, capture_future_events,
};

fn capture<'a>(
    per_poll: bool,
    future: impl Future<Output = usize> + 'a,
) -> Pin<Box<dyn Future<Output = (usize, Vec<CapturedEvent>)> + 'a>> {
    if per_poll {
        Box::pin(capture_future_events(future))
    } else {
        Box::pin(capture_current_thread_events(future))
    }
}

fn messages(events: &[CapturedEvent]) -> Vec<Option<&str>> {
    events
        .iter()
        .map(|event| event.fields.get("message").map(String::as_str))
        .collect()
}

#[test]
fn async_capture_preserves_pending_scope_output_and_restoration() {
    for per_poll in [true, false] {
        let outer = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(outer.clone());
        let _guard = tracing::subscriber::set_default(subscriber);
        let mut first_poll = true;
        let future = poll_fn(|_| {
            if first_poll {
                first_poll = false;
                tracing::info!("first poll");
                Poll::Pending
            } else {
                tracing::info!("second poll");
                Poll::Ready(42)
            }
        });
        let mut operation = capture(per_poll, future);
        let mut context = Context::from_waker(Waker::noop());

        tracing::info!("before first poll");
        assert!(operation.as_mut().poll(&mut context).is_pending());
        tracing::info!("between polls");
        let Poll::Ready((output, events)) = operation.as_mut().poll(&mut context) else {
            panic!("capture should complete with its operation");
        };
        assert_eq!(output, 42);
        tracing::info!("after completion");

        let expected_inner = if per_poll {
            vec!["first poll", "second poll"]
        } else {
            vec!["first poll", "between polls", "second poll"]
        };
        let expected_outer = if per_poll {
            vec!["before first poll", "between polls", "after completion"]
        } else {
            vec!["before first poll", "after completion"]
        };
        assert_eq!(
            messages(&events),
            expected_inner.into_iter().map(Some).collect::<Vec<_>>()
        );
        assert_eq!(
            messages(&outer.entries()),
            expected_outer.into_iter().map(Some).collect::<Vec<_>>()
        );
    }
}

#[test]
fn cancellation_and_unwind_restore_the_outer_subscriber() {
    for per_poll in [true, false] {
        for panic_on_resume in [true, false] {
            let outer = CapturedEvents::default();
            let subscriber = tracing_subscriber::registry().with(outer.clone());
            let _guard = tracing::subscriber::set_default(subscriber);
            let mut first_poll = true;
            let future = poll_fn(|_| {
                assert!(first_poll, "operation panic");
                first_poll = false;
                tracing::info!("pending operation");
                Poll::<usize>::Pending
            });
            let mut operation = capture(per_poll, future);
            let mut context = Context::from_waker(Waker::noop());
            assert!(operation.as_mut().poll(&mut context).is_pending());

            if panic_on_resume {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    let _ = operation.as_mut().poll(&mut context);
                }));
                assert!(result.is_err(), "operation panic should propagate");
            } else {
                drop(operation);
            }

            tracing::info!("after capture retirement");
            assert_eq!(
                messages(&outer.entries()),
                vec![Some("after capture retirement")]
            );
        }
    }
}
