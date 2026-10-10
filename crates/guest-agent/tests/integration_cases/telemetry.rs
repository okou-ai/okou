use crate::support::*;
use base64::Engine;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TELEMETRY_DELTA_READ_LIMIT: usize = 256 * 1024;
const OVERSIZED_SYSTEM_LOG_LINE_MARKER_FRAGMENT: &str =
    "telemetry omitted oversized system log line";

// Only operation-producing tests install this process-global sink. Borrow both
// owners so it is cleared before the files or the shared producer lock go away.
struct SandboxOpsOverrideGuard<'a> {
    _api: &'a SharedApiMock,
    _files: &'a ExplicitTelemetryFiles,
}

impl<'a> SandboxOpsOverrideGuard<'a> {
    fn set(api: &'a SharedApiMock, files: &'a ExplicitTelemetryFiles) -> Self {
        guest_telemetry::telemetry::set_sandbox_ops_log_file(files.paths.sandbox_ops_file());
        Self {
            _api: api,
            _files: files,
        }
    }
}

impl Drop for SandboxOpsOverrideGuard<'_> {
    fn drop(&mut self) {
        guest_telemetry::telemetry::clear_sandbox_ops_log_file();
    }
}

struct ExplicitTelemetryFiles {
    _tmp: tempfile::TempDir,
    paths: guest_agent::paths::GuestPaths,
}

impl ExplicitTelemetryFiles {
    fn new(name: &str) -> std::io::Result<Self> {
        let tmp = tempfile::tempdir()?;
        let paths = guest_agent::paths::GuestPaths::from_runtime_dir(tmp.path().join(name));
        remove_telemetry_files(&paths);
        Ok(Self { _tmp: tmp, paths })
    }
}

fn remove_telemetry_files(paths: &guest_agent::paths::GuestPaths) {
    let _ = std::fs::remove_file(paths.system_log_file());
    let _ = std::fs::remove_file(paths.metrics_log_file());
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
    let _ = std::fs::remove_file(paths.telemetry_system_log_pos_file());
    let _ = std::fs::remove_file(paths.telemetry_metrics_pos_file());
    let _ = std::fs::remove_file(paths.telemetry_sandbox_ops_pos_file());
}

fn ensure_parent_dir(path: &str) {
    let Some(parent) = std::path::Path::new(path).parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
}

#[tokio::test]
async fn spawn_for_paths_uploads_explicit_runtime_files() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("spawn-for-paths").unwrap();
    let paths = &files.paths;

    let upload_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(r#""runId":"explicit-run""#)
            .body_includes("explicit system log");
        then.status(200);
    });

    guest_agent::paths::write_private(paths.system_log_file(), "explicit system log\n")
        .expect("explicit system log should be written");

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "explicit-run".to_string(),
        paths,
        masker,
        http_client!(),
    );
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("explicit telemetry flush should succeed");
    telemetry.shutdown().await;

    upload_mock.assert_calls_async(1).await;
    upload_mock.delete_async().await;
}

// =========================================================================
// Telemetry flush delta semantics
//
// Backs the parallel-finalization-with-catch-up pattern in `main.rs`: the
// first `flush(UploadMode::Live)` runs concurrently with
// `finalization::prepare_finalization_for_runtime` and reads the `sandbox_ops` log before
// finalization's sub-op records are written; a second
// `flush(UploadMode::Final)` after the join picks up the delta. If the
// uploader ever stopped being incremental — re-reading from offset 0 —
// that pattern would duplicate records; if position-tracking broke in
// the other direction, finalization sub-ops would be lost entirely.
// =========================================================================

