use std::fmt::Write as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use api_contracts::generated::constants::client::headers::CLIENT_REQUEST_ID_HEADER;
use httpmock::prelude::*;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt as _;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use super::test_http::{HttpClient, HttpClientConfig};

use super::*;

const SANDBOX_TOKEN: &str = "sandbox-token";

mod rejection;

fn eligible_success() -> EligibleNetworkLogUploadOutcome {
    EligibleNetworkLogUploadOutcome::Success
}

fn eligible_transport_failure() -> EligibleNetworkLogUploadOutcome {
    EligibleNetworkLogUploadOutcome::TransportFailure {
        failure: NetworkLogTransportFailure {
            kind: "timeout",
            cause: "timeout",
        },
    }
}

fn session_transport_failure() -> NetworkLogUploadSessionOutcome {
    NetworkLogUploadSessionOutcome::TransportFailure {
        failure: NetworkLogTransportFailure {
            kind: "timeout",
            cause: "timeout",
        },
    }
}

#[test]
fn upload_health_requires_both_failure_count_and_rate() {
    let now = Instant::now();

    let excluded = NetworkLogUploadHealthTracker::new();
    excluded.observe(NetworkLogUploadSessionOutcome::Excluded);
    assert!(
        excluded
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .outcomes
            .is_empty()
    );

    let too_few = NetworkLogUploadHealthTracker::new();
    assert!(
        too_few
            .record_at(now, eligible_transport_failure())
            .is_none()
    );
    assert!(
        too_few
            .record_at(now, eligible_transport_failure())
            .is_none()
    );

    let below_rate = NetworkLogUploadHealthTracker::new();
    for _ in 0..13 {
        assert!(below_rate.record_at(now, eligible_success()).is_none());
    }
    for _ in 0..3 {
        assert!(
            below_rate
                .record_at(now, eligible_transport_failure())
                .is_none()
        );
    }

    let exact_rate = NetworkLogUploadHealthTracker::new();
    for _ in 0..12 {
        assert!(exact_rate.record_at(now, eligible_success()).is_none());
    }
    for _ in 0..2 {
        assert!(
            exact_rate
                .record_at(now, eligible_transport_failure())
                .is_none()
        );
    }
    let degradation = exact_rate
        .record_at(now, eligible_transport_failure())
        .expect("three failures among fifteen sessions reaches 20 percent");
    assert_eq!(degradation.eligible_sessions, 15);
    assert_eq!(degradation.successful_sessions, 12);
    assert_eq!(degradation.transport_failures, 3);
    assert_eq!(degradation.failure_rate_basis_points, 2_000);
}

#[test]
fn upload_health_latches_resets_silently_and_allows_a_later_incident() {
    let tracker = NetworkLogUploadHealthTracker::new();
    let now = Instant::now();
    for _ in 0..12 {
        assert!(tracker.record_at(now, eligible_success()).is_none());
    }
    for _ in 0..2 {
        assert!(
            tracker
                .record_at(now, eligible_transport_failure())
                .is_none()
        );
    }
    assert!(
        tracker
            .record_at(now, eligible_transport_failure())
            .is_some()
    );
    assert!(
        tracker
            .record_at(now, eligible_transport_failure())
            .is_none()
    );

    for _ in 0..5 {
        assert!(tracker.record_at(now, eligible_success()).is_none());
    }
    assert!(
        tracker
            .record_at(now, eligible_transport_failure())
            .is_some()
    );
}

#[test]
fn upload_health_keeps_the_exact_window_boundary_then_expires() {
    let tracker = NetworkLogUploadHealthTracker::new();
    let started_at = Instant::now();
    for _ in 0..12 {
        assert!(tracker.record_at(started_at, eligible_success()).is_none());
    }
    for _ in 0..2 {
        assert!(
            tracker
                .record_at(started_at, eligible_transport_failure())
                .is_none()
        );
    }
    assert!(
        tracker
            .record_at(started_at, eligible_transport_failure())
            .is_some()
    );

    let boundary = started_at + NETWORK_LOG_UPLOAD_HEALTH_WINDOW;
    assert!(
        tracker
            .record_at(boundary, eligible_transport_failure())
            .is_none()
    );
    assert_eq!(
        tracker
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .outcomes
            .len(),
        16
    );

    let after_boundary = boundary + Duration::from_nanos(1);
    assert!(
        tracker
            .record_at(after_boundary, eligible_success())
            .is_none()
    );
    let state = tracker
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(state.outcomes.len(), 2);
    assert_eq!(state.successful_sessions, 1);
    assert_eq!(state.transport_failures, 1);
    assert!(!state.degradation_emitted);
}

#[test]
fn upload_health_reopens_incident_when_expiry_and_failure_share_observation() {
    let tracker = NetworkLogUploadHealthTracker::new();
    let started_at = Instant::now();
    assert!(
        tracker
            .record_at(started_at, eligible_transport_failure())
            .is_none()
    );
    assert!(
        tracker
            .record_at(
                started_at + Duration::from_nanos(1),
                eligible_transport_failure(),
            )
            .is_none()
    );
    assert!(
        tracker
            .record_at(
                started_at + Duration::from_nanos(2),
                eligible_transport_failure(),
            )
            .is_some()
    );

    let degradation = tracker
        .record_at(
            started_at + NETWORK_LOG_UPLOAD_HEALTH_WINDOW + Duration::from_nanos(1),
            eligible_transport_failure(),
        )
        .expect("expiry below the threshold resets before the new failure recrosses it");
    assert_eq!(degradation.eligible_sessions, 3);
    assert_eq!(degradation.transport_failures, 3);
}

