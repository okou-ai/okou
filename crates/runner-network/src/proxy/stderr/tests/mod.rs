use super::*;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

fn capture_mitmdump_stderr_log(line: &str) -> CapturedEvent {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        log_mitmdump_stderr_line(line);
    });
    let events = captured.entries();
    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    events[0].clone()
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}

fn emitted_log(event: &CapturedEvent) -> Value {
    let encoded = event
        .fields
        .get("message")
        .unwrap_or_else(|| panic!("missing message; event={event:#?}"));
    serde_json::from_str(encoded).expect("emitted log should be valid JSON")
}

#[test]
fn parses_versioned_error_event() {
    let event = parse_addon_process_event(
            r#"VM0_ADDON_EVENT {"version":1,"level":"error","message":"Failed to write pending count","type":"usage_underbilling","reason":"pending_snapshot_write_failed","underbilling_class":"risk","retry_count":2,"retryable":true,"diagnostic":{"phase":"flush"},"future.field-name":["value",3]}"#,
        )
        .unwrap();

    assert_eq!(event.level, AddonProcessEventLevel::Error);
    assert_eq!(
        Value::Object(event.fields),
        serde_json::json!({
            "level": "error",
            "message": "Failed to write pending count",
            "type": "usage_underbilling",
            "reason": "pending_snapshot_write_failed",
            "underbilling_class": "risk",
            "retry_count": 2,
            "retryable": true,
            "diagnostic": {"phase": "flush"},
            "future.field-name": ["value", 3],
        })
    );
}

#[test]
fn parses_versioned_warn_event() {
    let event = parse_addon_process_event(
        r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"write failed"}"#,
    )
    .unwrap();

    assert_eq!(event.level, AddonProcessEventLevel::Warn);
    assert_eq!(event.fields["message"], serde_json::json!("write failed"));
}

#[test]
fn rejects_unowned_or_invalid_envelopes() {
    for line in [
        "ordinary mitmdump warning",
        r#"prefix VM0_ADDON_EVENT {"version":1}"#,
        r#"VM0_ADDON_EVENT {"version":2,"level":"warn","message":"failed"}"#,
        r#"VM0_ADDON_EVENT {"version":1,"level":"info","message":"failed"}"#,
        r#"VM0_ADDON_EVENT {"version":1,"level":"warn"}"#,
        r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":42}"#,
        &format!(
            "VM0_ADDON_EVENT {{\"version\":1,\"level\":\"warn\",\"message\":\"{}\"}}",
            "x".repeat(MAX_ADDON_PROCESS_EVENT_BYTES)
        ),
    ] {
        assert!(
            parse_addon_process_event(line).is_none(),
            "unexpectedly parsed: {line}"
        );
    }
}

#[test]
fn reemits_addon_error_with_opaque_log_record() {
    let message = "Failed to write pending count";
    let event = capture_mitmdump_stderr_log(
        r#"VM0_ADDON_EVENT {"version":1,"level":"error","message":"Failed to write pending count","type":"usage_underbilling","reason":"pending_snapshot_write_failed","underbilling_class":"risk","retry_count":2,"retryable":true,"diagnostic":{"phase":"flush"},"future.field-name":["value",3]}"#,
    );

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        emitted_log(&event),
        serde_json::json!({
            "level": "error",
            "message": message,
            "type": "usage_underbilling",
            "reason": "pending_snapshot_write_failed",
            "underbilling_class": "risk",
            "retry_count": 2,
            "retryable": true,
            "diagnostic": {"phase": "flush"},
            "future.field-name": ["value", 3],
        })
    );
    assert_eq!(event.fields.len(), 1, "unexpected fields: {event:#?}");
}

#[test]
fn reemits_addon_warning_with_opaque_log_record() {
    let event = capture_mitmdump_stderr_log(
        r#"VM0_ADDON_EVENT {"version":1,"level":"warn","message":"write failed"}"#,
    );

    assert_eq!(event.level, Level::WARN);
    assert_eq!(
        emitted_log(&event),
        serde_json::json!({"level": "warn", "message": "write failed"})
    );
    assert_eq!(event.fields.len(), 1, "unexpected fields: {event:#?}");
}

#[test]
fn malformed_envelope_uses_ordinary_stderr_path() {
    let line = "VM0_ADDON_EVENT not-json";
    let event = capture_mitmdump_stderr_log(line);

    assert_eq!(event.level, Level::WARN);
    assert_event_field(&event, "message", &format!("stderr: {line}"));
    assert!(!event.fields.contains_key("type"));
}

#[test]
fn malformed_envelope_with_certificate_deprecation_remains_warning() {
    let line = format!(
        "{ADDON_PROCESS_EVENT_PREFIX}OpenSSL/crypto.py:984: \
             {NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION}"
    );

    let event = capture_mitmdump_stderr_log(&line);

    assert_eq!(event.level, Level::WARN);
    assert_event_field(&event, "message", &format!("stderr: {line}"));
}

#[test]
fn non_positive_peer_certificate_serial_deprecation_reemits_structured_info() {
    for source in ["OpenSSL/crypto.py:1231", "OpenSSL/crypto.py:984"] {
        let line = format!("{source}: {NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION}");

        let event = capture_mitmdump_stderr_log(&line);

        assert_eq!(event.level, Level::INFO);
        assert_event_field(
            &event,
            "message",
            "mitmdump peer certificate serial deprecation",
        );
        assert_event_field(
            &event,
            "reason",
            "non_positive_peer_certificate_serial_deprecation",
        );
        assert_event_field(&event, "mitmdump_stderr", &line);
    }
}

#[test]
fn related_certificate_stderr_remains_warning() {
    let lines = [
        NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION.replacen(
            "CryptographyDeprecationWarning",
            "UserWarning",
            1,
        ),
        NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION
            .strip_suffix('.')
            .unwrap()
            .to_owned(),
        "ValueError: Failed to parse peer certificate serial number".to_owned(),
    ];

    for warning in lines {
        let line = format!("OpenSSL/crypto.py:984: {warning}");

        let event = capture_mitmdump_stderr_log(&line);

        assert_eq!(event.level, Level::WARN);
        assert_event_field(&event, "message", &format!("stderr: {line}"));
    }
}

#[test]
fn certificate_deprecation_without_source_remains_warning() {
    let line = format!(": {NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION}");

    let event = capture_mitmdump_stderr_log(&line);

    assert_eq!(event.level, Level::WARN);
    assert_event_field(&event, "message", &format!("stderr: {line}"));
}

#[test]
fn ordinary_mitmdump_stderr_remains_warning() {
    let line = "ordinary mitmdump warning";

    let event = capture_mitmdump_stderr_log(line);

    assert_eq!(event.level, Level::WARN);
    assert_event_field(&event, "message", "stderr: ordinary mitmdump warning");
}