#[tokio::test]
async fn flush_is_incremental_between_calls() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("flush-incremental").unwrap();
    let _sandbox_ops_override = SandboxOpsOverrideGuard::set(&api, &files);
    let paths = &files.paths;

    // Capture every telemetry request so the assertions below can verify
    // both the exact upload count and the content of each ordered delta.
    let request_bodies = Arc::new(Mutex::new(Vec::new()));
    let request_bodies_for_mock = Arc::clone(&request_bodies);
    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.respond_with(move |request| {
            request_bodies_for_mock
                .lock()
                .unwrap()
                .push(request.body_vec());
            http_status(200)
        });
    });

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    // Independent uploaders, such as the raw-listener OOM fixtures, must not
    // redirect this producer's records when their private files are created.
    let independent_files = ExplicitTelemetryFiles::new("independent-uploader").unwrap();
    let independent_telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "independent-run".to_string(),
        &independent_files.paths,
        Arc::new(SecretMasker::from_raw("")),
        http_client!(),
    );

    // Pre-finalization record → first flush captures it.
    guest_telemetry::telemetry::record_sandbox_op(
        "first_op",
        Duration::from_millis(10),
        true,
        None,
    );
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("first flush should succeed");

    let independent_report = independent_telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("independent empty flush should succeed");
    independent_telemetry.shutdown().await;
    // Its teardown must not clear the active producer's destination either.
    drop(independent_files);

    // Simulates a finalization sub-op written AFTER the parallel pass read
    // the sandbox_ops file. The catch-up flush must pick it up.
    guest_telemetry::telemetry::record_sandbox_op(
        "second_op",
        Duration::from_millis(20),
        true,
        None,
    );
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("catch-up flush should succeed");

    telemetry.shutdown().await;

    assert!(!independent_report.uploaded);
    upload_mock.assert_calls_async(2).await;

    // Each flush is awaited before the next operation is recorded, so the
    // captured order is the live upload followed by the catch-up upload.
    {
        let request_bodies = request_bodies.lock().unwrap();
        assert_eq!(request_bodies.len(), 2, "expected two captured uploads");

        let first_payload: serde_json::Value = serde_json::from_slice(&request_bodies[0])
            .expect("first telemetry request should contain valid JSON");
        assert_eq!(first_payload["runId"], "test-run-001");
        let first_operations = first_payload["sandboxOperations"]
            .as_array()
            .expect("first telemetry request should contain sandbox operations");
        assert_eq!(
            first_operations.len(),
            1,
            "first upload should contain exactly one sandbox operation"
        );
        assert_eq!(first_operations[0]["action_type"], "first_op");

        let catchup_payload: serde_json::Value = serde_json::from_slice(&request_bodies[1])
            .expect("catch-up telemetry request should contain valid JSON");
        assert_eq!(catchup_payload["runId"], "test-run-001");
        let catchup_operations = catchup_payload["sandboxOperations"]
            .as_array()
            .expect("catch-up telemetry request should contain sandbox operations");
        assert_eq!(
            catchup_operations.len(),
            1,
            "catch-up upload should contain exactly one sandbox operation"
        );
        assert_eq!(catchup_operations[0]["action_type"], "second_op");
    }

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn final_flush_and_shutdown_uploads_log_emitted_immediately_before_it() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("final-flush-tail").unwrap();
    let paths = &files.paths;
    let system_log = paths.system_log_file();

    let marker = "fatal-tail-before-final-telemetry";
    let upload_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(marker);
        then.status(200);
    });

    let system_log_guard = SystemLogOverrideGuard::set(system_log);
    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    guest_telemetry::log_warn!("sandbox:guest-agent", "{marker}");
    tokio::time::timeout(Duration::from_secs(5), telemetry.final_flush_and_shutdown())
        .await
        .expect(
            "final telemetry upload and uploader task termination should complete within 5 seconds",
        )
        .expect("final flush and shutdown should upload just-emitted log");
    drop(system_log_guard);

    upload_mock.assert_calls_async(1).await;
    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