#[tokio::test]
async fn upload_health_emits_one_error_for_a_concurrent_threshold_crossing() {
    let tracker = NetworkLogUploadHealthTracker::new();
    for _ in 0..12 {
        tracker.observe(NetworkLogUploadSessionOutcome::Success);
    }
    for _ in 0..2 {
        tracker.observe(session_transport_failure());
    }

    let ((first, second), events) = capture_async_log_events(async {
        let first_tracker = tracker.clone();
        let first = tokio::spawn(async move {
            first_tracker.observe(session_transport_failure());
        });
        let second_tracker = tracker.clone();
        let second = tokio::spawn(async move {
            second_tracker.observe(session_transport_failure());
        });
        tokio::join!(first, second)
    })
    .await;
    first.unwrap();
    second.unwrap();

    let degraded: Vec<_> = events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "network log uploads degraded")
        })
        .collect();
    assert_eq!(degraded.len(), 1, "events={events:#?}");
    let degraded = degraded[0];
    assert_eq!(degraded.level, tracing::Level::ERROR);
    assert_event_field(degraded, "window_seconds", "300");
    assert_event_field(degraded, "eligible_sessions", "15");
    assert_event_field(degraded, "successful_sessions", "12");
    assert_event_field(degraded, "transport_failures", "3");
    assert_event_field(degraded, "failure_rate_basis_points", "2000");
    assert_event_field(degraded, "failure_kind", "timeout");
    assert_event_field(degraded, "failure_cause", "timeout");
}

fn http_for_server(server: &MockServer) -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url: server.base_url(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap()
}

fn network_log_file(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("network.jsonl")
}

fn network_log_content(logs: &[serde_json::Value]) -> String {
    let mut content = Vec::new();
    for log in logs {
        serde_json::to_writer(&mut content, log).unwrap();
        content.push(b'\n');
    }
    if logs.is_empty() {
        content.push(b'\n');
    }
    String::from_utf8(content).unwrap()
}

fn one_entry_per_batch_log(sequence: usize) -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::from_iter([
        ("sequence".into(), json!(sequence)),
        (
            "body".into(),
            serde_json::Value::String("x".repeat(NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES / 2)),
        ),
    ]))
}

fn one_entry_per_batch_logs(count: usize) -> Vec<serde_json::Value> {
    let mut log = one_entry_per_batch_log(0);
    (0..count)
        .map(|sequence| {
            *log.get_mut("sequence").unwrap() = json!(sequence);
            log.clone()
        })
        .collect()
}

fn sequenced_log_content(
    log: &serde_json::Value,
    sequences: impl IntoIterator<Item = usize>,
) -> String {
    let fields = log.as_object().unwrap();
    assert!(fields.contains_key("sequence"));
    let mut prefix = vec![b'{'];
    let mut suffix = Vec::new();
    let mut after_sequence = false;
    for (index, (key, value)) in fields.iter().enumerate() {
        let bytes = if after_sequence {
            &mut suffix
        } else {
            &mut prefix
        };
        if index != 0 {
            bytes.push(b',');
        }
        serde_json::to_writer(&mut *bytes, key).unwrap();
        bytes.push(b':');
        if key == "sequence" {
            after_sequence = true;
        } else {
            serde_json::to_writer(bytes, value).unwrap();
        }
    }
    suffix.extend_from_slice(b"}\n");
    let mut content = Vec::new();
    for sequence in sequences {
        content.extend_from_slice(&prefix);
        serde_json::to_writer(&mut content, &sequence).unwrap();
        content.extend_from_slice(&suffix);
    }
    if content.is_empty() {
        content.push(b'\n');
    }
    String::from_utf8(content).unwrap()
}

fn one_entry_per_batch_log_content(count: usize) -> String {
    sequenced_log_content(&one_entry_per_batch_log(0), 0..count)
}

#[test]
fn sequenced_log_fixture_preserves_escaping_order_and_sequence_boundaries() {
    for log in [
        json!({"sequence":0}),
        json!({"sequence":0,"body":"你好\"\\\n\0\"sequence\":0"}),
        json!({"body":[null,true,19,{"sequence":0}],"sequence":0}),
        json!({"before":{},"sequence":0,"after":{"z":[],"a":null}}),
    ] {
        let original = log.to_string();
        for sequences in [vec![], vec![0], vec![1, 9, 10, 99, 100, usize::MAX]] {
            let expected = sequences
                .iter()
                .map(|sequence| {
                    let mut entry = log.clone();
                    *entry.get_mut("sequence").unwrap() = json!(sequence);
                    serde_json::to_string(&entry).unwrap()
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            assert_eq!(sequenced_log_content(&log, sequences), expected);
            assert_eq!(log.to_string(), original);
        }
    }
}

async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

async fn await_with_frozen_time<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    let clock_guard = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    let output = future.await;
    clock_guard.abort();
    let _ = clock_guard.await;
    output
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
}

fn captured_batch_event<'a>(
    events: &'a [CapturedEvent],
    message: &str,
    batch_index: usize,
) -> &'a CapturedEvent {
    let batch_index = batch_index.to_string();
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
                && event
                    .fields
                    .get("batch_index")
                    .is_some_and(|actual| actual == &batch_index)
        })
        .unwrap_or_else(|| {
            panic!("missing event {message} for batch {batch_index}; events={events:#?}")
        })
}

fn event_field<'a>(event: &'a CapturedEvent, field: &str) -> &'a str {
    event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"))
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event_field(event, field);
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}

fn assert_batch_request_event(event: &CapturedEvent, batch_index: usize, request_state: &str) {
    assert_event_field(event, "batch_index", &batch_index.to_string());
    assert_event_field(event, "client_session_id", "runner-session-test");
    assert_event_field(event, "client_version", env!("CARGO_PKG_VERSION"));
    assert_event_field(event, "request_state", request_state);
    uuid::Uuid::parse_str(event_field(event, "client_request_id")).unwrap();
}

