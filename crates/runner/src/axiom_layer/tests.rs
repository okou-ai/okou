//! Tests for the Axiom tracing layer.
//!
//! The layer + its dispatcher run for real; only the network boundary is
//! mocked (`httpmock` stands in for `https://api.axiom.co`). Tests verify
//! that events flow through the layer → channel → dispatcher → POST
//! endpoint with the TS-compatible payload shape.
//!

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use super::{
    ADDON_LOG_TARGET, AxiomGuard, AxiomLayer, BATCH_INTERVAL, BATCH_SIZE, CHANNEL_CAP,
    ERROR_SOURCE_MAX_DEPTH, FLUSH_DEADLINE, INTERNAL_TARGET, Msg, TEXT_FIELD_MAX_BYTES,
    TRUNCATION_MARKER, init_from_env_values, init_with_base_url, init_with_base_url_and_hostname,
    with_ingest_filter,
};
use httpmock::Method::POST;
use httpmock::MockServer;
use httpmock::{HttpMockRequest, HttpMockResponse, Mock};
use serde_json::{Value, json};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

#[derive(Clone, Debug)]
struct RecordedEvent {
    level: tracing::Level,
    target: String,
    message: Option<String>,
}

#[derive(Clone, Default)]
struct RecordingLayer {
    events: Arc<Mutex<Vec<RecordedEvent>>>,
}

struct FormattingProbe<'a>(&'a AtomicUsize);

impl std::fmt::Debug for FormattingProbe<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fetch_add(1, Ordering::Relaxed);
        formatter.write_str("formatted")
    }
}

impl RecordingLayer {
    fn events(&self) -> Vec<RecordedEvent> {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl<S> Layer<S> for RecordingLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        struct MessageVisitor {
            message: Option<String>,
        }

        impl Visit for MessageVisitor {
            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = Some(value.to_string());
                }
            }

            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.message = Some(format!("{value:?}"));
                }
            }
        }

        let mut visitor = MessageVisitor { message: None };
        event.record(&mut visitor);

        let metadata = event.metadata();
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(RecordedEvent {
                level: *metadata.level(),
                target: metadata.target().to_string(),
                message: visitor.message,
            });
    }
}

#[derive(Clone, Default)]
struct CapturedAxiomIngest {
    bodies: Arc<Mutex<Vec<Vec<u8>>>>,
    request_received: Arc<tokio::sync::Notify>,
}

impl CapturedAxiomIngest {
    fn push_body(&self, body: &[u8]) {
        self.bodies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(body.to_vec());
        self.request_received.notify_one();
    }

    fn requests(&self) -> Vec<Vec<Value>> {
        let bodies = self
            .bodies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();

        bodies
            .into_iter()
            .map(|body| {
                let value: Value = serde_json::from_slice(&body).unwrap_or_else(|err| {
                    panic!(
                        "captured Axiom ingest body should be valid JSON: {err}; body: {}",
                        String::from_utf8_lossy(&body),
                    );
                });
                let Value::Array(events) = value else {
                    panic!("captured Axiom ingest body should be a JSON array, got: {value}");
                };
                events
            })
            .collect()
    }

    fn events(&self) -> Vec<Value> {
        self.requests().into_iter().flatten().collect()
    }

    fn request_count(&self) -> usize {
        self.bodies.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    async fn wait_for_request(&self) {
        const REQUEST_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

        tokio::time::timeout(REQUEST_WAIT_TIMEOUT, async {
            loop {
                let request_received = self.request_received.notified();
                if self.request_count() > 0 {
                    return;
                }
                request_received.await;
            }
        })
        .await
        .expect("timed out waiting for an Axiom ingest request");
    }
}

async fn capture_axiom_ingest<'a>(server: &'a MockServer) -> (Mock<'a>, CapturedAxiomIngest) {
    let captured = CapturedAxiomIngest::default();
    let responder_capture = captured.clone();
    let mock = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.respond_with(move |request: &HttpMockRequest| {
                responder_capture.push_body(request.body_ref());
                HttpMockResponse::builder().status(200).body("{}").build()
            });
        })
        .await;

    (mock, captured)
}