async fn assert_cancelled_telemetry_owner_finishes_upload(
    final_shutdown: bool,
    keep_reporter: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::AsyncWriteExt;

    let files = ExplicitTelemetryFiles::new("cancelled-owner")?;
    guest_agent::paths::write_private(files.paths.system_log_file(), "pending\n")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http = guest_agent::http::HttpClient::with_api_config(
        format!("http://{}", listener.local_addr()?),
        "test-token",
        "",
        "test-session",
        Duration::ZERO,
    )?;
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "cancelled-owner".into(),
        &files.paths,
        Arc::new(SecretMasker::from_raw("")),
        http,
    );
    let reporter = keep_reporter.then(|| telemetry.incident_reporter());
    let owner = tokio::spawn(async move {
        if final_shutdown {
            telemetry.final_flush_and_shutdown().await
        } else {
            let result = telemetry
                .flush(guest_agent::telemetry::UploadMode::Live)
                .await;
            telemetry.shutdown().await;
            result
        }
    });

    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await??;
    tokio::time::timeout(
        Duration::from_secs(5),
        super::http_client::read_raw_request(&mut stream),
    )
    .await??;
    // The complete request proves the upload is in flight. Join the aborted
    // owner before making its successful response available.
    owner.abort();
    assert!(matches!(owner.await, Err(error) if error.is_cancelled()));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .await?;
    drop(stream);

    // This test owns its current-thread runtime and starts no mock-server
    // tasks. Quiescence observes both uploader and HTTP task cleanup without
    // exposing a private worker handle or waiting an arbitrary amount of time.
    let metrics = tokio::runtime::Handle::current().metrics();
    let terminated = tokio::time::timeout(Duration::from_secs(5), async {
        while metrics.num_alive_tasks() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        terminated.is_ok(),
        "cancelled owner left {} tasks: final_shutdown={final_shutdown}, keep_reporter={keep_reporter}",
        metrics.num_alive_tasks()
    );
    assert_eq!(
        std::fs::read_to_string(files.paths.telemetry_system_log_pos_file())?,
        "8",
        "the accepted upload must persist its cursor, keep_reporter={keep_reporter}"
    );
    drop(reporter);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_telemetry_final_shutdown_finishes_upload_and_exits() {
    for keep_reporter in [true, false] {
        assert_cancelled_telemetry_owner_finishes_upload(true, keep_reporter)
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_telemetry_live_flush_owner_finishes_upload_and_exits() {
    for keep_reporter in [true, false] {
        assert_cancelled_telemetry_owner_finishes_upload(false, keep_reporter)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn telemetry_preserves_runtime_session_id_and_masks_secrets() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("runtime-session-mask").unwrap();
    let _sandbox_ops_override = SandboxOpsOverrideGuard::set(&api, &files);
    let paths = &files.paths;
    let _session_files = SessionFinalizationFilesGuard::new();

    let system_log = paths.system_log_file();
    ensure_parent_dir(system_log);

    let session_id = "telemetry-session-id";
    let secret = "actual-telemetry-secret-123";
    let event_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(format!(r#""session_id":"{session_id}""#));
        then.status(200);
    });
    let raw_telemetry_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(secret);
        then.status(500);
    });
    let masked_telemetry_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(format!("system log {session_id} ***"))
            .body_includes(r#""action_type":"telemetry_secret_mask""#)
            .body_includes(r#""duration_ms":17"#)
            .body_includes(r#""success":false"#)
            .body_includes(r#""error":"sandbox failure: ***""#);
        then.status(200);
    });

    let secret_values = [secret, "error"]
        .map(|value| base64::engine::general_purpose::STANDARD.encode(value))
        .join(",");
    let masker = std::sync::Arc::new(SecretMasker::from_raw(&secret_values));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        std::sync::Arc::clone(&masker),
        http_client!(),
    );
    let event = serde_json::json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id
    });
    let config = shared_guest_config().expect("shared integration guest config should be valid");
    guest_agent::events::send_event_for_config(&http_client!(), event, 1, &masker, &config, paths)
        .await
        .expect("session event should be sent");

    std::fs::write(system_log, format!("system log {session_id} {secret}\n"))
        .expect("system log should be written");
    let sandbox_error = format!("sandbox failure: {secret}");
    guest_telemetry::telemetry::record_sandbox_op(
        "telemetry_secret_mask",
        Duration::from_millis(17),
        false,
        Some(&sandbox_error),
    );
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("final flush should upload masked log");
    telemetry.shutdown().await;

    event_mock.assert_calls_async(1).await;
    raw_telemetry_mock.assert_calls_async(0).await;
    masked_telemetry_mock.assert_calls_async(1).await;

    event_mock.delete_async().await;
    raw_telemetry_mock.delete_async().await;
    masked_telemetry_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn telemetry_redacts_multiline_secret_across_flushes() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("multiline-secret-across-flushes").unwrap();
    let paths = &files.paths;
    let system_log = paths.system_log_file();
    ensure_parent_dir(system_log);

    let secret_lines = [
        "first-telemetry-secret-line",
        "second-telemetry-secret-line",
    ];
    let secret = secret_lines.join("\n");
    let request_bodies = Arc::new(Mutex::new(Vec::new()));
    let request_bodies_for_mock = Arc::clone(&request_bodies);
    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.respond_with(move |request| {
            request_bodies_for_mock
                .lock()
                .unwrap()
                .push(request.body_vec());
            http_status(200)
        });
    });

    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = Arc::new(SecretMasker::from_raw(&encoded_secret));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    std::fs::write(system_log, format!("{}\n", secret_lines[0]))
        .expect("first secret line should be written");
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("first secret line should be uploaded");

    {
        let mut log = std::fs::OpenOptions::new()
            .append(true)
            .open(system_log)
            .expect("system log should open for append");
        writeln!(log, "{}", secret_lines[1]).expect("second secret line should be appended");
    }
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("second secret line should be uploaded");
    telemetry.shutdown().await;

    upload_mock.assert_calls_async(2).await;
    {
        let request_bodies = request_bodies.lock().unwrap();
        assert_eq!(request_bodies.len(), 2, "expected two telemetry uploads");

        let first_payload: serde_json::Value = serde_json::from_slice(&request_bodies[0])
            .expect("first telemetry request should contain valid JSON");
        let second_payload: serde_json::Value = serde_json::from_slice(&request_bodies[1])
            .expect("second telemetry request should contain valid JSON");
        assert_eq!(first_payload["systemLog"], "***\n");
        assert_eq!(second_payload["systemLog"], "***\n");

        for request_body in request_bodies.iter() {
            let request_body = String::from_utf8_lossy(request_body);
            for secret_line in secret_lines {
                assert!(
                    !request_body.contains(secret_line),
                    "telemetry request leaked multiline secret component: {secret_line}"
                );
            }
        }
    }

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