fn assert_same_request_correlation(first: &CapturedEvent, second: &CapturedEvent) {
    for field in [
        "batch_index",
        "client_request_id",
        "client_session_id",
        "client_version",
    ] {
        assert_eq!(
            event_field(first, field),
            event_field(second, field),
            "field {field} mismatch; first={first:#?}; second={second:#?}"
        );
    }
}

fn has_captured_event(events: &[CapturedEvent], message: &str) -> bool {
    events.iter().any(|event| {
        event
            .fields
            .get("message")
            .is_some_and(|actual| actual == message)
    })
}

struct TestHttpRequest {
    headers: String,
    body: Vec<u8>,
}

impl TestHttpRequest {
    fn header(&self, expected_name: &str) -> &str {
        self.headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case(expected_name)
                    .then_some(value.trim())
            })
            .unwrap_or_else(|| {
                panic!(
                    "missing request header {expected_name}; headers={}",
                    self.headers
                )
            })
    }
}

async fn read_http_request(stream: &mut (impl tokio::io::AsyncRead + Unpin)) -> TestHttpRequest {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 8192];
    let header_end = loop {
        let bytes_read = stream.read(&mut chunk).await.unwrap();
        assert!(bytes_read > 0, "connection closed before request completed");
        request.extend_from_slice(&chunk[..bytes_read]);
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break header_end;
        }
    };
    let headers = std::str::from_utf8(&request[..header_end])
        .unwrap()
        .to_string();
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                Some(value.trim().parse::<usize>().unwrap())
            } else {
                None
            }
        })
        .expect("request must include content-length");
    let body_start = header_end + 4;
    let body_end = body_start
        .checked_add(content_length)
        .expect("request body length overflow");
    request.truncate(body_end);
    request.drain(..body_start);
    if request.len() < content_length {
        stream
            .take((content_length - request.len()) as u64)
            .read_to_end(&mut request)
            .await
            .unwrap();
        assert_eq!(
            request.len(),
            content_length,
            "connection closed before request completed"
        );
    }
    TestHttpRequest {
        headers,
        body: request,
    }
}

async fn read_http_request_body(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    read_http_request(stream).await.body
}

#[tokio::test]
async fn http_fixture_preserves_fragmented_headers_and_complete_bodies() {
    for body in [Vec::new(), b"head\r\n\r\n\0\xff-tail".repeat(32)] {
        let headers = format!(
            "POST /fixture HTTP/1.1\r\nx-client-request-id: fixture-id\r\ncOntent-Length: {}",
            body.len()
        );
        let mut wire = format!("{headers}\r\n\r\n").into_bytes();
        wire.extend_from_slice(&body);
        wire.extend_from_slice(b"zz");
        let (mut reader, mut writer) = tokio::io::duplex(3);
        let (actual, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(read_http_request(&mut reader), async {
                writer.write_all(&wire).await.unwrap();
            })
        })
        .await
        .unwrap();
        assert_eq!(actual.headers, headers);
        assert_eq!(actual.header(CLIENT_REQUEST_ID_HEADER), "fixture-id");
        assert_eq!(actual.body, body);
    }
}

#[tokio::test]
#[should_panic(expected = "connection closed before request completed")]
async fn http_fixture_rejects_early_header_close() {
    let (mut reader, mut writer) = tokio::io::duplex(3);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(read_http_request(&mut reader), async {
            writer
                .write_all(b"POST /partial HTTP/1.1\r\n")
                .await
                .unwrap();
            drop(writer);
        })
    })
    .await
    .unwrap();
}

#[tokio::test]
#[should_panic(expected = "connection closed before request completed")]
async fn http_fixture_rejects_early_body_close_without_declared_allocation() {
    let (mut reader, mut writer) = tokio::io::duplex(3);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(read_http_request(&mut reader), async {
            writer
                .write_all(
                    format!(
                        "POST /partial HTTP/1.1\r\nContent-Length: {}\r\n\r\nab",
                        usize::MAX / 2
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            drop(writer);
        })
    })
    .await
    .unwrap();
}

#[test]
fn upload_rejection_body_parser_extracts_bounded_api_error_fields() {
    let long_message = "x".repeat(NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS + 1);
    let body = json!({
        "error": {
            "code": "BAD_REQUEST",
            "message": long_message,
        },
    });
    let details = parse_upload_rejection_body(body.to_string().as_bytes(), false);

    assert_eq!(details.error_code.as_deref(), Some("BAD_REQUEST"));
    assert_eq!(
        details.error_message.unwrap().len(),
        NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS + 3
    );
    assert!(!details.body_truncated);
    assert!(details.body_read_error.is_none());
}

#[test]
fn upload_rejection_body_parser_ignores_malformed_body() {
    let details = parse_upload_rejection_body(b"not-json", true);

    assert_eq!(details.error_code, None);
    assert_eq!(details.error_message, None);
    assert!(details.body_truncated);
    assert!(details.body_read_error.is_none());
}

#[tokio::test]
async fn upload_network_logs_posts_payload_and_keeps_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let first = json!({
        "timestamp": "2026-02-15T10:00:00Z",
        "action": "ALLOW",
        "host": "api.github.com",
        "status": 200,
    });
    let second = json!({
        "timestamp": "2026-02-15T10:00:01Z",
        "action": "DENY",
        "host": "blocked.example",
        "status": 403,
    });
    let content = format!(
        "{}\n{}\n",
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap()
    );
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [first, second],
    });
    let upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .header("authorization", format!("Bearer {SANDBOX_TOKEN}"))
                .json_body(expected.clone());
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true}"#);
        })
        .await;

    let http = http_for_server(&server);
    let (outcome, events) =
        capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path)).await;

    upload.assert_calls_async(1).await;
    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Success);
    let started = captured_batch_event(&events, "uploading network log batch", 1);
    let uploaded = captured_batch_event(&events, "network log batch uploaded", 1);
    assert_batch_request_event(uploaded, 1, "confirmed_success");
    assert_same_request_correlation(started, uploaded);
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
}

