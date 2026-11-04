use super::*;
use tracing::{Level, instrument::WithSubscriber};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use runner_provider::http::HttpClientConfig;

fn http_client() -> HttpClient {
    http_client_for_api_url("http://localhost")
}

pub(super) fn http_client_for_api_url(api_url: &str) -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url: api_url.to_string(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap()
}

#[tokio::test]
async fn home_operations_use_the_existing_run_payload_and_first_run_context() {
    use runner_host::home_observation::{
        HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
    };
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let run_id = RunId::new_v4();
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        run_id,
        "sandbox-operation-token".into(),
        Some("runner.example.test".into()),
    );
    telemetry.set_first_run(Some(false));
    let mut home = HomeObservation::new(Kind::Publication, Outcome::Published);
    home.run_id = Some(run_id);
    home.reuse_key = Some("thread:known".into());
    home.image_generation = Some(run_id.to_string());
    home.allocated_bytes = Some(0);
    home.reason = Some("synced_commit".into());
    telemetry.observe_home(home);
    telemetry.flush().await;
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /api/webhooks/agent/telemetry "));
    let body: serde_json::Value =
        serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["runId"], run_id.to_string());
    let op = &body["sandboxOperations"][0];
    assert_eq!(op["action_type"], "runner_home_image_publication");
    assert_eq!(op["outcome"], "published");
    assert_eq!(op["reason"], "synced_commit");
    assert_eq!(op["reuse_key"], "thread:known");
    assert_eq!(op["image_generation"], run_id.to_string());
    assert_eq!(op["is_first_run"], false);
    assert_eq!(op["allocated_bytes"], 0);
    assert!(op.get("run_id").is_none());
}

#[tokio::test]
async fn home_gc_operations_use_runner_credentials_and_omit_unknown_run_context() {
    use runner_host::home_observation::{
        HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
    };
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let telemetry = JobTelemetry::new_runner(
        http_client_for_api_url(&server.url()),
        "host-operation-token".into(),
        None,
    );
    let reporter = telemetry.reporter();
    let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
    record.home = Some(HomeObservation::new(Kind::Removal, Outcome::Deleted));
    reporter.record(record);
    telemetry.flush().await;
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0]
            .to_lowercase()
            .contains("authorization: bearer host-operation-token")
    );
    let body: serde_json::Value =
        serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert!(body.get("runId").is_none());
    let op = &body["sandboxOperations"][0];
    assert_eq!(op["action_type"], "runner_home_image_removal");
    assert_eq!(op["outcome"], "deleted");
    assert!(op.get("run_id").is_none());
    assert!(op.get("is_first_run").is_none());
}

#[tokio::test]
async fn home_inventory_and_admission_fields_survive_the_existing_host_http_path() {
    use runner_host::home_observation::{
        HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
    };
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let telemetry = JobTelemetry::new_runner(
        http_client_for_api_url(&server.url()),
        "host-operation-token".into(),
        None,
    );
    let reporter = telemetry.reporter();
    let runner_id = uuid::Uuid::new_v4().to_string();
    let run_id = RunId::new_v4();
    let mut loading = HomeObservation::new(Kind::Inventory, Outcome::Loading);
    loading.runner_id = Some(runner_id.clone());
    loading.runner_heartbeat_generation = Some(7);
    loading.inventory_loaded = Some(false);
    let mut record = SandboxOpRecord::new("runner_home_inventory", Duration::ZERO, true, None);
    record.home = Some(loading);
    reporter.record(record);
    let mut inventory = HomeObservation::new(Kind::Inventory, Outcome::Assembled);
    inventory.runner_id = Some(runner_id.clone());
    inventory.runner_heartbeat_generation = Some(7);
    inventory.inventory_loaded = Some(true);
    inventory.inventory_observed_states = Some(0);
    inventory.inventory_output_states = Some(0);
    inventory.inventory_omitted_states = Some(0);
    let mut record = SandboxOpRecord::new("runner_home_inventory", Duration::ZERO, true, None);
    record.home = Some(inventory);
    reporter.record(record);
    let mut admission = HomeObservation::new(Kind::Admission, Outcome::Deferred);
    admission.runner_id = Some(runner_id.clone());
    admission.runner_heartbeat_generation = Some(7);
    admission.run_id = Some(run_id);
    admission.reuse_key = Some("thread:known".into());
    admission.profile_name = Some("vm0/default".into());
    admission.reason = Some("capacity_exhausted".into());
    let mut record = SandboxOpRecord::new("runner_home_admission", Duration::ZERO, true, None);
    record.home = Some(admission);
    reporter.record(record);
    telemetry.flush().await;
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    let body: serde_json::Value =
        serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert!(body.get("runId").is_none());
    let ops = body["sandboxOperations"].as_array().unwrap();
    assert_eq!(ops.len(), 3);
    assert_eq!(ops[0]["action_type"], "runner_home_inventory");
    assert_eq!(ops[0]["outcome"], "loading");
    assert_eq!(ops[0]["inventory_loaded"], false);
    assert_eq!(ops[1]["action_type"], "runner_home_inventory");
    assert_eq!(ops[1]["outcome"], "assembled");
    assert_eq!(ops[1]["inventory_loaded"], true);
    for field in [
        "inventory_observed_states",
        "inventory_output_states",
        "inventory_omitted_states",
    ] {
        assert!(ops[0].get(field).is_none());
        assert_eq!(ops[1][field], 0);
    }
    assert_eq!(ops[2]["action_type"], "runner_home_admission");
    assert_eq!(ops[2]["outcome"], "deferred");
    assert_eq!(ops[2]["reason"], "capacity_exhausted");
    assert_eq!(ops[2]["run_id"], run_id.to_string());
    assert_eq!(ops[2]["reuse_key"], "thread:known");
    for op in ops {
        assert_eq!(op["runner_id"], runner_id);
        assert_eq!(op["runner_heartbeat_generation"], 7);
        assert!(op.get("is_first_run").is_none());
    }
    assert!(ops[0].get("run_id").is_none());
    assert!(ops[1].get("run_id").is_none());
    assert!(ops[2].get("inventory_loaded").is_none());
}