/// Regression for #11008. Combines two distinct guarantees that
/// together produce the "exactly one HTTP POST" assertion:
///
/// 1. **Channel serialization**: every flush goes through the same
///    `tokio::select!` arm in `run()`, so `upload_telemetry` calls are
///    strictly sequential — `save_position` is single-writer.
/// 2. **Empty-delta short-circuit**: the second and third flushes
///    observe `pos == file_len` after the first flush advanced the
///    position, hit the `system_log.is_empty() && metrics.is_empty()
///    && sandbox_ops.is_empty()` early-return in `upload_telemetry`,
///    and skip HTTP entirely.
///
/// Without (1), two flushes could read the same pos and post twice.
/// Without (2), three flushes would all serialize but each would post
/// (the second and third with empty bodies). Asserting `calls == 1`
/// pins both: pos never regresses (1) and empty deltas don't generate
/// HTTP traffic (2).
#[tokio::test]
async fn concurrent_flushes_do_not_regress_pos_file() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("concurrent-flushes").unwrap();
    let _sandbox_ops_override = SandboxOpsOverrideGuard::set(&api, &files);
    let paths = &files.paths;
    let ops_file = paths.sandbox_ops_file();
    let pos_file = paths.telemetry_sandbox_ops_pos_file();

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    // Record one op, then fire several concurrent flushes. Pre-refactor a
    // tick + final could both read the same pos and race on save_position;
    // post-refactor the select serialises them, so only the first sees a
    // non-empty delta and only one HTTP POST happens.
    guest_telemetry::telemetry::record_sandbox_op("only_op", Duration::from_millis(5), true, None);

    let (r1, r2, r3) = tokio::join!(
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
    );
    r1.expect("flush 1 ok");
    r2.expect("flush 2 ok");
    r3.expect("flush 3 ok");

    telemetry.shutdown().await;

    // Pos file points at end of the file — no regression.
    let pos: u64 = std::fs::read_to_string(pos_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let file_len = std::fs::metadata(ops_file).unwrap().len();
    assert_eq!(pos, file_len, "pos must match file length, no regression");

    // Exactly one upload carried the delta — the others saw empty files.
    upload_mock.assert_calls_async(1).await;

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

/// Pins three invariants that have no other test coverage:
/// 1. `flush` propagates the upload's `Err` to the caller (rather than
///    swallowing it via `let _ = reply.send(...)`).
/// 2. The uploader loop **keeps running** after a failed upload — a
///    subsequent `flush` must succeed, not return `TelemetryUnavailable`.
/// 3. A failed upload does **not** advance the pos file, so the deferred
///    delta is re-included in the next attempt (and uploaded once
///    HTTP recovers).
#[tokio::test]
async fn flush_propagates_error_then_loop_recovers() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("flush-error-recovery").unwrap();
    let _sandbox_ops_override = SandboxOpsOverrideGuard::set(&api, &files);
    let paths = &files.paths;

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    // Force upload_telemetry to fire HTTP by writing a delta.
    guest_telemetry::telemetry::record_sandbox_op(
        "first_attempt_op",
        Duration::from_millis(5),
        true,
        None,
    );

    // First attempt: server returns 500.
    let fail_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(500);
    });

    let r1 = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert!(r1.is_err(), "flush must propagate the HTTP 500 to caller");
    fail_mock.assert_calls_async(1).await;
    fail_mock.delete_async().await;

    // Second attempt: server returns 200, AND must still see
    // `first_attempt_op` in the body because the failed first upload
    // did not advance the pos file.
    let success_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("first_attempt_op");
        then.status(200);
    });

    let r2 = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert!(
        r2.is_ok(),
        "loop must keep accepting flushes after a failed upload, got {r2:?}",
    );
    success_mock.assert_calls_async(1).await;

    telemetry.shutdown().await;

    success_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn flush_reports_position_persistence_status_after_upload_then_recovers() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("position-write-failure-upload").unwrap();
    let paths = &files.paths;
    let system_log = paths.system_log_file();
    let system_log_pos = paths.telemetry_system_log_pos_file();
    let metrics_log = paths.metrics_log_file();
    let metrics_pos = paths.telemetry_metrics_pos_file();
    let marker = "position-persistence-upload";
    let metric = serde_json::json!({
        "ts": "2026-09-01T00:00:00.000Z",
        "cpu": 91.25,
        "cpu_steal_percent": 12.5,
        "scheduled_lag_ms": 17,
        "mem_used": 1024,
        "mem_total": 2048,
        "disk_used": 4096,
        "disk_total": 8192,
        "control_cpu_usage_usec": 101,
        "control_cpu_nr_throttled": 2,
        "control_cpu_throttled_usec": 3,
        "workload_cpu_usage_usec": 201,
        "workload_cpu_nr_throttled": 4,
        "workload_cpu_throttled_usec": 5,
    });
    ensure_parent_dir(system_log);
    ensure_parent_dir(system_log_pos);
    std::fs::write(system_log, format!("{marker}\n")).expect("system log should be written");
    std::fs::write(metrics_log, format!("{metric}\n")).expect("metrics log should be written");
    std::fs::create_dir(system_log_pos).expect("position failure directory should be created");

    let request_bodies = Arc::new(Mutex::new(Vec::new()));
    let request_bodies_for_mock = Arc::clone(&request_bodies);
    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.respond_with(move |request| {
            request_bodies_for_mock
                .lock()
                .unwrap()
                .push(request.body_vec());
            http_status(200)
        });
    });

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    let first_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert_eq!(
        first_report.expect("upload should succeed despite position persistence failure"),
        guest_agent::telemetry::FlushReport {
            uploaded: true,
            position_persisted: false,
        },
    );
    upload_mock.assert_calls_async(1).await;
    {
        let request_bodies = request_bodies.lock().unwrap();
        assert_eq!(
            request_bodies.len(),
            1,
            "first flush should make one upload"
        );
        let payload: serde_json::Value = serde_json::from_slice(&request_bodies[0])
            .expect("first telemetry request should contain valid JSON");
        let expected_log = format!("{marker}\n");
        assert_eq!(payload["systemLog"].as_str(), Some(expected_log.as_str()));
        assert_eq!(payload["metrics"], serde_json::json!([metric]));
    }
    let persisted_metrics_pos: u64 = std::fs::read_to_string(metrics_pos)
        .expect("metrics position should persist after the earlier system position fails")
        .trim()
        .parse()
        .expect("metrics position should be numeric");
    assert_eq!(
        persisted_metrics_pos,
        std::fs::metadata(metrics_log)
            .expect("metrics metadata should be available")
            .len(),
        "a later advanced position must persist after an earlier position write fails"
    );

    std::fs::remove_dir(system_log_pos).expect("position failure directory should be removed");
    let second_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert_eq!(
        second_report.expect("flush should recover after the position path is restored"),
        guest_agent::telemetry::FlushReport {
            uploaded: true,
            position_persisted: true,
        },
    );
    upload_mock.assert_calls_async(2).await;
    {
        let request_bodies = request_bodies.lock().unwrap();
        assert_eq!(
            request_bodies.len(),
            2,
            "recovery should make a second upload"
        );
        let payload: serde_json::Value = serde_json::from_slice(&request_bodies[1])
            .expect("recovery telemetry request should contain valid JSON");
        let expected_log = format!("{marker}\n");
        assert_eq!(payload["systemLog"].as_str(), Some(expected_log.as_str()));
        assert_eq!(payload["metrics"], serde_json::json!([]));
    }

    telemetry.shutdown().await;

    let pos: u64 = std::fs::read_to_string(system_log_pos)
        .expect("system log telemetry position should be written after recovery")
        .trim()
        .parse()
        .expect("system log telemetry position should be numeric");
    assert_eq!(
        pos,
        std::fs::metadata(system_log)
            .expect("system log metadata should be available")
            .len(),
        "recovered position must match the source file length"
    );

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn flush_ignores_unadvanced_position_write_failures() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("unadvanced-position-write-failure").unwrap();
    let paths = &files.paths;
    let system_log = paths.system_log_file();
    let metrics_pos = paths.telemetry_metrics_pos_file();
    let marker = "unadvanced-position-write-failure";
    ensure_parent_dir(system_log);
    ensure_parent_dir(metrics_pos);
    std::fs::write(system_log, format!("{marker}\n")).expect("system log should be written");
    std::fs::create_dir(metrics_pos).expect("unadvanced position directory should be created");
    let system_log_guard = SystemLogOverrideGuard::set(system_log);

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    let first_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("system log upload should ignore an unadvanced metrics position");
    assert_eq!(
        first_report,
        guest_agent::telemetry::FlushReport {
            uploaded: true,
            position_persisted: true,
        },
    );

    let second_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("empty follow-up flush should remain successful");
    assert_eq!(
        second_report,
        guest_agent::telemetry::FlushReport {
            uploaded: false,
            position_persisted: true,
        },
    );
    upload_mock.assert_calls_async(1).await;

    telemetry.shutdown().await;
    drop(system_log_guard);
    std::fs::remove_dir(metrics_pos).expect("unadvanced position directory should be removed");
    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn skip_only_metrics_progress_saves_position_without_posting_empty_payload() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("skip-only-metrics").unwrap();
    let paths = &files.paths;

    let metrics_file = paths.metrics_log_file();
    let metrics_pos_file = paths.telemetry_metrics_pos_file();
    ensure_parent_dir(metrics_file);
    assert!(
        std::fs::write(metrics_file, "x".repeat(TELEMETRY_DELTA_READ_LIMIT + 1)).is_ok(),
        "oversized metrics log should be written",
    );

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("skip-only flush should succeed without HTTP");
    telemetry.shutdown().await;

    upload_mock.assert_calls_async(0).await;
    let pos_text = std::fs::read_to_string(metrics_pos_file)
        .expect("metrics telemetry position should be written");
    let pos: u64 = pos_text
        .trim()
        .parse()
        .expect("metrics telemetry position should be numeric");
    assert_eq!(pos, TELEMETRY_DELTA_READ_LIMIT as u64);

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn skip_only_flush_reports_position_persistence_status_then_recovers() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("position-write-failure-skip-only").unwrap();
    let paths = &files.paths;
    let metrics_file = paths.metrics_log_file();
    let metrics_pos_file = paths.telemetry_metrics_pos_file();
    ensure_parent_dir(metrics_file);
    ensure_parent_dir(metrics_pos_file);
    assert!(
        std::fs::write(metrics_file, "x".repeat(TELEMETRY_DELTA_READ_LIMIT + 1)).is_ok(),
        "oversized metrics log should be written",
    );
    std::fs::create_dir(metrics_pos_file).expect("position failure directory should be created");

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    let first_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert_eq!(
        first_report.expect("skip-only progress should remain a successful flush"),
        guest_agent::telemetry::FlushReport {
            uploaded: false,
            position_persisted: false,
        },
    );
    upload_mock.assert_calls_async(0).await;

    std::fs::remove_dir(metrics_pos_file).expect("position failure directory should be removed");
    let second_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert_eq!(
        second_report.expect("skip-only flush should recover after the position path is restored"),
        guest_agent::telemetry::FlushReport {
            uploaded: false,
            position_persisted: true,
        },
    );
    upload_mock.assert_calls_async(0).await;

    // The bounded live read consumes the oversized entry in two chunks after
    // the failed position write falls back to offset zero.
    let third_report = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert_eq!(
        third_report.expect("skip-only tail flush should complete recovery"),
        guest_agent::telemetry::FlushReport {
            uploaded: false,
            position_persisted: true,
        },
    );
    upload_mock.assert_calls_async(0).await;

    telemetry.shutdown().await;

    let pos: u64 = std::fs::read_to_string(metrics_pos_file)
        .expect("metrics telemetry position should be written after recovery")
        .trim()
        .parse()
        .expect("metrics telemetry position should be numeric");
    assert_eq!(
        pos,
        std::fs::metadata(metrics_file)
            .expect("metrics metadata should be available")
            .len(),
        "recovered position must match the source file length"
    );

    upload_mock.delete_async().await;
    remove_telemetry_files(paths);
}