#[tokio::test]
async fn upload_network_logs_splits_batches_by_entry_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let logs: Vec<_> = (0..=NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES)
        .map(|idx| {
            json!({
                "timestamp": "2026-02-15T10:00:00Z",
                "host": format!("host-{idx}.example"),
                "sequence": idx,
            })
        })
        .collect();
    let content = network_log_content(&logs);
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let first_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": logs[..NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES].to_vec(),
    });
    let second_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": logs[NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES..].to_vec(),
    });
    let first_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(first_expected.clone());
            then.status(200);
        })
        .await;
    let second_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(second_expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

    first_upload.assert_calls_async(1).await;
    second_upload.assert_calls_async(1).await;
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_allows_exact_batch_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let content = one_entry_per_batch_log_content(NETWORK_LOG_UPLOAD_MAX_BATCHES);
    tokio::fs::write(&path, content).await.unwrap();

    let server = MockServer::start_async().await;
    let upload = server
        .mock_async(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (_, events) = await_with_frozen_time(capture_async_log_events(upload_network_logs(
        &http,
        run_id,
        SANDBOX_TOKEN,
        &path,
    )))
    .await;

    upload
        .assert_calls_async(NETWORK_LOG_UPLOAD_MAX_BATCHES)
        .await;
    assert!(!has_captured_event(&events, "network log upload truncated"));
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_completes_incident_sized_file_within_batch_budget() {
    const INCIDENT_SOURCE_BYTES: usize = 42_772_957;
    const INCIDENT_ENTRY_COUNT: usize = 98_129;
    const INCIDENT_BODY_BYTES: usize = 372;

    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let body = "x".repeat(INCIDENT_BODY_BYTES);
    let mut content = String::with_capacity(INCIDENT_SOURCE_BYTES);
    for sequence in 0..INCIDENT_ENTRY_COUNT {
        writeln!(
            &mut content,
            r#"{{"timestamp":"2026-02-15T10:00:00Z","sequence":{sequence},"body":"{body}"}}"#
        )
        .unwrap();
    }
    assert!(content.len().abs_diff(INCIDENT_SOURCE_BYTES) <= 1024);
    tokio::fs::write(&path, &content).await.unwrap();
    let source_bytes = content.len();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let stop_server = Arc::new(tokio::sync::Notify::new());
    let server_stop = stop_server.clone();
    let server_task = tokio::spawn(async move {
        let mut received_batch_count = 0;
        let mut received_entry_count = 0;
        let mut original_lines = content.lines();
        loop {
            let (mut stream, _) = tokio::select! {
                () = server_stop.notified() => break,
                accepted = listener.accept() => accepted.unwrap(),
            };
            let request_body = read_http_request_body(&mut stream).await;
            let payload: serde_json::Value = serde_json::from_slice(&request_body).unwrap();
            let logs = payload["networkLogs"].as_array().unwrap();
            assert!(logs.len() <= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES);
            assert_eq!(payload["runId"], run_id.to_string());
            let mut estimated_bytes = empty_batch_estimated_bytes(&run_id);
            for (offset, log) in logs.iter().enumerate() {
                assert_eq!(log.as_object().unwrap().len(), 3);
                assert_eq!(log["sequence"], received_entry_count + offset);
                assert_eq!(log["body"], body);
                assert_eq!(log["timestamp"], "2026-02-15T10:00:00Z");
                // These compact ASCII records have the same length in any key order.
                let original = original_lines.next().unwrap();
                let entry_bytes = original.len() + NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES;
                estimated_bytes = estimated_bytes.saturating_add(entry_bytes);
            }
            assert!(estimated_bytes <= NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES);
            received_batch_count += 1;
            received_entry_count += logs.len();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        }
        assert!(original_lines.next().is_none());
        (received_batch_count, received_entry_count)
    });

    let http = HttpClient::new(HttpClientConfig {
        api_url,
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    let (_, events) = await_with_frozen_time(capture_async_log_events(upload_network_logs(
        &http,
        run_id,
        SANDBOX_TOKEN,
        &path,
    )))
    .await;
    stop_server.notify_one();
    let (received_batch_count, received_entry_count) = server_task.await.unwrap();
    assert!(received_batch_count > 32);
    assert!(received_batch_count <= NETWORK_LOG_UPLOAD_MAX_BATCHES);
    assert_eq!(received_entry_count, INCIDENT_ENTRY_COUNT);
    let uploaded = captured_event(&events, "uploaded network logs");
    assert_event_field(uploaded, "batches", &received_batch_count.to_string());
    assert_event_field(uploaded, "count", &INCIDENT_ENTRY_COUNT.to_string());
    assert!(!has_captured_event(&events, "network log upload truncated"));
    assert_eq!(
        tokio::fs::metadata(&path).await.unwrap().len(),
        source_bytes as u64
    );
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_stops_at_batch_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let uploaded_count = NETWORK_LOG_UPLOAD_MAX_BATCHES;
    let content = one_entry_per_batch_log_content(uploaded_count + 2);
    let mut dropped_log = one_entry_per_batch_log(uploaded_count);
    let dropped_entry_bytes = estimated_entry_bytes(&serde_json::to_string(&dropped_log).unwrap());
    *dropped_log.get_mut("sequence").unwrap() = json!(uploaded_count + 1);
    let remaining_source_bytes = serde_json::to_string(&dropped_log).unwrap().len() + 1;
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let upload = server
        .mock_async(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (_, events) = await_with_frozen_time(capture_async_log_events(upload_network_logs(
        &http,
        run_id,
        SANDBOX_TOKEN,
        &path,
    )))
    .await;

    upload
        .assert_calls_async(NETWORK_LOG_UPLOAD_MAX_BATCHES)
        .await;
    let event = captured_event(&events, "network log upload truncated");
    assert_event_field(event, "reason", "batch_count");
    for field in [
        "batch_index",
        "client_request_id",
        "client_session_id",
        "client_version",
        "request_state",
    ] {
        assert!(
            !event.fields.contains_key(field),
            "inactive request field {field} should be omitted; event={event:#?}"
        );
    }
    assert_event_field(event, "source_file_bytes", &content.len().to_string());
    assert_event_field(
        event,
        "source_bytes_examined",
        &(content.len() - remaining_source_bytes).to_string(),
    );
    assert_event_field(
        event,
        "remaining_source_bytes",
        &remaining_source_bytes.to_string(),
    );
    assert_event_field(
        event,
        "attempted_batches",
        &NETWORK_LOG_UPLOAD_MAX_BATCHES.to_string(),
    );
    assert_event_field(
        event,
        "successful_batches",
        &NETWORK_LOG_UPLOAD_MAX_BATCHES.to_string(),
    );
    assert_event_field(event, "attempted_entries", &uploaded_count.to_string());
    assert_event_field(event, "uploaded_entries", &uploaded_count.to_string());
    assert_event_field(event, "unconfirmed_entries", "0");
    assert_event_field(event, "observed_dropped_entries", "1");
    assert_event_field(
        event,
        "observed_dropped_estimated_bytes",
        &dropped_entry_bytes.to_string(),
    );
}

#[tokio::test]
async fn upload_network_logs_splits_batches_by_estimated_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let large_value = "x".repeat(NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES / 2);
    let first = json!({
        "timestamp": "2026-02-15T10:00:00Z",
        "host": "large-first.example",
        "body": large_value,
    });
    let second = json!({
        "timestamp": "2026-02-15T10:00:01Z",
        "host": "large-second.example",
        "body": large_value,
    });
    let logs = vec![first.clone(), second.clone()];
    let content = network_log_content(&logs);
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let first_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [first],
    });
    let second_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [second],
    });
    let first_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(first_expected.clone());
            then.status(200);
        })
        .await;
    let second_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(second_expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

    first_upload.assert_calls_async(1).await;
    second_upload.assert_calls_async(1).await;
}