#[tokio::test]
async fn home_operations_buffer_while_the_existing_api_transport_is_held() {
    use runner_host::home_observation::{
        HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
    };
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: release_rx,
            response: json_response("200 OK", r#"{"success":true}"#),
        },
        RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
    ])
    .await;
    let telemetry = JobTelemetry::new_runner(
        http_client_for_api_url(&server.url()),
        "host-operation-token".into(),
        None,
    );
    let reporter = telemetry.reporter();
    for _ in 0..50 {
        let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
        record.home = Some(HomeObservation::new(Kind::Publication, Outcome::Published));
        reporter.record(record);
    }
    let first = server.next_request("host operation batch").await;
    let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
    record.home = Some(HomeObservation::new(Kind::Preservation, Outcome::Retained));
    reporter.record(record);
    release_tx.send(()).unwrap();
    telemetry.flush().await;
    let second = server
        .next_request("operation buffered behind the held request")
        .await;
    let first: serde_json::Value =
        serde_json::from_str(first.split_once("\r\n\r\n").unwrap().1).unwrap();
    let second: serde_json::Value =
        serde_json::from_str(second.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(first["sandboxOperations"].as_array().unwrap().len(), 50);
    assert_eq!(second["sandboxOperations"].as_array().unwrap().len(), 1);
    assert_eq!(second["sandboxOperations"][0]["outcome"], "retained");
    server.assert_finished().await;
}

#[tokio::test]
async fn host_operations_resume_after_a_full_buffer_and_completed_api_sends() {
    use runner_host::home_observation::{
        HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
    };
    let expected = HOST_IN_FLIGHT_LIMIT * HOST_BATCH_SIZE + HOST_PENDING_LIMIT + 1;
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut actions = vec![RawHttpAction::WaitThenRespond {
        release: release_rx,
        response: json_response("200 OK", r#"{"success":true}"#),
    }];
    actions.extend(
        (1..expected.div_ceil(HOST_BATCH_SIZE))
            .map(|_| RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#))),
    );
    let mut server = RawHttpTestServer::spawn(actions).await;
    let telemetry = JobTelemetry::new_runner(
        http_client_for_api_url(&server.url()),
        "host-operation-token".into(),
        None,
    );
    let reporter = telemetry.reporter();
    let record = || {
        let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
        record.home = Some(HomeObservation::new(Kind::Removal, Outcome::Deleted));
        record
    };
    for _ in 0..HOST_IN_FLIGHT_LIMIT * HOST_BATCH_SIZE {
        reporter.record(record());
    }
    let first = server.next_request("held host operations").await;
    for _ in 0..HOST_PENDING_LIMIT + 2 {
        reporter.record(record());
    }
    // Await the actual outstanding sends without closing the collector, so
    // the next callback exercises recovery from a full bounded buffer.
    let in_flight = {
        let mut collector = telemetry.collector.lock().unwrap();
        std::mem::take(&mut collector.as_mut().unwrap().in_flight_flushes)
    };
    release_tx.send(()).unwrap();
    drain_in_flight_flushes(None, in_flight).await;
    let mut resumed = record();
    resumed.home.as_mut().unwrap().reason = Some("resumed_after_backpressure".into());
    reporter.record(resumed);
    telemetry.flush().await;
    let mut requests = vec![first];
    requests.extend(server.assert_finished_with_requests().await);
    let operations: Vec<serde_json::Value> = requests
        .iter()
        .flat_map(|request| {
            let body: serde_json::Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            let ops = body["sandboxOperations"].as_array().unwrap();
            assert!(ops.len() <= HOST_BATCH_SIZE);
            ops.clone()
        })
        .collect();
    assert_eq!(operations.len(), expected);
    assert_eq!(
        operations
            .iter()
            .filter(|op| op["reason"] == "resumed_after_backpressure")
            .count(),
        1
    );
}

fn oom_evidence_for_test() -> guest_contracts::oom_evidence::OomEvidence {
    serde_json::from_str(include_str!(
        "../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
    ))
    .unwrap()
}

#[test]
fn oom_evidence_upload_failure_keeps_timeout_distinct_from_transport() {
    assert_eq!(
        OomEvidenceUploadFailure::from_api_failure_kind(crate::error::ApiFailureKind::Timeout,),
        OomEvidenceUploadFailure::Timeout
    );
    assert_eq!(
        OomEvidenceUploadFailure::from_api_failure_kind(crate::error::ApiFailureKind::Request,),
        OomEvidenceUploadFailure::Transport
    );
}

#[test]
fn sandbox_op_serializes_base_observations() {
    let op = SandboxOp {
        ts: "2026-01-15T10:00:00+00:00".to_string(),
        action_type: "sandbox_create".to_string(),
        duration_ms: 1500,
        success: true,
        error: None,
        outcome: None,
        reason: None,
        runner_startup_path: None,
        is_first_run: None,
        reuse_key: None,
        cache_key: None,
        profile_name: None,
        image_generation: None,
        home_reuse_result: None,
        sandbox_reuse_result: None,
        runner_pre_spawn_concurrency_bucket: None,
        runner_resource_budget_vcpu_utilization_bucket: None,
        runner_resource_budget_memory_utilization_bucket: None,
        runner_resource_budget_lease_count_bucket: None,
        dns_readiness: None,
        storage_batch: None,
        archive_size_mismatch: None,
        archive_connection_attempt: None,
        home: None,
    };
    let json = serde_json::to_value(&op).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "ts": "2026-01-15T10:00:00+00:00",
            "action_type": "sandbox_create",
            "duration_ms": 1500,
            "success": true,
        })
    );
}

#[test]
fn bounded_outcome_serializes_fixed_dimensions() {
    let mut telemetry = JobTelemetry::new(
        http_client(),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    telemetry.record_bounded_outcome(
        "storage_cache_fresh_delivery_scan_groups",
        true,
        "17_plus",
        Some("prepared"),
    );

    assert_eq!(
        serde_json::to_value(&telemetry.pending.operations()[0]).unwrap(),
        serde_json::json!({
            "ts": telemetry.pending.operations()[0].ts.clone(),
            "action_type": "storage_cache_fresh_delivery_scan_groups",
            "duration_ms": 0,
            "success": true,
            "outcome": "17_plus",
            "reason": "prepared",
        })
    );
}

#[test]
fn storage_batch_telemetry_subtracts_guest_server_duration() {
    let mut telemetry = JobTelemetry::new(
        http_client(),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    telemetry.record_storage_apply_batch(
        Duration::from_millis(42),
        true,
        Some(31),
        &sandbox::StorageManifestTiming::default(),
        StorageBatchDimensions {
            transport_position: "dedicated_middle",
            manifest_size_bucket: "32_to_64_kib",
            payload_size_bucket: "none",
        },
    );

    let batches = telemetry.pending_storage_batch_payloads();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0]["duration_ms"], 42);
    assert_eq!(batches[0]["storage_batch_guest_duration_ms"], 31);
    assert_eq!(batches[0]["storage_batch_outer_residual_ms"], 11);
    assert_eq!(batches[0]["storage_batch_timing"], "paired");
}