#[tokio::test]
async fn oversized_system_log_uploads_marker_without_raw_line_fragment() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("oversized-system-log").unwrap();
    let paths = &files.paths;

    let system_log = paths.system_log_file();
    let system_log_pos_file = paths.telemetry_system_log_pos_file();
    let raw_token = "raw-secret-token";
    ensure_parent_dir(system_log);
    assert!(
        std::fs::write(
            system_log,
            raw_token.repeat((TELEMETRY_DELTA_READ_LIMIT / raw_token.len()) + 1),
        )
        .is_ok(),
        "oversized system log should be written",
    );

    let raw_fragment_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(raw_token);
        then.status(500);
    });
    let marker_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(OVERSIZED_SYSTEM_LOG_LINE_MARKER_FRAGMENT);
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "test-run-001".to_string(),
        paths,
        masker,
        http_client!(),
    );

    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("oversized system log marker upload should succeed");
    telemetry.shutdown().await;

    raw_fragment_mock.assert_calls_async(0).await;
    marker_mock.assert_calls_async(1).await;
    let pos_text = std::fs::read_to_string(system_log_pos_file)
        .expect("system log telemetry position should be written");
    let pos: u64 = pos_text
        .trim()
        .parse()
        .expect("system log telemetry position should be numeric");
    assert_eq!(pos, TELEMETRY_DELTA_READ_LIMIT as u64);

    raw_fragment_mock.delete_async().await;
    marker_mock.delete_async().await;
    remove_telemetry_files(paths);
}