fn event_with_message<'a>(events: &'a [Value], message: &str) -> &'a Value {
    events
        .iter()
        .find(|event| event.get("message").and_then(Value::as_str) == Some(message))
        .unwrap_or_else(|| panic!("expected event with message {message:?}, got: {events:#?}"))
}

fn has_event_with_message(events: &[Value], message: &str) -> bool {
    events
        .iter()
        .any(|event| event.get("message").and_then(Value::as_str) == Some(message))
}

fn string_field<'a>(event: &'a Value, field: &str) -> &'a str {
    event
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected string field {field:?} in event: {event:#?}"))
}

fn json_contains_string(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(value) => value.contains(needle),
        Value::Array(values) => values
            .iter()
            .any(|value| json_contains_string(value, needle)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(needle) || json_contains_string(value, needle)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn event_markers(events: &[Value]) -> Vec<u64> {
    events
        .iter()
        .map(|event| {
            event
                .get("marker")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| panic!("expected numeric marker in Axiom event: {event:#?}"))
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn batch_size_flushes_before_shutdown_and_residual_flushes_once() {
    const RESIDUAL_SIZE: usize = 3;

    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    let _sub = tracing::subscriber::set_default(subscriber);

    // Consume `interval()`'s immediately ready first tick while the batch is
    // empty so it cannot split the exact-size batch below. With paused time,
    // the runtime polls work ready now before advancing to this sleep's
    // deadline, making the dispatcher poll a causal prerequisite.
    tokio::time::sleep(Duration::from_nanos(1)).await;
    for marker in 0..BATCH_SIZE {
        tracing::warn!(marker = marker as u64, "batch event");
    }

    // Use real time only for the bounded HTTP observation. The deadline is
    // shorter than BATCH_INTERVAL, so a later timer tick cannot hide a broken
    // exact-threshold comparison.
    tokio::time::resume();
    captured.wait_for_request().await;

    let requests = captured.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].len(), BATCH_SIZE);
    assert_eq!(
        event_markers(&requests[0]),
        (0..BATCH_SIZE)
            .map(|marker| marker as u64)
            .collect::<Vec<_>>(),
    );

    for marker in BATCH_SIZE..BATCH_SIZE + RESIDUAL_SIZE {
        tracing::warn!(marker = marker as u64, "batch event");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(2).await;
    let requests = captured.requests();
    assert_eq!(
        requests.iter().map(Vec::len).collect::<Vec<_>>(),
        [BATCH_SIZE, RESIDUAL_SIZE],
    );
    assert_eq!(
        event_markers(&requests.concat()),
        (0..BATCH_SIZE + RESIDUAL_SIZE)
            .map(|marker| marker as u64)
            .collect::<Vec<_>>(),
    );
}

#[tokio::test(start_paused = true)]
async fn sub_threshold_batch_flushes_on_interval_before_shutdown() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    let _sub = tracing::subscriber::set_default(subscriber);

    // Each paused-time sleep makes the runtime poll work ready at the current
    // instant before advancing one nanosecond, so the empty tick and channel
    // receive both complete before the test continues.
    tokio::time::sleep(Duration::from_nanos(1)).await;
    tracing::warn!(marker = 7_u64, "interval event");
    tokio::time::sleep(Duration::from_nanos(1)).await;
    assert_eq!(captured.request_count(), 0);

    tokio::time::advance(BATCH_INTERVAL).await;
    tokio::time::resume();
    captured.wait_for_request().await;

    let requests = captured.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(event_markers(&requests[0]), [7]);

    guard.shutdown().await;
    ingest.assert_calls_async(1).await;
    assert_eq!(captured.request_count(), 1);
}

#[tokio::test]
async fn warn_and_error_events_are_ingested_with_ts_shape() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    // Use the internal `init_with_base_url` to redirect at the mock server.
    // `init()` always targets api.axiom.co and can't be pointed elsewhere.
    let (layer, guard) = init_with_base_url(&server.base_url(), "test-token", "test")
        .expect("init_with_base_url must succeed");

    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::warn!(foo = "bar", "a warning");
        tracing::error!(code = 42, "a failure");
        tracing::info!("info is below threshold, should not be ingested");
    }

    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let warning = event_with_message(&events, "a warning");
    assert_eq!(warning["service"], json!("runner"));
    assert_eq!(warning["runner_version"], json!(env!("CARGO_PKG_VERSION")));
    assert!(warning.get("runner_hostname").is_none());
    assert_eq!(warning["level"], json!("warn"));
    assert_eq!(warning["foo"], json!("bar"));
    assert!(
        !string_field(warning, "context").is_empty(),
        "warning event should include context: {warning:#?}",
    );

    let failure = event_with_message(&events, "a failure");
    assert_eq!(failure["service"], json!("runner"));
    assert_eq!(failure["level"], json!("error"));
    assert_eq!(failure["code"], json!(42));
    assert!(
        !has_event_with_message(&events, "info is below threshold, should not be ingested"),
        "INFO event should not be ingested: {events:#?}",
    );
}

