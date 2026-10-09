use super::super::*;
use tracing::info;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

fn event_with_message<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|value| value == message)
        })
        .unwrap_or_else(|| panic!("missing event message {message:?}; captured={events:#?}"))
}

fn register_teardown_timer_callsites() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let _guard = runtime.enter();
    let timer = TeardownTimer::start();
    let phase = timer.phase_start("warmup_phase");
    timer.phase_complete("warmup_phase", phase);
    timer.event("warmup_event");
    info!(total_teardown_ms = timer.elapsed_ms(), "runner stopped");
}

#[tokio::test]
async fn teardown_timer_emits_structured_timing_fields() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    // These callsites are also hit by parallel runner tests. Reproduce the
    // problematic shape by registering them on a thread without this
    // thread-local subscriber, then rebuild the cache for this subscriber.
    std::thread::spawn(register_teardown_timer_callsites)
        .join()
        .expect("callsite warmup thread panicked");
    tracing::callsite::rebuild_interest_cache();
    captured.clear();

    let timer = TeardownTimer::start();
    let phase = timer.phase_start("test_phase");
    timer.phase_complete("test_phase", phase);
    timer.event("drop_discover_fut");
    info!(total_teardown_ms = timer.elapsed_ms(), "runner stopped");

    let events = captured.entries();
    event_with_message(&events, "teardown started");

    let started = event_with_message(&events, "teardown phase started");
    assert_eq!(
        started.fields.get("phase").map(String::as_str),
        Some("test_phase")
    );
    assert!(started.fields.contains_key("elapsed_ms"));
    assert_eq!(started.field_kinds.get("elapsed_ms").copied(), Some("u64"));

    let complete = event_with_message(&events, "teardown phase complete");
    assert_eq!(
        complete.fields.get("phase").map(String::as_str),
        Some("test_phase")
    );
    assert!(complete.fields.contains_key("phase_ms"));
    assert_eq!(complete.field_kinds.get("phase_ms").copied(), Some("u64"));
    assert!(complete.fields.contains_key("elapsed_ms"));
    assert_eq!(complete.field_kinds.get("elapsed_ms").copied(), Some("u64"));

    let event = event_with_message(&events, "teardown phase event");
    assert_eq!(
        event.fields.get("phase").map(String::as_str),
        Some("drop_discover_fut")
    );
    assert!(event.fields.contains_key("elapsed_ms"));
    assert_eq!(event.field_kinds.get("elapsed_ms").copied(), Some("u64"));

    let stopped = event_with_message(&events, "runner stopped");
    assert!(stopped.fields.contains_key("total_teardown_ms"));
    assert_eq!(
        stopped.field_kinds.get("total_teardown_ms").copied(),
        Some("u64")
    );
}