#[tokio::test]
async fn upload_network_logs_skips_oversized_entry_and_continues() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let oversized_value = "x".repeat(NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES);
    let oversized = json!({
        "timestamp": "2026-02-15T10:00:00Z",
        "host": "oversized.example",
        "body": oversized_value,
    });
    let valid = json!({
        "timestamp": "2026-02-15T10:00:01Z",
        "host": "valid-after-oversized.example",
    });
    let logs = vec![oversized, valid.clone()];
    let content = network_log_content(&logs);
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [valid],
    });
    let upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (outcome, events) =
        capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path)).await;

    upload.assert_calls_async(1).await;
    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Excluded);
    let event = captured_event(&events, "network log upload truncated");
    assert_event_field(event, "reason", "oversized_entry");
    assert_event_field(event, "attempted_batches", "1");
    assert_event_field(event, "successful_batches", "1");
    assert_event_field(event, "attempted_entries", "1");
    assert_event_field(event, "uploaded_entries", "1");
    assert_event_field(event, "unconfirmed_entries", "0");
    assert_event_field(event, "oversized_entries", "1");
    assert_event_field(event, "observed_dropped_entries", "0");
    assert_event_field(event, "remaining_source_bytes", "0");
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
}

#[tokio::test]
async fn upload_network_logs_preserves_exact_trimmed_record_admission() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from(uuid::Uuid::nil());
    let empty_record_bytes = serde_json::to_string(&json!({"body":""})).unwrap().len();
    let body_bytes = NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES
        - empty_batch_estimated_bytes(&run_id)
        - NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES
        - empty_record_bytes;
    for overflow in [0, 1] {
        let path = dir.path().join(format!("boundary-{overflow}.jsonl"));
        let record = Value::Object(Map::from_iter([(
            "body".to_owned(),
            Value::String("x".repeat(body_bytes + overflow)),
        )]));
        let after = json!({"sequence":1});
        let content = format!("\u{2003}{record}\u{2028}\r\n{after}");
        tokio::fs::write(&path, content.as_bytes()).await.unwrap();
        let server = MockServer::start_async().await;
        let mut uploads = Vec::new();
        let batches = if overflow == 0 {
            vec![vec![record], vec![after]]
        } else {
            vec![vec![after]]
        };
        for batch in batches {
            let expected = Value::Object(Map::from_iter([
                ("runId".to_owned(), Value::String(run_id.to_string())),
                ("networkLogs".to_owned(), Value::Array(batch)),
            ]));
            uploads.push(
                server
                    .mock_async(move |when, then| {
                        when.method(POST)
                            .path("/api/webhooks/agent/telemetry")
                            .json_body(expected);
                        then.status(200);
                    })
                    .await,
            );
        }
        let http = http_for_server(&server);
        let outcome = upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;
        let expected_outcome = if overflow == 0 {
            NetworkLogUploadSessionOutcome::Success
        } else {
            NetworkLogUploadSessionOutcome::Excluded
        };
        assert_eq!(outcome, expected_outcome, "overflow={overflow}");
        for upload in uploads {
            upload.assert_calls_async(1).await;
        }
        assert_eq!(tokio::fs::read(&path).await.unwrap(), content.as_bytes());
    }
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_stops_at_source_byte_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let mut content = vec![b'x'; NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES as usize - 1];
    content.extend_from_slice("€".as_bytes());
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let upload = server
        .mock_async(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (_, events) = await_with_frozen_time(capture_async_log_events(upload_network_logs(
        &http,
        RunId::from(uuid::Uuid::nil()),
        SANDBOX_TOKEN,
        &path,
    )))
    .await;

    upload.assert_calls_async(0).await;
    let event = captured_event(&events, "network log upload truncated");
    assert_event_field(event, "reason", "source_bytes");
    assert_event_field(event, "source_file_bytes", &content.len().to_string());
    assert_event_field(
        event,
        "source_bytes_examined",
        &NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES.to_string(),
    );
    assert_event_field(event, "remaining_source_bytes", "2");
    assert_event_field(event, "attempted_batches", "0");
    assert_event_field(event, "attempted_entries", "0");
    assert_event_field(event, "partial_source_line", "true");
    assert!(!has_captured_event(&events, "failed to read network logs"));
    assert!(!has_captured_event(&events, "malformed network log line"));
    assert_eq!(
        tokio::fs::metadata(&path).await.unwrap().len(),
        content.len() as u64
    );
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_allows_exact_source_byte_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let log = json!({ "sequence": 1 });
    let mut content = network_log_content(std::slice::from_ref(&log)).into_bytes();
    content.resize(NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES as usize, b' ');
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [log],
    });
    let upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (_, events) = await_with_frozen_time(capture_async_log_events(upload_network_logs(
        &http,
        run_id,
        SANDBOX_TOKEN,
        &path,
    )))
    .await;

    upload.assert_calls_async(1).await;
    assert!(!has_captured_event(&events, "network log upload truncated"));
    assert_eq!(
        tokio::fs::metadata(&path).await.unwrap().len(),
        NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES
    );
}