#[tokio::test]
async fn addon_log_fields_are_passed_through_without_an_intermediate_field() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let (layer, guard) = init_with_base_url_and_hostname(
        &server.base_url(),
        "test-token",
        "test",
        Some("runner-host-1".to_string()),
    )
    .expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    let addon_log = serde_json::json!({
        "level": "error",
        "message": "Failed to write pending count",
        "type": "usage_underbilling",
        "reason": "pending_snapshot_write_failed",
        "underbilling_class": "risk",
        "retry_count": 2,
        "retryable": true,
        "diagnostic": {"phase": "flush"},
        "future.field-name": ["value", 3],
        "context": "addon-owned-context",
        "service": "addon-owned-service",
        "runner_hostname": "addon-owned-host",
        "runner_version": "addon-owned-version",
    })
    .to_string();

    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!(
            target: ADDON_LOG_TARGET,
            message = addon_log.as_str(),
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "Failed to write pending count");
    assert_eq!(event["level"], json!("error"));
    assert_eq!(event["type"], json!("usage_underbilling"));
    assert_eq!(event["reason"], json!("pending_snapshot_write_failed"));
    assert_eq!(event["underbilling_class"], json!("risk"));
    assert_eq!(event["retry_count"], json!(2));
    assert_eq!(event["retryable"], json!(true));
    assert_eq!(event["diagnostic"], json!({"phase": "flush"}));
    assert_eq!(event["future.field-name"], json!(["value", 3]));
    assert_eq!(event["context"], json!(ADDON_LOG_TARGET));
    assert_eq!(event["service"], json!("runner"));
    assert_eq!(event["runner_hostname"], json!("runner-host-1"));
    assert_eq!(event["runner_version"], json!(env!("CARGO_PKG_VERSION")));
    assert!(event.get("version").is_none());
    assert!(event.get("addon_log").is_none());
}

#[tokio::test]
async fn configured_hostname_and_version_are_common_axiom_dimensions() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let (layer, guard) = init_with_base_url_and_hostname(
        &server.base_url(),
        "test-token",
        "test",
        Some("prod-1.aws.vm3.ai".to_string()),
    )
    .expect("init must succeed");

    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::warn!(
            runner_hostname = "event-local-host",
            runner_version = "event-local-version",
            "attributed warning"
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let warning = event_with_message(&events, "attributed warning");
    assert_eq!(warning["runner_hostname"], json!("prod-1.aws.vm3.ai"));
    assert_eq!(warning["runner_version"], json!(env!("CARGO_PKG_VERSION")));
}

#[tokio::test]
async fn oversized_string_field_is_bounded_before_ingest() {
    const SENTINEL_PAST_CAP: &str = "STRING_SENTINEL_PAST_CAP";

    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        let mut oversized = "A".repeat(TEXT_FIELD_MAX_BYTES + 1_000);
        oversized.push_str(SENTINEL_PAST_CAP);
        tracing::warn!(oversized = oversized.as_str(), "bounded string");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "bounded string");
    let retained = string_field(event, "oversized");
    assert_eq!(
        retained.len(),
        TEXT_FIELD_MAX_BYTES + TRUNCATION_MARKER.len(),
    );
    assert!(retained.ends_with(TRUNCATION_MARKER));
    assert!(
        !retained.contains(SENTINEL_PAST_CAP),
        "far-past-cap string content reached ingest: {retained:?}",
    );
}