#[test]
fn storage_host_telemetry_preserves_coverage_units_and_missing_phases() {
    use sandbox::{StorageManifestRequestTiming, StorageManifestTiming};
    let mut telemetry = JobTelemetry::new(
        http_client(),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    let dimensions = || StorageBatchDimensions {
        transport_position: "dedicated_middle",
        manifest_size_bucket: "32_to_64_kib",
        payload_size_bucket: "64_to_256_kib",
    };
    let full = StorageManifestTiming {
        admission: Some(Duration::from_millis(1)),
        request: StorageManifestRequestTiming {
            setup: Some(Duration::from_millis(2)),
            frame_builder_wait: Some(Duration::from_millis(3)),
            frame_encode: Some(Duration::from_millis(4)),
            writer_wait: Some(Duration::from_millis(5)),
            frame_write: Some(Duration::from_millis(6)),
            response_wait: Some(Duration::from_millis(7)),
            result_decode: Some(Duration::from_millis(8)),
            guest: sandbox::StorageManifestGuestTiming {
                request_ownership_us: Some(0),
                worker_wait_us: Some(9_007_199_254_740_991),
                response_prepare_us: Some(42),
            },
            resources: sandbox::StorageManifestResources {
                containment_wall_us: Some(1),
                collection_us: Some(0),
                cpu_usage_us: Some(2),
                cpu_throttled_us: Some(0),
                memory_peak_bytes: Some(9_007_199_254_740_991),
                memory_events_oom: Some(0),
                memory_events_oom_kill: Some(0),
                memory_events_oom_group_kill: Some(0),
                pids_events_max: Some(0),
            },
        },
        resource_log: Some(Duration::from_millis(9)),
    };
    telemetry.record_storage_apply_batch(
        Duration::from_millis(100),
        true,
        Some(0),
        &full,
        dimensions(),
    );
    let partial = StorageManifestTiming {
        admission: Some(Duration::ZERO),
        request: StorageManifestRequestTiming {
            setup: Some(Duration::from_nanos(1)),
            guest: sandbox::StorageManifestGuestTiming {
                request_ownership_us: Some(9_007_199_254_740_992),
                worker_wait_us: Some(0),
                ..sandbox::StorageManifestGuestTiming::default()
            },
            resources: sandbox::StorageManifestResources {
                cpu_usage_us: Some(0),
                memory_peak_bytes: Some(u64::MAX),
                ..sandbox::StorageManifestResources::default()
            },
            result_decode: Some(Duration::from_millis(u64::from(u32::MAX) + 1)),
            ..StorageManifestRequestTiming::default()
        },
        ..StorageManifestTiming::default()
    };
    telemetry.record_storage_apply_batch(
        Duration::from_millis(100),
        false,
        None,
        &partial,
        dimensions(),
    );
    telemetry.record_storage_apply_batch(
        Duration::ZERO,
        true,
        None,
        &StorageManifestTiming::default(),
        dimensions(),
    );
    let batches = telemetry.pending_storage_batch_payloads();
    assert_eq!(batches[0]["storage_batch_host_timing"], "complete");
    assert_eq!(batches[0]["storage_batch_guest_timing"], "complete");
    assert_eq!(batches[0]["storage_batch_resources"], "complete");
    assert_eq!(batches[0]["storage_batch_guest_request_ownership_us"], 0);
    assert_eq!(
        batches[0]["storage_batch_guest_worker_wait_us"],
        9_007_199_254_740_991_u64
    );
    assert_eq!(batches[0]["storage_batch_guest_response_prepare_us"], 42);
    assert_eq!(batches[0]["storage_batch_resource_collection_us"], 0);
    assert_eq!(
        batches[0]["storage_batch_memory_peak_bytes"],
        9_007_199_254_740_991_u64
    );
    for (field, value) in [
        ("storage_batch_admission_ms", 1),
        ("storage_batch_request_setup_ms", 2),
        ("storage_batch_frame_builder_wait_ms", 3),
        ("storage_batch_frame_encode_ms", 4),
        ("storage_batch_writer_wait_ms", 5),
        ("storage_batch_frame_write_ms", 6),
        ("storage_batch_response_wait_ms", 7),
        ("storage_batch_result_decode_ms", 8),
        ("storage_batch_resource_log_ms", 9),
    ] {
        assert_eq!(batches[0][field], value);
    }
    assert_eq!(
        batches[0]["storage_batch_payload_size_bucket"],
        "64_to_256_kib"
    );
    assert_eq!(batches[1]["storage_batch_host_timing"], "partial");
    assert_eq!(batches[1]["storage_batch_guest_timing"], "partial");
    assert_eq!(batches[1]["storage_batch_resources"], "partial");
    assert_eq!(batches[1]["storage_batch_guest_worker_wait_us"], 0);
    assert_eq!(batches[1]["storage_batch_cpu_usage_us"], 0);
    assert!(
        batches[1]
            .get("storage_batch_guest_request_ownership_us")
            .is_none()
    );
    assert!(batches[1].get("storage_batch_memory_peak_bytes").is_none());
    assert_eq!(batches[1]["success"], false);
    assert_eq!(batches[1]["storage_batch_admission_ms"], 0);
    assert_eq!(batches[1]["storage_batch_request_setup_ms"], 0);
    assert!(batches[1].get("storage_batch_frame_write_ms").is_none());
    assert!(batches[1].get("storage_batch_result_decode_ms").is_none());
    assert!(batches[1].get("storage_batch_resource_log_ms").is_none());
    assert_eq!(batches[2]["storage_batch_host_timing"], "unavailable");
    assert_eq!(batches[2]["storage_batch_guest_timing"], "unavailable");
    assert_eq!(batches[2]["storage_batch_resources"], "unavailable");
    assert!(batches[2].get("storage_batch_admission_ms").is_none());
}

#[tokio::test]
async fn record_with_outcome_is_sent_in_flush_payload() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes(r#""action_type":"runner_host_physical_park_balloon_settle""#)
                .body_includes(r#""duration_ms":125"#)
                .body_includes(r#""success":true"#)
                .body_includes(r#""outcome":"target_reached""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.base_url()),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    telemetry.record_with_outcome(
        "runner_host_physical_park_balloon_settle",
        Duration::from_millis(125),
        true,
        None,
        Some("target_reached"),
    );
    telemetry.flush().await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn telemetry_uses_the_callers_runner_version() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes(r#""runnerVersion":"9.8.7""#);
            then.status(200);
        })
        .await;
    let http = HttpClient::new(HttpClientConfig {
        api_url: server.base_url(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: "9.8.7",
    })
    .unwrap();
    let mut telemetry = JobTelemetry::new(
        http,
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    telemetry.record("version_probe", Duration::ZERO, true, None);
    telemetry.flush().await;

    telemetry_mock.assert_calls_async(1).await;
}

#[test]
fn api_startup_boundaries_serialize_bounded_startup_metadata() {
    let mut telemetry = JobTelemetry::new(
        http_client(),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    let budget = Arc::new(ResourceBudget::new(4, 400, 1.0, 0));
    let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 300).unwrap();
    let mut attribution =
        RunnerPreSpawnAttribution::new(RunnerPreSpawnConcurrencyBucket::ThreeToFour);
    attribution.set_resource_budget_occupancy(RunnerResourceBudgetOccupancy::capture(&budget));
    telemetry.start_runner_pre_spawn_attribution(attribution);
    telemetry.record_api_to_spawn(
        Duration::from_millis(125),
        RunnerStartupPath::Home,
        SandboxReuseResult::PoolMiss,
    );
    telemetry.record_api_to_agent_ready(
        Duration::from_millis(150),
        RunnerStartupPath::Home,
        SandboxReuseResult::PoolMiss,
    );

    assert_eq!(
        serde_json::to_value(&telemetry.pending.operations()[0]).unwrap(),
        serde_json::json!({
            "ts": telemetry.pending.operations()[0].ts.clone(),
            "action_type": "api_to_spawn",
            "duration_ms": 125,
            "success": true,
            "runner_startup_path": "home",
            "sandbox_reuse_result": "poolMiss",
            "runner_pre_spawn_concurrency_bucket": "3_4",
            "runner_resource_budget_vcpu_utilization_bucket": "51_75",
            "runner_resource_budget_memory_utilization_bucket": "51_75",
            "runner_resource_budget_lease_count_bucket": "1",
        })
    );
    assert_eq!(
        serde_json::to_value(&telemetry.pending.operations()[1]).unwrap(),
        serde_json::json!({
            "ts": telemetry.pending.operations()[1].ts.clone(),
            "action_type": "api_to_agent_ready",
            "duration_ms": 150,
            "success": true,
            "runner_startup_path": "home",
            "sandbox_reuse_result": "poolMiss",
            "runner_pre_spawn_concurrency_bucket": "3_4",
            "runner_resource_budget_vcpu_utilization_bucket": "51_75",
            "runner_resource_budget_memory_utilization_bucket": "51_75",
            "runner_resource_budget_lease_count_bucket": "1",
        })
    );
}

#[test]
fn resource_budget_occupancy_uses_fixed_buckets() {
    for (allocated, effective, expected) in [
        (
            0,
            0,
            RunnerResourceBudgetUtilizationBucket::ZeroToTwentyFive,
        ),
        (1, 0, RunnerResourceBudgetUtilizationBucket::OverOneHundred),
        (
            25,
            100,
            RunnerResourceBudgetUtilizationBucket::ZeroToTwentyFive,
        ),
        (
            26,
            100,
            RunnerResourceBudgetUtilizationBucket::TwentySixToFifty,
        ),
        (
            50,
            100,
            RunnerResourceBudgetUtilizationBucket::TwentySixToFifty,
        ),
        (
            51,
            100,
            RunnerResourceBudgetUtilizationBucket::FiftyOneToSeventyFive,
        ),
        (
            75,
            100,
            RunnerResourceBudgetUtilizationBucket::FiftyOneToSeventyFive,
        ),
        (
            76,
            100,
            RunnerResourceBudgetUtilizationBucket::SeventySixToOneHundred,
        ),
        (
            100,
            100,
            RunnerResourceBudgetUtilizationBucket::SeventySixToOneHundred,
        ),
        (
            101,
            100,
            RunnerResourceBudgetUtilizationBucket::OverOneHundred,
        ),
    ] {
        assert_eq!(
            RunnerResourceBudgetUtilizationBucket::from_allocation(allocated, effective),
            expected,
        );
    }

    for (count, expected) in [
        (0, RunnerResourceBudgetLeaseCountBucket::Zero),
        (1, RunnerResourceBudgetLeaseCountBucket::One),
        (2, RunnerResourceBudgetLeaseCountBucket::Two),
        (3, RunnerResourceBudgetLeaseCountBucket::ThreeToFour),
        (4, RunnerResourceBudgetLeaseCountBucket::ThreeToFour),
        (5, RunnerResourceBudgetLeaseCountBucket::FiveToEight),
        (8, RunnerResourceBudgetLeaseCountBucket::FiveToEight),
        (9, RunnerResourceBudgetLeaseCountBucket::NinePlus),
    ] {
        assert_eq!(
            RunnerResourceBudgetLeaseCountBucket::from_count(count),
            expected,
        );
    }
}

#[test]
fn telemetry_payload_includes_canonical_attribution() {
    let payload = TelemetryPayload {
        run_id: Some("abc-123".to_string()),
        runner_hostname: Some("prod-1.aws.vm3.ai".to_string()),
        runner_version: RUNNER_VERSION,
        sandbox_operations: vec![],
    };

    assert_eq!(
        serde_json::to_value(&payload).unwrap(),
        serde_json::json!({
            "runId": "abc-123",
            "runnerHostname": "prod-1.aws.vm3.ai",
            "runnerVersion": RUNNER_VERSION,
            "sandboxOperations": [],
        })
    );
}

#[test]
fn new_creates_empty_telemetry() {
    let http = http_client();
    let telemetry = JobTelemetry::new(
        http,
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    assert!(telemetry.pending.is_empty());
    assert!(telemetry.pending.age().is_none());
    assert!(telemetry.in_flight_flushes.is_empty());
}

#[test]
fn record_buffers_ops() {
    let http = http_client();
    let mut telemetry = JobTelemetry::new(
        http,
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );

    telemetry.record("sandbox_create", Duration::from_millis(500), true, None);
    telemetry.record(
        "agent_execute",
        Duration::from_secs(10),
        false,
        Some("timeout"),
    );

    assert_eq!(telemetry.pending.len(), 2);
    assert_eq!(
        telemetry.pending.operations()[0].action_type,
        "sandbox_create"
    );
    assert_eq!(telemetry.pending.operations()[0].duration_ms, 500);
    assert!(telemetry.pending.operations()[0].success);
    assert!(telemetry.pending.operations()[0].error.is_none());
    assert_eq!(
        telemetry.pending.operations()[1].action_type,
        "agent_execute"
    );
    assert!(!telemetry.pending.operations()[1].success);
    assert_eq!(
        telemetry.pending.operations()[1].error.as_deref(),
        Some("timeout")
    );
    assert!(telemetry.pending.age().is_some());
}

#[test]
fn record_saturates_large_duration() {
    let http = http_client();
    let mut telemetry = JobTelemetry::new(
        http,
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );

    telemetry.record("huge_op", Duration::MAX, true, None);

    assert_eq!(telemetry.pending.len(), 1);
    assert_eq!(telemetry.pending.operations()[0].duration_ms, u64::MAX);
}

#[tokio::test]
async fn record_within_threshold_does_not_flush() {
    let http = http_client();
    let mut telemetry = JobTelemetry::new(
        http,
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );

    telemetry.record("op1", Duration::from_millis(10), true, None);
    telemetry.record("op2", Duration::from_millis(10), true, None);

    assert_eq!(telemetry.pending_ops_snapshot().len(), 2);
    assert!(telemetry.pending.age().is_some());
}

#[tokio::test]
async fn telemetry_flush_preserves_captured_operation_timestamp() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes(r#""ts":"2026-08-11T10:20:30.456Z""#)
                .body_includes(r#""action_type":"concurrent_operation""#)
                .body_includes(r#""runnerHostname":"prod-1.aws.vm3.ai""#)
                .body_includes(format!(r#""runnerVersion":"{RUNNER_VERSION}""#));
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.base_url()),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        Some("prod-1.aws.vm3.ai".to_string()),
    );
    let completed_at = DateTime::parse_from_rfc3339("2026-08-11T10:20:30.456Z")
        .unwrap()
        .with_timezone(&Utc);

    telemetry.record_at(
        "concurrent_operation",
        Duration::from_millis(25),
        true,
        None,
        completed_at,
    );
    telemetry.flush().await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn archive_mismatch_keeps_exact_u64_text_and_completion_time_through_auto_flush() {
    let receiver = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&receiver.url()),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    telemetry.record("previous_operation", Duration::ZERO, true, None);
    telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
    let completed_at = DateTime::parse_from_rfc3339("2026-09-18T02:03:04.567Z")
        .unwrap()
        .with_timezone(&Utc);
    telemetry.record_archive_phase_at(
        SandboxOpRecord::new(
            "storage_cache_fresh_delivery_headers",
            Duration::from_millis(7),
            false,
            Some("response-size-mismatch"),
        ),
        completed_at,
        Some(ArchiveSizeMismatch::new(
            5,
            u64::MAX,
            crate::storage_plan::ArchiveHandle::artifact(0),
            &reqwest::header::HeaderMap::new(),
        )),
        None,
    );
    telemetry.flush().await;
    let requests = receiver.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
    let payload: serde_json::Value = serde_json::from_str(body).unwrap();
    let operations = payload["sandboxOperations"].as_array().unwrap();
    assert_eq!(operations.len(), 2);
    assert!(operations[0].get("archive_size_mismatch").is_none());
    assert_eq!(
        operations[1],
        serde_json::json!({
            "ts": "2026-09-18T02:03:04.567Z",
            "action_type": "storage_cache_fresh_delivery_headers",
            "duration_ms": 7,
            "success": false,
            "error": "response-size-mismatch",
            "archive_size_mismatch": {
                "expected_bytes": "5",
                "response_bytes": "18446744073709551615",
                "source_kind": "artifact",
                "source_index": 0,
                "content_encoding": "absent",
            },
        })
    );
}

#[tokio::test]
async fn auto_flush_triggers_after_threshold() {
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
        RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
    ])
    .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );

    telemetry.record("op1", Duration::from_millis(10), true, None);
    telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
    telemetry.record("op2", Duration::from_millis(10), true, None);

    let first = server.next_request("threshold-triggered batch").await;
    let first: serde_json::Value =
        serde_json::from_str(first.split_once("\r\n\r\n").unwrap().1).unwrap();
    let operations = first["sandboxOperations"].as_array().unwrap();
    assert_eq!(operations.len(), 2);
    assert_eq!(operations[0]["action_type"], "op1");
    assert_eq!(operations[1]["action_type"], "op2");

    // A full drain seeds a fresh age, so both new records share the final
    // batch instead of inheriting the previous threshold-triggered age.
    telemetry.record("op3", Duration::from_millis(10), true, None);
    telemetry.record("op4", Duration::from_millis(10), true, None);
    telemetry.flush().await;
    let second = server
        .next_request("fresh pending batch at final flush")
        .await;
    let second: serde_json::Value =
        serde_json::from_str(second.split_once("\r\n\r\n").unwrap().1).unwrap();
    let operations = second["sandboxOperations"].as_array().unwrap();
    assert_eq!(operations.len(), 2);
    assert_eq!(operations[0]["action_type"], "op3");
    assert_eq!(operations[1]["action_type"], "op4");
    server.assert_finished().await;
}

#[tokio::test]
async fn partial_host_drain_preserves_the_pending_age_for_the_short_suffix() {
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut actions = vec![RawHttpAction::WaitThenRespond {
        release: release_rx,
        response: json_response("200 OK", r#"{"success":true}"#),
    }];
    actions.extend(
        (1..HOST_IN_FLIGHT_LIMIT + 2)
            .map(|_| RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#))),
    );
    let mut server = RawHttpTestServer::spawn(actions).await;
    let telemetry = JobTelemetry::new_runner(
        http_client_for_api_url(&server.url()),
        "host-operation-token".into(),
        None,
    );
    let reporter = telemetry.reporter();
    let record = |index| {
        SandboxOpRecord::new(
            "host_operation",
            Duration::from_millis(index as u64),
            true,
            None,
        )
    };
    let sent = HOST_IN_FLIGHT_LIMIT * HOST_BATCH_SIZE;
    let buffered = HOST_BATCH_SIZE + 10;
    for index in 0..sent {
        reporter.record(record(index));
    }
    server.next_request("held host batch").await;
    for index in sent..sent + buffered {
        reporter.record(record(index));
    }
    let in_flight = {
        let mut collector = telemetry.collector.lock().unwrap();
        let collector = collector.as_mut().unwrap();
        collector.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        std::mem::take(&mut collector.in_flight_flushes)
    };
    release_tx.send(()).unwrap();
    drain_in_flight_flushes(None, in_flight).await;
    for _ in 1..HOST_IN_FLIGHT_LIMIT {
        server.next_request("completed host batch").await;
    }

    reporter.record(record(sent + buffered));
    let prefix = server
        .next_request("bounded prefix after send capacity returns")
        .await;
    let prefix: serde_json::Value =
        serde_json::from_str(prefix.split_once("\r\n\r\n").unwrap().1).unwrap();
    let operations = prefix["sandboxOperations"].as_array().unwrap();
    assert_eq!(operations.len(), HOST_BATCH_SIZE);
    assert_eq!(
        operations
            .iter()
            .map(|op| op["duration_ms"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        (sent as u64..(sent + HOST_BATCH_SIZE) as u64).collect::<Vec<_>>()
    );

    // This suffix is smaller than HOST_BATCH_SIZE. Its original age must
    // still trigger an HTTP request before consuming the final collector.
    reporter.record(record(sent + buffered + 1));
    let suffix = server
        .next_request("aged short suffix before final flush")
        .await;
    let suffix: serde_json::Value =
        serde_json::from_str(suffix.split_once("\r\n\r\n").unwrap().1).unwrap();
    let operations = suffix["sandboxOperations"].as_array().unwrap();
    assert_eq!(operations.len(), buffered + 2 - HOST_BATCH_SIZE);
    assert_eq!(
        operations
            .iter()
            .map(|op| op["duration_ms"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        ((sent + HOST_BATCH_SIZE) as u64..(sent + buffered + 2) as u64).collect::<Vec<_>>()
    );
    telemetry.flush().await;
    server.assert_finished().await;
}

#[tokio::test]
async fn merged_pending_phases_keep_the_earliest_age_and_insertion_order() {
    for older_phase in [false, true] {
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::new_v4(),
            "tok".into(),
            None,
        );
        let mut phase = telemetry.fork_concurrent_phase();
        telemetry.record("parent", Duration::ZERO, true, None);
        phase.record("phase", Duration::ZERO, true, None);
        let older = if older_phase {
            &mut phase
        } else {
            &mut telemetry
        };
        older.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.merge_concurrent_phase(phase);
        telemetry.record("trigger", Duration::ZERO, true, None);

        let request = server
            .next_request("merged aged batch before final flush")
            .await;
        let payload: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        let operations = payload["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 3);
        assert_eq!(operations[0]["action_type"], "parent");
        assert_eq!(operations[1]["action_type"], "phase");
        assert_eq!(operations[2]["action_type"], "trigger");
        telemetry.flush().await;
        server.assert_finished().await;
    }
}

#[tokio::test]
async fn flush_waits_for_in_flight_auto_flush_after_buffer_is_drained() {
    use futures_util::FutureExt;

    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: release_rx,
        response: json_response("200 OK", r#"{"success":true}"#),
    }])
    .await;
    let api_url = server.url();

    let http = http_client_for_api_url(&api_url);
    let mut telemetry = JobTelemetry::new(
        http,
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        Some("prod-1.aws.vm3.ai".to_string()),
    );

    telemetry.record("op1", Duration::from_millis(10), true, None);
    telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
    telemetry.record("op2", Duration::from_millis(10), true, None);

    assert!(telemetry.pending_ops_snapshot().is_empty());
    assert_eq!(telemetry.in_flight_flushes.len(), 1);

    let request = server.next_request("auto flush request").await;
    assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer tok")
    );
    assert!(request.contains(r#""action_type":"op1""#));
    assert!(request.contains(r#""action_type":"op2""#));
    assert!(!request.contains(r#""runnerName""#));
    assert!(request.contains(r#""runnerHostname":"prod-1.aws.vm3.ai""#));
    assert!(request.contains(&format!(r#""runnerVersion":"{RUNNER_VERSION}""#)));

    let mut flush = Box::pin(telemetry.flush());
    assert!(
        flush.as_mut().now_or_never().is_none(),
        "flush returned before the held auto-flush response completed"
    );

    // Advance past the previous five-second request deadline without a
    // wall-clock wait. The held response must still own the pending flush.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    assert!(
        flush.as_mut().now_or_never().is_none(),
        "flush timed out before the delayed API response was released"
    );
    tokio::time::resume();

    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), flush)
        .await
        .expect("flush should complete after the response is released");
    server.assert_finished().await;
}

#[tokio::test]
async fn detached_reporter_sends_sandbox_operations_payload() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let api_url = server.url();

    let telemetry = JobTelemetry::new(
        http_client_for_api_url(&api_url),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );
    let reporter = telemetry.reporter();

    reporter
        .report(vec![SandboxOpRecord::new(
            "storage_cache_background_fill_filled",
            Duration::from_millis(42),
            true,
            None,
        )])
        .await;

    let requests = server.assert_finished_with_requests().await;
    let request = &requests[0];
    assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer tok")
    );
    assert!(request.contains(r#""runId":"00000000-0000-0000-0000-000000000000""#));
    assert!(request.contains(r#""action_type":"storage_cache_background_fill_filled""#));
    assert!(request.contains(r#""duration_ms":42"#));
    assert!(request.contains(r#""success":true"#));
}

#[tokio::test]
async fn oom_evidence_upload_payload_is_unchanged_by_the_removed_progress_field() {
    // The v1 payload never carried `runtime_progress_at`: the field was
    // `skip_serializing_if = "Option::is_none"` and the upload forced it to
    // `None` first. An old producer's value must still not reach the API.
    let legacy: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(include_str!(
        "../../../../guest-contracts/tests/fixtures/oom-evidence-v1-legacy-runtime-progress.json"
    ))
    .unwrap();
    let expected = serde_json::to_value(
        serde_json::from_str::<guest_contracts::oom_evidence::OomEvidence>(include_str!(
            "../../../../guest-contracts/tests/fixtures/contained-tool-oom.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true,"oomEvidenceVersion":1}"#,
    ))])
    .await;
    let telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        None,
    );

    telemetry.upload_oom_evidence(&legacy, "sandbox").await;

    let requests = server.assert_finished_with_requests().await;
    let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
    let actual: serde_json::Value = serde_json::from_str(body).unwrap();
    assert!(!body.contains("runtime_progress_at"));
    assert_eq!(actual["oomEvidence"], expected);
}

#[tokio::test]
async fn oom_evidence_upload_logs_http_status_without_sensitive_data() {
    const RESPONSE_BODY_SECRET: &str = "oom-evidence-response-secret";
    const SANDBOX_ID: &str = "oom-evidence-sandbox-secret";
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "400 Bad Request",
        r#"{"error":"oom-evidence-response-secret"}"#,
    ))])
    .await;
    let evidence = oom_evidence_for_test();
    let telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::from(uuid::Uuid::nil()),
        "oom-evidence-token-secret".to_string(),
        None,
    );
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    telemetry
        .upload_oom_evidence(&evidence, SANDBOX_ID)
        .with_subscriber(subscriber)
        .await;
    server.assert_finished().await;

    let event = captured
        .entries()
        .into_iter()
        .find(|event| {
            event.fields.get("message").is_some_and(|message| {
                message == "guest oom evidence upload unacknowledged; host evidence retained"
            })
        })
        .expect("oom evidence upload failure should be logged");
    assert_eq!(event.level, Level::WARN);
    assert_eq!(event.fields["reason"], "http_status");
    assert_eq!(event.fields["http_status"], "400");
    let event_debug = format!("{event:#?}");
    assert!(!event_debug.contains(RESPONSE_BODY_SECRET));
    assert!(!event_debug.contains(SANDBOX_ID));
    assert!(!event_debug.contains("oom-evidence-token-secret"));
    assert!(!event_debug.contains(&evidence.operation_id));
}

#[tokio::test]
async fn home_startup_http_payload_matches_shared_contract_fixture() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::from(uuid::Uuid::nil()),
        "startup-token".to_owned(),
        None,
    );
    telemetry.record_api_to_spawn(
        Duration::from_millis(125),
        RunnerStartupPath::Home,
        SandboxReuseResult::PoolMiss,
    );
    telemetry.record_api_to_agent_ready(
        Duration::from_millis(150),
        RunnerStartupPath::Home,
        SandboxReuseResult::PoolMiss,
    );
    telemetry.flush().await;
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /api/webhooks/agent/telemetry "));
    let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
    let actual: serde_json::Value = serde_json::from_str(body).unwrap();
    let mut expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/runner-home-startup-telemetry.json"
        ))
        .unwrap();
    expected["runnerVersion"] = serde_json::json!(RUNNER_VERSION);
    for (expected_op, actual_op) in expected["sandboxOperations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(actual["sandboxOperations"].as_array().unwrap())
    {
        DateTime::parse_from_rfc3339(actual_op["ts"].as_str().unwrap()).unwrap();
        expected_op["ts"] = actual_op["ts"].clone();
    }
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn telemetry_rejection_attributes_schema_operation_and_version_without_values() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "400 Bad Request",
            r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.1.runner_startup_path: response-private-value"}}"#,
        ))])
        .await;
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::from(uuid::Uuid::nil()),
        "telemetry-private-token".to_owned(),
        None,
    );
    telemetry.record(
        "telemetry-private-action",
        Duration::ZERO,
        false,
        Some("telemetry-private-error"),
    );
    telemetry.record_api_to_spawn(
        Duration::from_millis(125),
        RunnerStartupPath::Home,
        SandboxReuseResult::PoolMiss,
    );
    telemetry.flush().with_subscriber(subscriber).await;
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    let event = captured
        .entries()
        .into_iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "telemetry flush rejected")
        })
        .expect("telemetry rejection should be logged");
    assert_eq!(event.level, Level::WARN);
    assert_eq!(event.fields["runner_version"], RUNNER_VERSION);
    assert_eq!(event.fields["operation_count"], "2");
    assert_eq!(event.fields["rejection_field"], "runner_startup_path");
    assert_eq!(event.fields["rejection_operation_index"], "1");
    assert_eq!(event.fields["rejection_operation"], "api_to_spawn");
    let event_debug = format!("{event:#?}");
    for secret in [
        "response-private-value",
        "telemetry-private-token",
        "telemetry-private-action",
        "telemetry-private-error",
    ] {
        assert!(!event_debug.contains(secret));
    }
}

#[tokio::test]
async fn telemetry_rejection_keeps_unusable_responses_unattributed() {
    let valid = r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.0.runner_startup_path: response-private-value"}}"#;
    for (status, body) in [
        ("400 Bad Request", "{"),
        (
            "400 Bad Request",
            r#"{"error":{"code":"BAD_REQUEST","message":"Invalid JSON in request body"}}"#,
        ),
        (
            "400 Bad Request",
            r#"{"error":{"code":"PRIVATE_CODE","message":"sandboxOperations.0.runner_startup_path: response-private-value"}}"#,
        ),
        (
            "400 Bad Request",
            r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.0.response-private-key: response-private-value"}}"#,
        ),
        (
            "400 Bad Request",
            r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.1.runner_startup_path: response-private-value"}}"#,
        ),
        ("500 Internal Server Error", valid),
    ] {
        let server =
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(status, body))])
                .await;
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::from(uuid::Uuid::nil()),
            "telemetry-private-token".to_owned(),
            None,
        );
        telemetry.record_api_to_spawn(
            Duration::ZERO,
            RunnerStartupPath::Home,
            SandboxReuseResult::PoolMiss,
        );
        telemetry.flush().with_subscriber(subscriber).await;
        server.assert_finished().await;
        let event = captured
            .entries()
            .into_iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "telemetry flush rejected")
            })
            .expect("unattributed rejection should still be logged");
        assert!(!event.fields.contains_key("rejection_field"));
        assert!(!event.fields.contains_key("rejection_operation_index"));
        assert!(!event.fields.contains_key("rejection_operation"));
        assert!(!format!("{event:#?}").contains("private"));
    }
}