fn oom_fixture() -> Result<guest_contracts::oom_evidence::OomEvidence, serde_json::Error> {
    serde_json::from_str(include_str!(
        "../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
    ))
}

#[tokio::test]
async fn urgent_oom_bypasses_log_backlog_and_keeps_live_positions() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let files = ExplicitTelemetryFiles::new("urgent-oom").unwrap();
    let paths = &files.paths;
    guest_agent::paths::write_private(paths.system_log_file(), "old log\n".repeat(100_000))
        .unwrap();
    let urgent = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("oomEvidence")
            .body_excludes("systemLog");
        then.status(200).json_body(
            serde_json::json!({"success":true,"id":"urgent-run","oomEvidenceVersion":1}),
        );
    });
    let normal = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("systemLog");
        then.status(200);
    });
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "urgent-run".into(),
        paths,
        Arc::new(SecretMasker::from_raw("")),
        http_client!(),
    );
    telemetry.incident_reporter().record(oom_fixture().unwrap());
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .unwrap();
    urgent.assert_calls_async(1).await;
    let position = std::fs::read_to_string(paths.telemetry_system_log_pos_file())
        .unwrap()
        .parse::<usize>()
        .unwrap();
    assert!(position <= TELEMETRY_DELTA_READ_LIMIT);
    assert!(position < std::fs::metadata(paths.system_log_file()).unwrap().len() as usize);
    let retained =
        std::fs::read_to_string(format!("{}.oom-evidence.json", paths.metrics_log_file())).unwrap();
    assert_eq!(
        serde_json::from_str::<guest_contracts::oom_evidence::OomEvidence>(&retained)
            .unwrap()
            .incidents,
        oom_fixture().unwrap().incidents
    );
    telemetry.incident_reporter().record(oom_fixture().unwrap());
    telemetry.final_flush_and_shutdown().await.unwrap();
    urgent.assert_calls_async(1).await;
    normal.assert_calls_async(2).await;
    urgent.delete_async().await;
    normal.delete_async().await;
}