#[tokio::test]
async fn helper_failure_keeps_a_bounded_redacted_causal_tail_at_ingest() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    let stderr = format!(
        "{}\nHTTP status 403 s3_code=ExpiredRequest\nhttps://storage.example/archive.tar.gz?X-Amz-Signature=private-signature",
        "download progress 中\n".repeat(1000),
    );
    let result = sandbox::ExecResult {
        termination: sandbox::ExecTermination::Exited { exit_code: 1 },
        guest_duration_ms: None,
        stdout: Vec::new(),
        stderr: stderr.into_bytes(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    };
    let error = crate::helper_exec::format_helper_exec_failure("storage download", &result);
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!(
            error = %error,
            error_tail = super::error_tail(&error),
            "helper failure",
        );
        tracing::error!(
            error = "short failure",
            error_tail = super::error_tail("short failure"),
            "short helper failure",
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let failure = event_with_message(&events, "helper failure");
    let prefix = string_field(failure, "error");
    assert!(prefix.starts_with("storage download failed (exit code 1)"));
    assert!(prefix.ends_with(TRUNCATION_MARKER));
    assert!(!prefix.contains("s3_code=ExpiredRequest"));
    let tail = string_field(failure, "error_tail");
    assert!(tail.len() <= TEXT_FIELD_MAX_BYTES);
    assert!(tail.contains("HTTP status 403 s3_code=ExpiredRequest"));
    assert!(!json_contains_string(failure, "private-signature"));
    assert!(!json_contains_string(failure, "X-Amz-Signature"));
    assert!(
        event_with_message(&events, "short helper failure")
            .get("error_tail")
            .is_none()
    );
}

#[tokio::test]
async fn axiom_ingests_only_scoped_storage_latency_info() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let (layer, guard) = init_with_base_url(&server.base_url(), "t", "test").unwrap();
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::info!(
            target: "guest_control_client::exec_operation::diagnostics",
            storage_download_latency = true,
            label = "storage-download",
            terminal_reason = "slow",
            elapsed_ms = 5227_u64,
            guest_duration_ms = 5226_u64,
            "exec operation terminal result",
        );
        tracing::info!(target: "guest_control_client::exec_operation::diagnostics", "other terminal info");
        tracing::info!(storage_download_latency = true, "unrelated target");
        tracing::event!(target: "guest_control_client::exec_operation::diagnostics", tracing::Level::DEBUG, storage_download_latency = true, "debug latency");
        tracing::warn!(target: "guest_control_client::exec_operation::diagnostics", label = "storage-download", terminal_reason = "notable", "storage failure");
    }
    guard.shutdown().await;
    ingest.assert_calls_async(1).await;
    let events = captured.events();
    assert_eq!(events.len(), 2, "events={events:#?}");
    let latency = event_with_message(&events, "exec operation terminal result");
    assert_eq!(latency["level"], "info");
    assert_eq!(
        latency["context"],
        "guest_control_client::exec_operation::diagnostics"
    );
    assert_eq!(latency["label"], "storage-download");
    assert_eq!(latency["terminal_reason"], "slow");
    assert_eq!(latency["elapsed_ms"], 5227);
    assert_eq!(latency["guest_duration_ms"], 5226);
    assert_eq!(
        event_with_message(&events, "storage failure")["level"],
        "warn"
    );
}