#[tokio::test]
async fn telemetry_rejection_bounds_response_bytes_and_arbitrary_action_names() {
    for size in [4096, 4097] {
        let mut body = serde_json::json!({
            "error": {
                "code": "BAD_REQUEST",
                "message": "sandboxOperations.0.action_type: response-private-value",
            },
            "padding": "",
        });
        let padding = size - serde_json::to_vec(&body).unwrap().len();
        body["padding"] = serde_json::json!("x".repeat(padding));
        let body = serde_json::to_string(&body).unwrap();
        assert_eq!(body.len(), size);
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "400 Bad Request",
            &body,
        ))])
        .await;
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::from(uuid::Uuid::nil()),
            "telemetry-private-token".to_owned(),
            None,
        );
        telemetry.record("telemetry-private-action", Duration::ZERO, true, None);
        telemetry.flush().with_subscriber(subscriber).await;
        server.assert_finished().await;
        let event = captured
            .entries()
            .into_iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "telemetry flush rejected")
            })
            .expect("oversize and attributed rejections should be logged");
        if size == 4096 {
            assert_eq!(event.fields["rejection_field"], "action_type");
            assert_eq!(event.fields["rejection_operation_index"], "0");
        } else {
            assert!(!event.fields.contains_key("rejection_field"));
            assert!(!event.fields.contains_key("rejection_operation_index"));
        }
        assert!(!event.fields.contains_key("rejection_operation"));
        assert!(!format!("{event:#?}").contains("private"));
    }
}

