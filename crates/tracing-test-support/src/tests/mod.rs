use super::*;

use tracing_subscriber::prelude::*;

#[test]
fn captures_event_level_fields_and_kinds() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    tracing::subscriber::with_default(subscriber, || {
        tracing::warn!(
            str_field = "text",
            i64_field = -2_i64,
            u64_field = 2_u64,
            i128_field = -3_i128,
            u128_field = 3_u128,
            bool_field = true,
            debug_field = ?vec!["debug"],
            "captured event"
        );
    });

    let events = captured.entries();
    assert_eq!(events.len(), 1, "captured events: {events:#?}");

    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("captured event")
    );
    assert_eq!(event.field_kinds.get("message").copied(), Some("debug"));
    assert_eq!(
        event.fields.get("str_field").map(String::as_str),
        Some("text")
    );
    assert_eq!(event.field_kinds.get("str_field").copied(), Some("str"));
    assert_eq!(
        event.fields.get("i64_field").map(String::as_str),
        Some("-2")
    );
    assert_eq!(event.field_kinds.get("i64_field").copied(), Some("i64"));
    assert_eq!(event.fields.get("u64_field").map(String::as_str), Some("2"));
    assert_eq!(event.field_kinds.get("u64_field").copied(), Some("u64"));
    assert_eq!(
        event.fields.get("i128_field").map(String::as_str),
        Some("-3")
    );
    assert_eq!(event.field_kinds.get("i128_field").copied(), Some("i128"));
    assert_eq!(
        event.fields.get("u128_field").map(String::as_str),
        Some("3")
    );
    assert_eq!(event.field_kinds.get("u128_field").copied(), Some("u128"));
    assert_eq!(
        event.fields.get("bool_field").map(String::as_str),
        Some("true")
    );
    assert_eq!(event.field_kinds.get("bool_field").copied(), Some("bool"));
    assert_eq!(
        event.fields.get("debug_field").map(String::as_str),
        Some("[\"debug\"]")
    );
    assert_eq!(event.field_kinds.get("debug_field").copied(), Some("debug"));
}

#[test]
fn clear_removes_captured_events() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    tracing::subscriber::with_default(subscriber, || {
        tracing::info!("first");
    });
    assert_eq!(captured.entries().len(), 1);

    captured.clear();

    assert!(captured.entries().is_empty());
}