#[tokio::test]
async fn axiom_filter_does_not_suppress_sibling_local_layers() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let recording = RecordingLayer::default();
    let subscriber = tracing_subscriber::registry()
        .with(recording.clone())
        .with(with_ingest_filter(layer));

    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::info!("local info");
        tracing::event!(tracing::Level::DEBUG, "local debug");
        tracing::event!(tracing::Level::TRACE, "local trace");
        tracing::warn!("local warn");
        tracing::warn!(target: INTERNAL_TARGET, dropped = 1_u64, "axiom channel full");
    }
    guard.shutdown().await;

    let events = recording.events();
    for (level, message) in [
        (tracing::Level::INFO, "local info"),
        (tracing::Level::DEBUG, "local debug"),
        (tracing::Level::TRACE, "local trace"),
        (tracing::Level::WARN, "local warn"),
    ] {
        assert!(
            events.iter().any(|event| {
                event.level == level
                    && event
                        .message
                        .as_deref()
                        .is_some_and(|seen| seen.contains(message))
            }),
            "sibling local layer did not record {level} event {message:?}: {events:?}",
        );
    }
    assert!(
        events.iter().any(|event| {
            event.target == INTERNAL_TARGET
                && event
                    .message
                    .as_deref()
                    .is_some_and(|seen| seen.contains("axiom channel full"))
        }),
        "sibling local layer did not record internal-target event: {events:?}",
    );

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let warning = event_with_message(&events, "local warn");
    assert_eq!(warning["level"], json!("warn"));
    for message in [
        "local info",
        "local debug",
        "local trace",
        "axiom channel full",
    ] {
        assert!(
            !has_event_with_message(&events, message),
            "filtered event {message:?} should not be ingested: {events:#?}",
        );
    }
}

#[test]
fn init_returns_none_when_env_missing() {
    let result = init_from_env_values("https://example.invalid", None, None, None);
    assert!(result.is_none());
}

#[test]
fn init_returns_none_when_token_empty() {
    let result = init_from_env_values(
        "https://example.invalid",
        Some(String::new()),
        Some("dev".to_string()),
        None,
    );
    assert!(result.is_none());
}

/// Error type with a walkable `source()` chain. Lets us exercise the
/// `record_error` visitor without pulling in extra deps.
#[derive(Debug)]
struct ChainErr {
    msg: String,
    src: Option<Box<ChainErr>>,
}

impl std::fmt::Display for ChainErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for ChainErr {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.src.as_deref().map(|e| e as &dyn std::error::Error)
    }
}

#[tokio::test]
async fn error_field_serializes_with_message_and_source_chain() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        let err = ChainErr {
            msg: "top".into(),
            src: Some(Box::new(ChainErr {
                msg: "middle".into(),
                src: Some(Box::new(ChainErr {
                    msg: "root".into(),
                    src: None,
                })),
            })),
        };
        tracing::error!(
            error = &err as &(dyn std::error::Error + 'static),
            "explosion",
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "explosion");
    assert_eq!(event["error"]["message"], json!("top"));
    assert_eq!(event["error"]["chain"], json!(["middle", "root"]));
}