#[tokio::test]
async fn urgent_oom_retries_transient_failure_and_retains_unacknowledged_old_receiver_payload() {
    for acknowledges in [true, false] {
        let api = SharedApiMock::new().await;
        let server = api.server();
        let files = ExplicitTelemetryFiles::new("urgent-retry").unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let requests = calls.clone();
        let upload = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("oomEvidence");
            then.respond_with(move |_| {
                let attempt = requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = if attempt > 0 && acknowledges {
                    r#"{"success":true,"id":"retry","oomEvidenceVersion":1}"#
                } else {
                    r#"{"success":true,"id":"retry"}"#
                };
                json_http_response(
                    if attempt == 0 { 503 } else { 200 },
                    serde_json::from_str(body).unwrap(),
                )
            });
        });
        let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
            "retry".into(),
            &files.paths,
            Arc::new(SecretMasker::from_raw("")),
            http_client!(),
        );
        telemetry.incident_reporter().record(oom_fixture().unwrap());
        telemetry
            .flush(guest_agent::telemetry::UploadMode::Live)
            .await
            .unwrap();
        telemetry.incident_reporter().record(oom_fixture().unwrap());
        telemetry.shutdown().await;
        upload.assert_calls_async(2).await;
        assert!(
            std::fs::metadata(format!(
                "{}.oom-evidence.json",
                files.paths.metrics_log_file()
            ))
            .unwrap()
            .len()
                > 0
        );
        upload.delete_async().await;
    }
}