#[tokio::test]
async fn upload_network_logs_skips_malformed_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let first = json!({
        "timestamp": "2026-02-15T10:00:00Z",
        "host": "first-valid.example",
    });
    let second = json!({
        "timestamp": "2026-02-15T10:00:01Z",
        "host": "second-valid.example",
    });
    tokio::fs::write(
        &path,
        format!(
            "{}\nnot json with invalid.example\n{}\n\n",
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        ),
    )
    .await
    .unwrap();

    let server = MockServer::start_async().await;
    let expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [first, second],
    });
    let upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let outcome = upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

    upload.assert_calls_async(1).await;
    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Excluded);
}

#[tokio::test]
async fn upload_network_logs_preserves_valid_entries_around_invalid_utf8_line() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let first = json!({
        "timestamp": "2026-02-15T10:00:00Z",
        "host": "first-valid.example",
    });
    let second = json!({
        "timestamp": "2026-02-15T10:00:01Z",
        "host": "second-valid.example",
    });

    let mut content = serde_json::to_vec(&first).unwrap();
    content.extend_from_slice(b"\n");
    content.extend_from_slice(&[0xFF, 0xFE]);
    content.extend_from_slice(b"\n");
    content.extend_from_slice(&serde_json::to_vec(&second).unwrap());
    content.extend_from_slice(b"\n");
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [first, second],
    });
    let upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (_, events) =
        capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path)).await;

    upload.assert_calls_async(1).await;
    assert!(has_captured_event(&events, "malformed network log line"));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), content);
}

#[tokio::test]
async fn upload_network_logs_flushes_pending_batch_after_truncated_multibyte_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let first = json!({
        "timestamp": "2026-02-15T10:00:00Z",
        "host": "first-valid.example",
    });

    let mut content = serde_json::to_vec(&first).unwrap();
    content.extend_from_slice(b"\n");
    content.extend_from_slice(&[0xE2, 0x82]);
    tokio::fs::write(&path, &content).await.unwrap();

    let server = MockServer::start_async().await;
    let expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": [first],
    });
    let upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let (_, events) =
        capture_async_log_events(upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path)).await;

    upload.assert_calls_async(1).await;
    assert!(has_captured_event(&events, "malformed network log line"));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), content);
}

#[tokio::test]
async fn upload_network_logs_stops_after_rejected_batch() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let run_id = RunId::from(uuid::Uuid::nil());
    let logs = one_entry_per_batch_logs(3);
    tokio::fs::write(&path, network_log_content(&logs))
        .await
        .unwrap();

    let server = MockServer::start_async().await;
    let first_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": logs[..1].to_vec(),
    });
    let second_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": logs[1..2].to_vec(),
    });
    let third_expected = json!({
        "runId": run_id.to_string(),
        "networkLogs": logs[2..].to_vec(),
    });
    let first_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(first_expected.clone());
            then.status(200);
        })
        .await;
    let second_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(second_expected.clone());
            then.status(500);
        })
        .await;
    let third_upload = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .json_body(third_expected.clone());
            then.status(200);
        })
        .await;

    let http = http_for_server(&server);
    let outcome = upload_network_logs(&http, run_id, SANDBOX_TOKEN, &path).await;

    first_upload.assert_calls_async(1).await;
    second_upload.assert_calls_async(1).await;
    third_upload.assert_calls_async(0).await;
    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Excluded);
    assert!(path.exists());
}