#[tokio::test]
async fn oversized_deep_error_is_bounded_independently_of_input_size() {
    const SENTINEL_PAST_CAP: &str = "ERROR_SENTINEL_PAST_CAP";

    fn oversized_message(label: &str, input_bytes: usize) -> String {
        let mut message = format!("{label}:");
        message.push_str(&"A".repeat(input_bytes));
        message.push_str(SENTINEL_PAST_CAP);
        message
    }

    fn oversized_chain(input_bytes: usize) -> ChainErr {
        let mut source = None;
        for index in (0..ERROR_SOURCE_MAX_DEPTH + 2).rev() {
            source = Some(Box::new(ChainErr {
                msg: oversized_message(&format!("source-{index}"), input_bytes),
                src: source,
            }));
        }
        ChainErr {
            msg: oversized_message("top", input_bytes),
            src: source,
        }
    }

    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        for input_bytes in [TEXT_FIELD_MAX_BYTES * 2, TEXT_FIELD_MAX_BYTES * 20] {
            let err = oversized_chain(input_bytes);
            tracing::error!(
                error = &err as &(dyn std::error::Error + 'static),
                "bounded error",
            );
        }
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    assert_eq!(events.len(), 2);

    let mut serialized_event_bytes = Vec::new();
    for event in &events {
        let error = &event["error"];
        let message = string_field(error, "message");
        assert!(message.starts_with("top:"));
        assert!(message.ends_with(TRUNCATION_MARKER));
        assert_eq!(
            message.len(),
            TEXT_FIELD_MAX_BYTES + TRUNCATION_MARKER.len(),
        );

        let chain = error["chain"]
            .as_array()
            .unwrap_or_else(|| panic!("expected bounded error chain: {event:#?}"));
        assert_eq!(chain.len(), ERROR_SOURCE_MAX_DEPTH + 1);
        for (index, source) in chain[..ERROR_SOURCE_MAX_DEPTH].iter().enumerate() {
            let source = source
                .as_str()
                .unwrap_or_else(|| panic!("expected string source in chain: {event:#?}"));
            assert!(source.starts_with(&format!("source-{index}:")));
            assert!(source.ends_with(TRUNCATION_MARKER));
            assert_eq!(source.len(), TEXT_FIELD_MAX_BYTES + TRUNCATION_MARKER.len(),);
        }
        assert_eq!(
            chain[ERROR_SOURCE_MAX_DEPTH].as_str(),
            Some(TRUNCATION_MARKER),
        );
        assert!(
            !json_contains_string(event, SENTINEL_PAST_CAP),
            "far-past-cap error content reached ingest: {event:#?}",
        );

        let retained_error_text_bytes = message.len()
            + chain
                .iter()
                .map(|source| {
                    source
                        .as_str()
                        .expect("error chain values are strings")
                        .len()
                })
                .sum::<usize>();
        assert_eq!(
            retained_error_text_bytes,
            (ERROR_SOURCE_MAX_DEPTH + 1) * (TEXT_FIELD_MAX_BYTES + TRUNCATION_MARKER.len())
                + TRUNCATION_MARKER.len(),
        );
        serialized_event_bytes.push(
            serde_json::to_vec(event)
                .expect("captured Axiom event should serialize")
                .len(),
        );
    }
    assert_eq!(
        serialized_event_bytes[0], serialized_event_bytes[1],
        "serialized event size should not grow with the original error text",
    );
}

#[tokio::test]
async fn u128_fields_serialize_as_numbers_when_in_u64_range() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!(
            timeout_ms = 7_200_000_u128,
            elapsed_ms = 7_200_100_u128,
            guest_duration_ms = Some(7_200_084_u32),
            "timeout fields"
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "timeout fields");
    assert_eq!(event["timeout_ms"].as_u64(), Some(7_200_000));
    assert_eq!(event["elapsed_ms"].as_u64(), Some(7_200_100));
    assert_eq!(event["guest_duration_ms"].as_u64(), Some(7_200_084));
}

#[tokio::test]
async fn none_option_fields_are_omitted_from_axiom_payload() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!(
            timeout_ms = 7_200_000_u128,
            guest_duration_ms = None::<u32>,
            "timeout without guest duration"
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "timeout without guest duration");
    assert_eq!(event["timeout_ms"].as_u64(), Some(7_200_000));
    assert!(
        event.get("guest_duration_ms").is_none(),
        "None option field should be omitted: {event:#?}",
    );
    assert!(
        !events
            .iter()
            .any(|event| json_contains_string(event, "None")),
        "None debug text should not be serialized into ingest payloads: {events:#?}",
    );
}

#[test]
fn burst_past_channel_cap_drops_without_blocking() {
    let (tx, receiver) = tokio::sync::mpsc::channel(CHANNEL_CAP);
    let layer = AxiomLayer {
        tx,
        dropped: AtomicU64::new(0),
        runner_hostname: None,
    };
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    let dispatch = tracing::Dispatch::new(subscriber);

    // Holding the receiver without polling it makes channel saturation
    // independent of runtime scheduling. The 1001 excess events exercise
    // both periodic drop-diagnostic thresholds (drops #1 and #1001).
    const EMIT: usize = CHANNEL_CAP + 1001;
    const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(5);
    let (completed_tx, completed_rx) = mpsc::channel();
    let producer = thread::spawn(move || {
        tracing::dispatcher::with_default(&dispatch, || {
            for i in 0..EMIT {
                tracing::warn!(i, "burst");
            }
        });
        completed_tx.send(()).expect("report producer completion");
    });

    completed_rx
        .recv_timeout(WATCHDOG_TIMEOUT)
        .expect("producer blocked on the full Axiom channel");
    producer.join().expect("producer thread panicked");

    assert_eq!(
        receiver.len(),
        CHANNEL_CAP,
        "the bounded channel must drop every event beyond its capacity",
    );
}