#[tokio::test]
async fn transport_failure_logs_stable_cause_and_safe_request_context() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let api_url = server.url();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    send_telemetry(
        &http_client_for_api_url(&api_url),
        Some(RunId::from(uuid::Uuid::nil())),
        "telemetry-sensitive-token",
        None,
        vec![sandbox_op(
            "telemetry-sensitive-action",
            Duration::from_millis(1),
            true,
            None,
            None,
        )],
    )
    .with_subscriber(subscriber)
    .await;
    server.assert_finished().await;

    let event = captured
        .entries()
        .into_iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "telemetry flush failed")
        })
        .expect("telemetry transport failure should be logged");
    assert_eq!(event.level, Level::WARN);
    assert_eq!(event.fields["endpoint"], "telemetry");
    assert!(event.fields["error"].starts_with("api error: "));
    assert_eq!(event.fields["failure_kind"], "request");
    assert_eq!(event.fields["failure_cause"], "http_incomplete_message");
    let event_debug = format!("{event:#?}");
    assert!(!event_debug.contains("telemetry-sensitive-token"));
    assert!(!event_debug.contains("telemetry-sensitive-action"));
    assert!(!event_debug.contains(&api_url));
}

#[tokio::test]
async fn canonical_attribution_is_sent_by_direct_reporter() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let api_url = server.url();

    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&api_url),
        RunId::from(uuid::Uuid::nil()),
        "tok".to_string(),
        Some("prod-1.aws.vm3.ai".to_string()),
    );
    telemetry.set_sandbox_startup_path(RunnerStartupPath::Blank);
    telemetry.set_first_run(Some(false));
    telemetry
        .reporter()
        .report(vec![SandboxOpRecord::new(
            "runner_attribution_test",
            Duration::from_millis(1),
            true,
            None,
        )])
        .await;

    let requests = server.assert_finished_with_requests().await;
    let request = &requests[0];
    assert!(!request.contains(r#""runnerName""#));
    assert!(request.contains(r#""runnerHostname":"prod-1.aws.vm3.ai""#));
    assert!(request.contains(&format!(r#""runnerVersion":"{RUNNER_VERSION}""#)));
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    let payload: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        payload["sandboxOperations"][0]["runner_startup_path"],
        "blank"
    );
    assert_eq!(payload["sandboxOperations"][0]["is_first_run"], false);
}

#[tokio::test]
async fn sandbox_startup_fact_is_published_before_final_flush_without_flushing_preparation() {
    for (path, wire_path, sandbox_result, home_result) in [
        (
            RunnerStartupPath::Sandbox,
            "sandbox",
            SandboxReuseResult::Reused,
            HomeReuseResult::SandboxReused,
        ),
        (
            RunnerStartupPath::Home,
            "home",
            SandboxReuseResult::PoolMiss,
            HomeReuseResult::Reused,
        ),
        (
            RunnerStartupPath::Blank,
            "blank",
            SandboxReuseResult::PoolMiss,
            HomeReuseResult::CacheMiss,
        ),
        (
            RunnerStartupPath::Cold,
            "cold",
            SandboxReuseResult::PoolMiss,
            HomeReuseResult::CacheMiss,
        ),
    ] {
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::WaitThenRespond {
                release: release_rx,
                response: json_response("200 OK", r#"{"success":true}"#),
            },
            RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
        ])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::new_v4(),
            "tok".into(),
            None,
        );
        telemetry.set_first_run(Some(false));
        telemetry.set_sandbox_startup_path(path);
        let generation = uuid::Uuid::new_v4().to_string();
        telemetry.set_home_startup_source(Some(HomeImageSourceIdentity {
            cache_key: "selected-cache",
            profile_name: "vm0/default",
            image_generation: &generation,
        }));
        let mut phase = telemetry.fork_concurrent_phase();
        telemetry.record("preparation", Duration::ZERO, true, None);
        phase.record_sandbox_startup(path, sandbox_result, home_result, Some("thread:tracked"));
        telemetry.merge_concurrent_phase(phase);

        let request = server.next_request("startup fact before final flush").await;
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        let operations = payload["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 1);
        let operation = &operations[0];
        assert_eq!(operation["action_type"], "runner_sandbox_startup");
        assert_eq!(operation["runner_startup_path"], wire_path);
        assert_eq!(operation["is_first_run"], false);
        assert_eq!(operation["success"], true);
        assert_eq!(operation["reuse_key"], "thread:tracked");
        if path == RunnerStartupPath::Home {
            assert_eq!(operation["cache_key"], "selected-cache");
            assert_eq!(operation["profile_name"], "vm0/default");
            assert_eq!(operation["image_generation"], generation);
        } else {
            for field in ["cache_key", "profile_name", "image_generation"] {
                assert!(operation.get(field).is_none(), "{wire_path}: {field}");
            }
        }
        assert_eq!(
            operation["home_reuse_result"],
            serde_json::to_value(home_result).unwrap()
        );
        assert_eq!(
            operation["sandbox_reuse_result"],
            serde_json::to_value(sandbox_result).unwrap()
        );

        // Recording continues while the startup request's response is held.
        telemetry.record("after_start", Duration::ZERO, true, None);
        release_tx.send(()).unwrap();
        telemetry.flush().await;
        let request = server.next_request("ordinary batch at final flush").await;
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        let operations = payload["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0]["action_type"], "preparation");
        assert_eq!(operations[1]["action_type"], "after_start");
        assert!(operations.iter().all(|op| op["is_first_run"] == false));
        server.assert_finished().await;
    }
}

#[tokio::test]
async fn sandbox_startup_without_first_context_omits_it_and_keeps_the_send_owned() {
    use futures_util::FutureExt;

    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: release_rx,
        response: json_response("200 OK", r#"{"success":true}"#),
    }])
    .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::new_v4(),
        "tok".into(),
        None,
    );
    telemetry.record_sandbox_startup(
        RunnerStartupPath::Cold,
        SandboxReuseResult::NoReuseKey,
        HomeReuseResult::NoReuseKey,
        None,
    );
    let request = server.next_request("startup without context").await;
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    let payload: serde_json::Value = serde_json::from_str(body).unwrap();
    let operation = &payload["sandboxOperations"][0];
    assert!(operation.get("is_first_run").is_none());
    assert!(operation.get("reuse_key").is_none());
    assert_eq!(operation["runner_startup_path"], "cold");
    let mut flush = Box::pin(telemetry.flush());
    assert!(flush.as_mut().now_or_never().is_none());
    release_tx.send(()).unwrap();
    flush.await;
    server.assert_finished().await;
}

#[tokio::test]
async fn first_run_context_survives_concurrent_phase_ownership() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::new_v4(),
        "tok".into(),
        None,
    );
    telemetry.set_first_run(Some(true));
    let mut phase = telemetry.fork_concurrent_phase();
    phase.record("concurrent", Duration::ZERO, true, None);
    telemetry.merge_concurrent_phase(phase);
    telemetry.record("continued", Duration::ZERO, true, None);
    telemetry.flush().await;
    let requests = server.assert_finished_with_requests().await;
    let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
    let payload: serde_json::Value = serde_json::from_str(body).unwrap();
    let operations = payload["sandboxOperations"].as_array().unwrap();
    assert_eq!(operations.len(), 2);
    assert!(operations.iter().all(|op| op["is_first_run"] == true));
}