#[tokio::test]
async fn upload_network_logs_returns_without_post_for_empty_missing_or_unreadable_input() {
    let server = MockServer::start_async().await;
    let upload = server
        .mock_async(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200);
        })
        .await;
    let http = http_for_server(&server);
    let run_id = RunId::from(uuid::Uuid::nil());
    let dir = tempfile::tempdir().unwrap();

    let missing = upload_network_logs(&http, run_id, SANDBOX_TOKEN, &network_log_file(&dir)).await;
    assert_eq!(missing, NetworkLogUploadSessionOutcome::Excluded);

    let empty = dir.path().join("empty.jsonl");
    tokio::fs::write(&empty, " \n\t\n").await.unwrap();
    let empty = upload_network_logs(&http, run_id, SANDBOX_TOKEN, &empty).await;
    assert_eq!(empty, NetworkLogUploadSessionOutcome::Excluded);

    let unreadable = upload_network_logs(&http, run_id, SANDBOX_TOKEN, dir.path()).await;
    assert_eq!(unreadable, NetworkLogUploadSessionOutcome::Excluded);

    upload.assert_calls_async(0).await;
}

#[tokio::test]
async fn upload_network_logs_returns_without_retry_when_server_rejects() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    tokio::fs::write(&path, r#"{"host":"reject.example"}"#)
        .await
        .unwrap();

    let server = MockServer::start_async().await;
    let upload = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.status(400)
                    .header("content-type", "application/json")
                    .json_body(json!({
                        "error": {
                            "code": "BAD_REQUEST",
                            "message": "networkLogs.0.action: Invalid option: expected one of \"ALLOW\"|\"DENY\"|\"BLOCK\"",
                        },
                    }));
            })
            .await;

    let http = http_for_server(&server);
    let (outcome, events) = capture_async_log_events(upload_network_logs(
        &http,
        RunId::from(uuid::Uuid::nil()),
        SANDBOX_TOKEN,
        &path,
    ))
    .await;

    upload.assert_calls_async(1).await;
    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Excluded);
    let started = captured_batch_event(&events, "uploading network log batch", 1);
    let event = captured_batch_event(&events, "network logs upload rejected", 1);
    assert_batch_request_event(event, 1, "confirmed_rejection");
    assert_same_request_correlation(started, event);
    assert_event_field(event, "status", "400 Bad Request");
    assert_event_field(event, "response_error_code", "BAD_REQUEST");
    assert_event_field(
        event,
        "response_error_message",
        "networkLogs.0.action: Invalid option: expected one of \"ALLOW\"|\"DENY\"|\"BLOCK\"",
    );
    assert_event_field(event, "response_body_truncated", "false");
    assert!(path.exists());
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_uses_one_absolute_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let logs = one_entry_per_batch_logs(5);
    tokio::fs::write(&path, network_log_content(&logs))
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let batch_received = Arc::new(tokio::sync::Notify::new());
    let release_batch = Arc::new(tokio::sync::Notify::new());
    let final_received = Arc::new(tokio::sync::Notify::new());
    let (final_request_id_sender, final_request_id_receiver) = tokio::sync::oneshot::channel();
    let server_task = {
        let batch_received = batch_received.clone();
        let release_batch = release_batch.clone();
        let final_received = final_received.clone();
        tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let _ = read_http_request_body(&mut stream).await;
                batch_received.notify_one();
                release_batch.notified().await;
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();
            }

            let (mut final_stream, _) = listener.accept().await.unwrap();
            let final_request = read_http_request(&mut final_stream).await;
            final_request_id_sender
                .send(final_request.header(CLIENT_REQUEST_ID_HEADER).to_string())
                .unwrap();
            final_received.notify_one();
            let hold_final = tokio::sync::Notify::new();
            hold_final.notified().await;
            drop(final_stream);
        })
    };

    let http = HttpClient::new(HttpClientConfig {
        api_url,
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    let upload = capture_async_log_events(upload_network_logs(
        &http,
        RunId::from(uuid::Uuid::nil()),
        SANDBOX_TOKEN,
        &path,
    ));
    tokio::pin!(upload);
    let clock_guard = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });

    let started_at = Instant::now();
    for _ in 0..4 {
        tokio::select! {
            () = batch_received.notified() => {}
            result = &mut upload => panic!("upload ended before expected request: {result:#?}"),
        }
        tokio::time::advance(Duration::from_secs(6)).await;
        release_batch.notify_one();
    }
    tokio::select! {
        () = final_received.notified() => {}
        result = &mut upload => panic!("upload ended before final request: {result:#?}"),
    }
    let final_request_id = final_request_id_receiver.await.unwrap();
    tokio::time::advance(Duration::from_secs(6)).await;

    let (outcome, events) = upload.await;
    assert_eq!(started_at.elapsed(), Duration::from_secs(30));
    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Excluded);
    clock_guard.abort();
    let _ = clock_guard.await;
    server_task.abort();
    let _ = server_task.await;

    let truncation = captured_event(&events, "network log upload truncated");
    let started = captured_batch_event(&events, "uploading network log batch", 5);
    assert_eq!(truncation.level, tracing::Level::WARN);
    assert_batch_request_event(truncation, 5, "outcome_unknown");
    assert_same_request_correlation(started, truncation);
    assert_eq!(
        event_field(truncation, "client_request_id"),
        final_request_id
    );
    assert_event_field(truncation, "reason", "deadline");
    assert_event_field(truncation, "attempted_batches", "5");
    assert_event_field(truncation, "successful_batches", "4");
    assert_event_field(truncation, "attempted_entries", "5");
    assert_event_field(truncation, "uploaded_entries", "4");
    assert_event_field(truncation, "unconfirmed_entries", "1");
    assert_event_field(truncation, "remaining_source_bytes", "0");
    let uploaded = captured_event(&events, "uploaded network logs");
    assert_event_field(uploaded, "batches", "4");
    assert_event_field(uploaded, "count", "4");
    assert!(!has_captured_event(&events, "network logs upload failed"));
    assert!(path.exists());
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_completes_slow_sequential_batches() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let logs = one_entry_per_batch_logs(3);
    tokio::fs::write(&path, network_log_content(&logs))
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = HttpClient::new(HttpClientConfig {
        api_url: format!("http://{}", listener.local_addr().unwrap()),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    let received = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let server_task = {
        let received = received.clone();
        let release = release.clone();
        tokio::spawn(async move {
            for log in logs {
                let (mut stream, _) = listener.accept().await.unwrap();
                let body = read_http_request_body(&mut stream).await;
                let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(payload["networkLogs"], json!([log]));
                received.notify_one();
                release.notified().await;
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();
            }
        })
    };

    let (outcome, events) = await_with_frozen_time(async {
        let upload = capture_async_log_events(upload_network_logs(
            &http,
            RunId::from(uuid::Uuid::nil()),
            SANDBOX_TOKEN,
            &path,
        ));
        tokio::pin!(upload);
        let started_at = Instant::now();
        for _ in 0..3 {
            tokio::select! {
                () = received.notified() => {}
                result = &mut upload => panic!("upload ended before expected request: {result:#?}"),
            }
            tokio::time::advance(Duration::from_secs(6)).await;
            release.notify_one();
        }
        let result = upload.await;
        assert_eq!(started_at.elapsed(), Duration::from_secs(18));
        result
    })
    .await;
    server_task.await.unwrap();

    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Success);
    let uploaded = captured_event(&events, "uploaded network logs");
    assert_event_field(uploaded, "batches", "3");
    assert_event_field(uploaded, "count", "3");
    assert!(!has_captured_event(&events, "network log upload truncated"));
    assert!(!has_captured_event(&events, "network logs upload failed"));
    assert!(path.exists());
}

