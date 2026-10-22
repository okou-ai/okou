use super::*;
use httpmock::prelude::*;
use raw_http_test_support::clock::advance_timer_phase;
use runner_provider::http::{HttpClient, HttpClientConfig};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use tracing_test_support::CapturedEvents;

use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer};

const WAIT: Duration = Duration::from_secs(5);

fn startup_http(api_url: String) -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url,
        vercel_bypass: None,
        client_session_id: "prepared-startup-report".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap()
}

#[tokio::test]
async fn startup_source_waits_for_bootstrap_and_authenticated_agent_ready() {
    let dir = tempfile::tempdir().unwrap();
    let api = MockServer::start_async().await;
    let mut config = test_executor_config(dir.path()).await;
    config.http = startup_http(api.base_url());
    let report = api.mock(|when, then| {
        when.method(PUT)
            .path_matches("/api/runners/runs/[^/]+/startup")
            .json_body(serde_json::json!({"sandboxStartupPath":"cold"}));
        then.status(204);
    });
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let files = MockLifecycleGate::new();
    let agent = MockLifecycleGate::new();
    overrides.set_private_write_file_lifecycle_gate(files.clone());
    overrides.set_start_process_lifecycle_gate(agent.clone());
    let factory = MockSandboxFactory::with_overrides(overrides.clone());
    let task = AbortOnDropHandle::new(tokio::spawn(async move {
        execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await
    }));
    files.wait_entered(1, WAIT).await.unwrap();
    report.assert_calls_async(0).await;
    files.release_one();
    agent.wait_entered(1, WAIT).await.unwrap();
    report.assert_calls_async(0).await;
    agent.release_one();
    let (mut outcome, _) = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(outcome.exit_code(), 0);
    outcome.startup_report.take().unwrap().finish().await;
    report.assert_calls_async(1).await;
}

#[tokio::test]
async fn startup_upload_does_not_gate_guest_execution_or_execution_result() {
    let dir = tempfile::tempdir().unwrap();
    let (release, released) = tokio::sync::oneshot::channel();
    let mut api = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: released,
        response: b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec(),
    }])
    .await;
    let mut config = test_executor_config(dir.path()).await;
    let context = minimal_context();
    let mut telemetry = test_telemetry(&config, &context);
    config.http = startup_http(api.url());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let wait = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(wait.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let run_id = context.run_id;
    let task = AbortOnDropHandle::new(tokio::spawn(async move {
        let outcome = execute_new_sandbox(
            &factory,
            &context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            &mut telemetry,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        (outcome, telemetry)
    }));

    let request = api.next_request("settled cold startup report").await;
    assert!(request.starts_with(&format!("PUT /api/runners/runs/{run_id}/startup ")));
    assert!(request.contains(r#"{"sandboxStartupPath":"cold"}"#));
    wait.wait_entered(1, WAIT)
        .await
        .expect("guest must execute while the startup response is held");
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    wait.release_one();
    let (mut outcome, _) = tokio::time::timeout(WAIT, task)
        .await
        .expect("execution must finish while the startup response is held")
        .unwrap();
    assert_eq!(outcome.exit_code(), 0);
    let report = outcome.startup_report.take().expect("owned startup report");
    release.send(()).unwrap();
    report.finish().await;
    api.assert_finished().await;
}

#[tokio::test]
async fn startup_upload_failure_does_not_fail_the_run() {
    for (status, expected_requests) in [(404, 1), (503, 3)] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let dir = tempfile::tempdir().unwrap();
        let api = MockServer::start_async().await;
        let mut config = test_executor_config(dir.path()).await;
        config.http = startup_http(api.base_url());
        let context = minimal_context();
        let report = api.mock(|when, then| {
            when.method(PUT)
                .path(format!("/api/runners/runs/{}/startup", context.run_id))
                .json_body(serde_json::json!({ "sandboxStartupPath": "cold" }));
            then.status(status);
        });
        let (mut outcome, _) = execute_job(
            &MockSandboxFactory::new(),
            context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome.exit_code(), 0);
        let finished = outcome.startup_report.take().unwrap().finish();
        tokio::pin!(finished);
        for attempt in 1..expected_requests {
            let attempt = attempt.to_string();
            tokio::time::timeout(WAIT, async {
                loop {
                    assert!(futures_util::poll!(&mut finished).is_pending());
                    if captured.entries().iter().any(|event| {
                        event.fields.get("message").map(String::as_str)
                            == Some("sandbox startup report failed, retrying")
                            && event.fields.get("attempt") == Some(&attempt)
                            && event.fields.get("will_retry").map(String::as_str) == Some("true")
                    }) {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("startup upload must arm its retry before advancing time");
            advance_timer_phase(Duration::from_secs(2)).await;
        }
        finished.await;
        report.assert_calls_async(expected_requests).await;
    }
}