#[tokio::test]
async fn urgent_oom_arrives_while_normal_http_response_is_held_open() {
    use tokio::io::AsyncWriteExt;
    // The private HTTP listener still shares process-global telemetry paths.
    let _api = SharedApiMock::new().await;
    let files = ExplicitTelemetryFiles::new("urgent-inflight").unwrap();
    guest_agent::paths::write_private(files.paths.system_log_file(), "normal backlog\n").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = guest_agent::http::HttpClient::with_api_config(
        format!("http://{}", listener.local_addr().unwrap()),
        "test-token",
        "",
        "test-session",
        Duration::ZERO,
    )
    .unwrap();
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "inflight".into(),
        &files.paths,
        Arc::new(SecretMasker::from_raw("")),
        http,
    );
    let reporter = telemetry.incident_reporter();
    let flush = tokio::spawn(async move {
        telemetry
            .flush(guest_agent::telemetry::UploadMode::Live)
            .await
            .unwrap();
        telemetry
    });
    let (mut normal, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        super::http_client::read_raw_request(&mut normal),
    )
    .await
    .unwrap()
    .unwrap();
    reporter.record(oom_fixture().unwrap());
    // The first response has not been sent. A distinct incident request must
    // arrive before that response is released, with no dependency on a tick.
    let (mut urgent, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        super::http_client::read_raw_request(&mut urgent),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!flush.is_finished());
    let body = r#"{"success":true,"id":"inflight","oomEvidenceVersion":1}"#;
    urgent
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    normal
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .await
        .unwrap();
    let telemetry = tokio::time::timeout(Duration::from_secs(5), flush)
        .await
        .unwrap()
        .unwrap();
    telemetry.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(files.paths.telemetry_system_log_pos_file()).unwrap(),
        "15"
    );
}

#[tokio::test]
async fn urgent_oom_stalled_http_has_two_bounded_attempts_and_retains_evidence() {
    let _api = SharedApiMock::new().await;
    let files = ExplicitTelemetryFiles::new("urgent-stalled").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = guest_agent::http::HttpClient::with_api_config(
        format!("http://{}", listener.local_addr().unwrap()),
        "test-token",
        "",
        "test-session",
        Duration::ZERO,
    )
    .unwrap();
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        "stalled".into(),
        &files.paths,
        Arc::new(SecretMasker::from_raw("")),
        http,
    );
    telemetry.incident_reporter().record(oom_fixture().unwrap());
    let server = tokio::spawn(async move {
        let mut held = Vec::new();
        for _ in 0..2 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            tokio::time::timeout(
                Duration::from_secs(2),
                super::http_client::read_raw_request(&mut stream),
            )
            .await
            .unwrap()
            .unwrap();
            held.push(stream);
        }
        (listener, held)
    });
    tokio::time::timeout(Duration::from_secs(6), telemetry.final_flush_and_shutdown())
        .await
        .unwrap()
        .unwrap();
    let (listener, held) = server.await.unwrap();
    assert_eq!(held.len(), 2);
    assert!(
        std::fs::metadata(format!(
            "{}.oom-evidence.json",
            files.paths.metrics_log_file()
        ))
        .unwrap()
        .len()
            > 0
    );
    drop(listener);
}