#[tokio::test(start_paused = true)]
async fn upload_network_logs_preserves_per_request_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    tokio::fs::write(&path, network_log_content(&one_entry_per_batch_logs(2)))
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = HttpClient::new(HttpClientConfig {
        api_url: format!("http://{}", listener.local_addr().unwrap()),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    let received = Arc::new(tokio::sync::Notify::new());
    let server_task = {
        let received = received.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_http_request_body(&mut stream).await;
            received.notify_one();
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
            listener
        })
    };

    let (outcome, events) = await_with_frozen_time(async {
        let upload = capture_async_log_events(upload_network_logs(
            &http,
            RunId::from(uuid::Uuid::nil()),
            SANDBOX_TOKEN,
            &path,
        ));
        tokio::pin!(upload);
        let started_at = Instant::now();
        tokio::select! {
            () = received.notified() => {}
            result = &mut upload => panic!("upload ended before request: {result:#?}"),
        }
        tokio::time::advance(Duration::from_secs(10)).await;
        let result = upload.await;
        assert_eq!(started_at.elapsed(), Duration::from_secs(10));
        result
    })
    .await;
    let listener = server_task.await.unwrap();
    // Keep accepting through completion so a retry cannot hide behind connection refusal.
    assert!(
        tokio::time::timeout(Duration::from_millis(1), listener.accept())
            .await
            .is_err()
    );

    let failed = captured_batch_event(&events, "network logs upload failed", 1);
    assert_eq!(
        outcome,
        NetworkLogUploadSessionOutcome::TransportFailure {
            failure: NetworkLogTransportFailure {
                kind: "timeout",
                cause: "timeout"
            },
        }
    );
    assert_eq!(failed.level, tracing::Level::INFO);
    assert_batch_request_event(failed, 1, "transport_failure");
    assert_event_field(failed, "failure_kind", "timeout");
    assert_event_field(failed, "failure_cause", "timeout");
    assert!(event_field(failed, "error").contains("timeout"));
    assert!(!has_captured_event(&events, "network log upload truncated"));
    assert!(!has_captured_event(&events, "uploaded network logs"));
    assert!(path.exists());
}

#[tokio::test]
async fn upload_network_logs_returns_on_transport_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    tokio::fs::write(&path, r#"{"host":"transport-error.example"}"#)
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let attempts = Arc::new(AtomicUsize::new(0));
    let accept_attempts = attempts.clone();
    let stop_accepting = Arc::new(tokio::sync::Notify::new());
    let stop_signal = stop_accepting.clone();
    let accept_once = tokio::spawn(async move {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if accepted.is_ok() {
                        accept_attempts.fetch_add(1, Ordering::SeqCst);
                    }
                }
                () = stop_signal.notified() => break,
            }
        }
    });

    let http = HttpClient::new(HttpClientConfig {
        api_url,
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    let (outcome, events) = capture_async_log_events(upload_network_logs(
        &http,
        RunId::from(uuid::Uuid::nil()),
        SANDBOX_TOKEN,
        &path,
    ))
    .await;

    stop_accepting.notify_one();
    accept_once.await.unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    let started = captured_batch_event(&events, "uploading network log batch", 1);
    let failed = captured_batch_event(&events, "network logs upload failed", 1);
    let failure = match outcome {
        NetworkLogUploadSessionOutcome::TransportFailure { failure } => failure,
        outcome => panic!("expected transport failure, got {outcome:?}"),
    };
    assert_eq!(failed.level, tracing::Level::INFO);
    assert_batch_request_event(failed, 1, "transport_failure");
    assert_event_field(failed, "failure_kind", failure.kind);
    assert_event_field(failed, "failure_cause", failure.cause);
    assert_same_request_correlation(started, failed);
    assert!(path.exists());
}