#[tokio::test(start_paused = true)]
async fn shutdown_deadline_bounds_blocked_close_send() {
    let (tx, mut receiver) = tokio::sync::mpsc::channel(1);
    assert!(tx.send(Msg::Event(json!({}))).await.is_ok());
    let guard = AxiomGuard { tx, handle: None };
    let started_at = tokio::time::Instant::now();
    let shutdown = guard.shutdown();
    tokio::pin!(shutdown);

    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    tokio::time::advance(FLUSH_DEADLINE - Duration::from_nanos(1)).await;
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    tokio::time::advance(Duration::from_nanos(1)).await;
    assert!(futures_util::poll!(shutdown.as_mut()).is_ready());

    assert_eq!(started_at.elapsed(), FLUSH_DEADLINE);
    assert!(matches!(receiver.try_recv(), Ok(Msg::Event(_))));
}

#[tokio::test(start_paused = true)]
async fn shutdown_deadline_bounds_blocked_dispatcher_join() {
    let (tx, mut receiver) = tokio::sync::mpsc::channel(1);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let dispatcher_task = tokio::spawn(async move {
        release_rx.await.expect("release blocked dispatcher task");
        finished_tx
            .send(())
            .expect("report blocked dispatcher task completion");
    });
    let guard = AxiomGuard {
        tx,
        handle: Some(dispatcher_task),
    };
    let started_at = tokio::time::Instant::now();
    let shutdown = guard.shutdown();
    tokio::pin!(shutdown);

    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    assert!(matches!(receiver.try_recv(), Ok(Msg::Close)));
    tokio::time::advance(FLUSH_DEADLINE - Duration::from_nanos(1)).await;
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    tokio::time::advance(Duration::from_nanos(1)).await;
    assert!(futures_util::poll!(shutdown.as_mut()).is_ready());

    assert_eq!(started_at.elapsed(), FLUSH_DEADLINE);
    release_tx
        .send(())
        .expect("release detached dispatcher task after deadline");
    finished_rx
        .await
        .expect("blocked dispatcher task must finish before test exit");
}

#[test]
fn rejected_events_are_not_serialized() {
    let (tx, receiver) = tokio::sync::mpsc::channel(1);
    assert!(tx.try_send(Msg::Event(json!({}))).is_ok());

    let layer = AxiomLayer {
        tx,
        dropped: AtomicU64::new(0),
        runner_hostname: None,
    };
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    let formatting_count = AtomicUsize::new(0);

    let _sub = tracing::subscriber::set_default(subscriber);
    tracing::warn!(probe = ?FormattingProbe(&formatting_count), "full channel");
    assert_eq!(formatting_count.load(Ordering::Relaxed), 0);

    drop(receiver);
    tracing::warn!(probe = ?FormattingProbe(&formatting_count), "closed channel");
    assert_eq!(formatting_count.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn non_success_ingest_response_does_not_hang_shutdown_or_panic() {
    const TEST_SHUTDOWN_DEADLINE: Duration = Duration::from_secs(5);

    let server = MockServer::start_async().await;

    // Return 500 for every ingest. The dispatcher should log via
    // INTERNAL_TARGET and drop the batch without panicking; shutdown must
    // still complete well within FLUSH_DEADLINE.
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.status(500).body("boom");
        })
        .await;

    let (layer, mut guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let dispatcher_task = guard
        .handle
        .take()
        .expect("init must spawn a dispatcher task");
    let recording = RecordingLayer::default();
    let subscriber = tracing_subscriber::registry()
        .with(recording.clone())
        .with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!("trigger ingest failure");
        tokio::time::timeout(TEST_SHUTDOWN_DEADLINE, async {
            guard.shutdown().await;
            dispatcher_task
                .await
                .expect("Axiom dispatcher task failed during shutdown");
        })
        .await
        .expect("Axiom shutdown exceeded the 5-second test deadline");
    }

    mock.assert_calls_async(1).await;
    let events = recording.events();
    assert!(
        events.iter().any(|event| {
            event.target == INTERNAL_TARGET
                && event
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("axiom ingest returned non-success"))
        }),
        "sibling local layer did not record Axiom internal diagnostic: {events:?}",
    );
}

