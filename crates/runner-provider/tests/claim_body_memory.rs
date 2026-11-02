//! One isolated public-provider test observes aggregate and fragmented allocations.
//! Fixture setup and complete provider/HTTP-peer cleanup are not measured.
use raw_http_test_support::raw_http::{RawHttpAction, RawHttpTestServer};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, HttpClient, HttpClientConfig,
    JobCandidate, JobProvider, RunCancellationRegistry,
};
use runner_types::types::ExecutionContext;
use std::alloc::{GlobalAlloc, Layout, System};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

static MEASURING: AtomicBool = AtomicBool::new(false);
static AGGREGATE_THRESHOLD: AtomicUsize = AtomicUsize::new(usize::MAX);
static AGGREGATE_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static AGGREGATE_BYTES: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

struct AllocationObserver;

fn observe(size: usize) {
    if MEASURING.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
        if size >= AGGREGATE_THRESHOLD.load(Ordering::Relaxed) {
            AGGREGATE_REQUESTS.fetch_add(1, Ordering::Relaxed);
            AGGREGATE_BYTES.fetch_add(size, Ordering::Relaxed);
        }
    }
}

// Transparent System delegation; allocation observation never allocates.
unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        observe(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        observe(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        observe(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

struct Measurement;

impl Measurement {
    fn start(source_bytes: usize) -> Self {
        AGGREGATE_THRESHOLD.store(source_bytes / 2, Ordering::Relaxed);
        AGGREGATE_REQUESTS.store(0, Ordering::Relaxed);
        AGGREGATE_BYTES.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        MEASURING.store(true, Ordering::Relaxed);
        Self
    }
}

impl Drop for Measurement {
    fn drop(&mut self) {
        MEASURING.store(false, Ordering::Relaxed);
    }
}

fn claim_body(value_bytes: usize) -> TestResult<(Vec<u8>, ExecutionContext)> {
    let mut context: serde_json::Value = serde_json::from_str(include_str!(
        "../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/runner-claim-response.json"
    ))?;
    let environment = context
        .get_mut("environment")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| io::Error::other("canonical environment must be an object"))?;
    for index in 0..512 {
        environment.insert(
            format!("CLAIM_VALUE_{index:04}"),
            format!("value-{index}-\"-\\-界-{}", "x".repeat(value_bytes)).into(),
        );
    }
    let bytes = serde_json::to_vec(&context)?;
    let expected = serde_json::from_slice(&bytes)?;
    Ok((bytes, expected))
}

fn assert_complete_context(actual: &ExecutionContext, expected: &ExecutionContext) -> TestResult {
    assert_eq!(actual.storage_manifest, expected.storage_manifest);
    macro_rules! same_fields {
        ($($field:ident),+ $(,)?) => {
            $(assert_eq!(
                serde_json::to_value(&actual.$field)?,
                serde_json::to_value(&expected.$field)?,
                stringify!($field),
            );)+
        };
    }
    same_fields!(
        run_id,
        reuse_key,
        prompt,
        append_system_prompt,
        vars,
        sandbox_token,
        environment,
        platform_environment,
        native_continuation,
        secret_values,
        encrypted_secrets,
        secret_connector_map,
        secret_connector_metadata_map,
        cli_agent_type,
        real_agent_in_preview,
        api_start_time,
        is_first_run,
        user_timezone,
        capture_network_bodies,
        firewalls,
        network_policies,
        network_policy_refreshes,
        connector_runtime_targets,
        disallowed_tools,
        tools,
        settings,
        feature_flags,
        billable_firewalls,
        model_usage_provider,
        model_usage_long_context_min_total_input_tokens,
        codex_runtime_config,
        pi_launch_config,
        pi_model_config,
        pi_session_id,
    );
    Ok(())
}

#[tokio::test]
async fn successful_split_claim_bodies_use_one_aggregate_output() -> TestResult {
    let mut measurements = Vec::new();
    let mut fragmented_largest = None;
    for (chunked, fragmented) in [(false, false), (true, false), (true, true)] {
        let (body, expected) = claim_body(if fragmented { 128 } else { 8192 })?;
        let source_bytes = body.len();
        let framing = if chunked {
            "Transfer-Encoding: chunked\r\n\r\n".to_owned()
        } else {
            format!("Content-Length: {source_bytes}\r\n\r\n")
        };
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: identity\r\nConnection: close\r\n{framing}"
        )
        .into_bytes();
        if chunked {
            if fragmented {
                // Tiny/large/tiny ordering also exercises partial-group flushing.
                let mut offset = 0;
                while offset < body.len() {
                    let length = if offset == 512 { 8 * 1024 } else { 1 };
                    let chunk = &body[offset..offset + length];
                    if length == 1 {
                        response.extend_from_slice(b"1\r\n");
                    } else {
                        response.extend_from_slice(format!("{length:x}\r\n").as_bytes());
                    }
                    response.extend_from_slice(chunk);
                    response.extend_from_slice(b"\r\n");
                    offset += length;
                }
            } else {
                response.extend_from_slice(format!("{source_bytes:x}\r\n").as_bytes());
                response.extend_from_slice(&body);
                response.extend_from_slice(b"\r\n");
            }
            response.extend_from_slice(b"0\r\n\r\n");
        } else {
            response.extend_from_slice(&body);
        }
        let peer = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(response)]).await;
        let directory = tempfile::tempdir()?;
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1)?;
        let http = HttpClient::new(HttpClientConfig {
            api_url: peer.url(),
            vercel_bypass: None,
            client_session_id: "claim-body-memory-test".into(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })?;
        let provider = ApiProvider::new(
            http,
            "synthetic-runner-token".into(),
            ApiProviderConfig {
                ably_side_message_handler: None,
                runner_identity: identity,
                runner_hostname: None,
                group: "test".into(),
                supported_profiles: vec![],
                installed_okou_cli: None,
            },
            BuiltinFirewallCatalogCachePaths {
                cache_path: directory.path().join("catalog.json"),
                lock_path: directory.path().join("catalog.lock"),
            },
            CancellationToken::new(),
            RunCancellationRegistry::new(),
        );
        let candidate = JobCandidate::new(expected.run_id, "vm0/default".into());
        let measurement = Measurement::start(source_bytes);
        let result = tokio::time::timeout(Duration::from_secs(5), provider.claim(candidate)).await;
        drop(measurement);
        let requests = AGGREGATE_REQUESTS.load(Ordering::Relaxed);
        let allocated_bytes = AGGREGATE_BYTES.load(Ordering::Relaxed);
        let largest = LARGEST.load(Ordering::Relaxed);
        provider.shutdown().await;
        let captured = peer.assert_finished_with_requests().await;

        let claimed = result?.ok_or_else(|| io::Error::other("complete claim was not returned"))?;
        assert_complete_context(claimed.context(), &expected)?;
        let timing = claimed
            .api_claim_timing()
            .ok_or_else(|| io::Error::other("API claim timing missing"))?;
        assert_eq!(
            timing.response_attribution().body_size_bucket(),
            if fragmented { "64_256_kib" } else { "ge_1_mib" },
        );
        assert_eq!(timing.response_attribution().content_encoding(), "identity");
        assert_eq!(captured.len(), 1);
        assert_eq!(
            captured[0].lines().next(),
            Some(
                format!(
                    "POST /api/runners/jobs/{}/claim?workflowSkills=2 HTTP/1.1",
                    expected.run_id
                )
                .as_str()
            ),
        );
        eprintln!(
            "chunked={chunked}, fragmented={fragmented}: source={source_bytes}, aggregate requests={requests}, aggregate requested bytes={allocated_bytes}, largest={largest}"
        );
        if fragmented {
            fragmented_largest = Some(largest);
        } else {
            measurements.push((chunked, source_bytes, requests, allocated_bytes));
        }
    }
    // Individual requests only: this does not bound RSS, retained chunks,
    // decoded context or concurrent successful claims.
    for (chunked, source_bytes, requests, allocated_bytes) in measurements {
        assert_eq!(requests, 1, "duplicate coalescing: chunked={chunked}");
        assert_eq!(allocated_bytes, source_bytes);
    }
    assert!(
        fragmented_largest.unwrap() <= 1024 * 1024,
        "tiny HTTP chunks must not create an input-amplifying retained container: {fragmented_largest:?}",
    );
    Ok(())
}
