use httpmock::prelude::*;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, LazyLock, Mutex, MutexGuard,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;

pub(crate) use crate::common::SystemLogOverrideGuard;

pub(crate) const TEST_RUN_ID: &str = "test-run-001";

pub(crate) static MOCK_RUNTIME_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    crate::common::unique_temp_path("vm0-guest-agent-integration")
        .join("runs")
        .join(TEST_RUN_ID)
});

/// Shared HTTP boundary; callers provide config and paths explicitly.
pub(crate) static MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(MockServer::start);

/// Serialize shared mock resets, runtime files, and process-wide log overrides.
pub(crate) static TEST_MUTEX: Mutex<()> = Mutex::new(());

#[must_use = "keep SharedApiMock alive for the full test to hold the shared mock lock"]
pub(crate) struct SharedApiMock {
    _guard: MutexGuard<'static, ()>,
    server: &'static MockServer,
}

impl SharedApiMock {
    pub(crate) async fn new() -> Self {
        let guard = match TEST_MUTEX.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let server = &*MOCK_SERVER;
        server.reset_async().await;
        cleanup_integration_runtime_root();
        write_shared_run_payload_file_or_panic();
        Self {
            _guard: guard,
            server,
        }
    }

    pub(crate) fn server(&self) -> &MockServer {
        self.server
    }

    pub(crate) fn url(&self, path: &str) -> String {
        assert!(
            path.starts_with('/'),
            "shared API mock path must be absolute"
        );
        format!("{}{}", self.server.base_url(), path)
    }
}

impl Drop for SharedApiMock {
    fn drop(&mut self) {
        cleanup_integration_runtime_root();
    }
}

fn write_shared_run_payload_file_or_panic() {
    let payload = guest_contracts::env::RunPayload {
        prompt: "test prompt".to_string(),
        ..guest_contracts::env::RunPayload::default()
    };
    let result = crate::common::write_run_payload_file_for_test(&MOCK_RUNTIME_DIR, &payload);
    assert!(result.is_ok(), "write test run payload: {result:?}");
}

fn cleanup_integration_runtime_root() {
    let runtime_dir = MOCK_RUNTIME_DIR.as_path();
    let root = runtime_dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or(runtime_dir);
    let is_test_root = root
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("vm0-guest-agent-integration-"))
        .unwrap_or(false);
    if is_test_root && root.starts_with(std::env::temp_dir()) {
        let _ = std::fs::remove_dir_all(root);
    }
}

macro_rules! http_client {
    () => {
        crate::support::test_http_client(crate::support::TEST_HTTP_RETRY_DELAY)
    };
}

pub(crate) const TEST_HTTP_RETRY_DELAY: Duration = Duration::ZERO;
pub(crate) const TEST_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(20);
pub(crate) const MOCK_CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[allow(clippy::expect_used)]
pub(crate) fn test_http_client(retry_delay: Duration) -> guest_agent::http::HttpClient {
    let server = &*MOCK_SERVER;
    guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token-abc123",
        "test-bypass-value",
        TEST_RUN_ID,
        retry_delay,
    )
    .expect("build test http client")
}

pub(crate) fn shared_guest_paths() -> guest_agent::paths::GuestPaths {
    guest_agent::paths::GuestPaths::from_runtime_dir(MOCK_RUNTIME_DIR.as_path())
}

pub(crate) fn shared_guest_config() -> Result<guest_agent::env::GuestConfig, String> {
    let server = &*MOCK_SERVER;
    let run_payload_file = crate::common::write_run_payload_file_for_test(
        &MOCK_RUNTIME_DIR,
        &guest_contracts::env::RunPayload {
            prompt: "test prompt".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: TEST_RUN_ID.to_string(),
        api_url: server.base_url(),
        api_token: "test-token-abc123".to_string(),
        sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
        sandbox_reuse_result: "reused".to_string(),
        vercel_bypass: "test-bypass-value".to_string(),
        cli_agent_type: "claude-code".to_string(),
        home: Some(shared_guest_home_dir().to_string_lossy().into_owned()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(MOCK_RUNTIME_DIR.clone()),
        ..Default::default()
    })
}

fn shared_guest_home_dir() -> PathBuf {
    MOCK_RUNTIME_DIR
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir)
        .join("home")
}

pub(crate) fn http_status(status: u16) -> HttpMockResponse {
    HttpMockResponse::builder().status(status).build()
}

pub(crate) fn json_http_response(status: u16, body: Value) -> HttpMockResponse {
    HttpMockResponse::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .build()
}

pub(crate) fn retry_then_response(
    failures: usize,
    success_response: HttpMockResponse,
) -> impl Fn(&HttpMockRequest) -> HttpMockResponse {
    let attempts = AtomicUsize::new(0);

    move |_req| {
        if attempts.fetch_add(1, Ordering::SeqCst) < failures {
            return http_status(500);
        }

        success_response.clone()
    }
}

pub(crate) fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
    req.headers_vec()
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
}

pub(crate) fn request_header_absent(req: &HttpMockRequest, name: &str) -> bool {
    !req.headers_vec()
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case(name))
}

pub(crate) fn upload_request_matches(
    req: &HttpMockRequest,
    expected_body: &[u8],
    expected_content_length: &str,
) -> bool {
    request_header_eq(req, "content-length", expected_content_length)
        && request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() == expected_body
}

pub(crate) fn upload_validation_response(
    req: &HttpMockRequest,
    expected_body: &[u8],
    expected_content_length: &str,
) -> HttpMockResponse {
    if upload_request_matches(req, expected_body, expected_content_length) {
        http_status(200)
    } else {
        http_status(400)
    }
}

#[derive(Clone, Default)]
pub(crate) struct MockCallObserver {
    calls: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

impl MockCallObserver {
    pub(crate) fn record(&self) -> usize {
        let calls = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.notify.notify_one();
        calls
    }

    pub(crate) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub(crate) async fn wait_for(&self, expected: usize, timeout: Duration, context: &str) {
        let result = tokio::time::timeout(timeout, async {
            loop {
                if self.calls() >= expected {
                    return;
                }

                self.notify.notified().await;
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "timed out waiting for {context}: expected at least {expected} mock calls, observed {} after {timeout:?}",
            self.calls(),
        );
    }
}

fn cleanup_session_checkpoint_files() {
    let paths = shared_guest_paths();
    let _ = std::fs::remove_file(paths.session_id_file());
    let _ = std::fs::remove_file(paths.final_session_history_identity_file());
    let _ = std::fs::remove_file(paths.checkpoint_error_file());
    let _ = std::fs::remove_file(paths.failure_diagnostic_file());
}

pub(crate) struct SessionCheckpointFilesGuard;

impl SessionCheckpointFilesGuard {
    pub(crate) fn new() -> Self {
        cleanup_session_checkpoint_files();
        Self
    }
}

impl Drop for SessionCheckpointFilesGuard {
    fn drop(&mut self) {
        cleanup_session_checkpoint_files();
    }
}