// -- Debug field truncation (TEXT_FIELD_MAX_BYTES = 4 KiB) -------------------

#[tokio::test]
async fn debug_field_formatting_stops_after_reaching_limit() {
    const CHUNK_BYTES: usize = 8;
    const TOTAL_CHUNKS: usize = 10_000;

    struct IncrementalDebug<'a>(&'a AtomicUsize);

    impl std::fmt::Debug for IncrementalDebug<'_> {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            for _ in 0..TOTAL_CHUNKS {
                self.0.fetch_add(1, Ordering::Relaxed);
                formatter.write_str("12345678")?;
            }
            Ok(())
        }
    }

    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;
    let formatted_chunks = AtomicUsize::new(0);

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::warn!(
            value = ?IncrementalDebug(&formatted_chunks),
            "bounded-formatting",
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "bounded-formatting");
    assert!(
        string_field(event, "value").contains("…[truncated]"),
        "oversized incrementally formatted field should include the truncation marker: {event:#?}",
    );
    assert_eq!(
        formatted_chunks.load(Ordering::Relaxed),
        TEXT_FIELD_MAX_BYTES / CHUNK_BYTES + 1,
        "formatting should stop on the first chunk beyond the byte limit instead of visiting all {TOTAL_CHUNKS} chunks",
    );
}

#[tokio::test]
async fn debug_field_over_limit_is_truncated_with_marker() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // 5000 A's → sentinel → 3000 A's. Debug form: `"` + 5000 + sentinel
        // (17 bytes) + 3000 + `"` = 8019 bytes. The sentinel starts at
        // Debug-form byte 5001, well past the 4 KiB cap, so correct
        // truncation must drop it.
        let mut big = "A".repeat(5000);
        big.push_str("SENTINEL_PAST_CAP");
        big.push_str(&"A".repeat(3000));
        tracing::warn!(big = ?big, "truncate-me");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "truncate-me");
    let big = string_field(event, "big");
    assert!(
        big.contains("…[truncated]"),
        "oversized debug field should include truncation marker: {big:?}",
    );
    // Negative: content past the 4 KiB cap MUST be dropped. If the
    // `s.truncate(cut)` line is ever removed while the marker append stays,
    // the marker assertion alone still passes — this assertion catches that.
    assert!(
        !big.contains("SENTINEL_PAST_CAP"),
        "far-past-cap sentinel should not reach ingest: {big:?}",
    );
}

#[tokio::test]
async fn debug_field_truncation_walks_to_utf8_char_boundary() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // 2500 × 2-byte `ñ` = 5000 bytes; Debug adds surrounding quotes →
        // 5002 bytes. Byte 4096 of the Debug form falls mid-`ñ`, so the
        // truncation code MUST walk backward to a char boundary — without
        // that walk, `s.truncate(4096)` panics and this test fails.
        let big: String = "ñ".repeat(2500);
        tracing::warn!(big = ?big, "utf8-boundary");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "utf8-boundary");
    assert!(
        string_field(event, "big").contains("…[truncated]"),
        "oversized UTF-8 debug field should include truncation marker: {event:#?}",
    );
}

#[tokio::test]
async fn debug_field_at_exact_limit_passes_through_unmodified() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // Debug form of a &str is `"<contents>"` — surrounding quotes cost
        // 2 bytes, so 4094 content bytes yields exactly TEXT_FIELD_MAX_BYTES.
        // The truncation check is `s.len() > MAX`, which is FALSE at equality
        // → value must pass through unmodified. Ending with a sentinel lets
        // the positive mock verify the full body arrived, not just the
        // message field.
        let mut payload = "A".repeat(4094 - "SENTINEL_AT_END".len());
        payload.push_str("SENTINEL_AT_END");
        tracing::warn!(val = ?payload, "at-limit");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "at-limit");
    let val = string_field(event, "val");
    assert!(
        val.contains("SENTINEL_AT_END"),
        "exact-limit debug field should pass through unmodified: {val:?}",
    );
    assert!(
        !val.contains("…[truncated]"),
        "exact-limit debug field should not include truncation marker: {val:?}",
    );
}
