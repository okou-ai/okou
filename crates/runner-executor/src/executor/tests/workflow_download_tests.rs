use std::sync::Arc;

use sandbox::SandboxId;
use sandbox_mock::{MockSandboxFactory, MockSandboxOverrides};
use tokio_util::sync::CancellationToken;

use super::super::{NewSandboxDispatch, execute_job, execute_job_reuse};
use super::support::{
    default_params, make_reusable_idle_sandbox, minimal_context, test_executor_config,
    test_executor_config_with_startup_api,
};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer};
use runner_provider::http::{HttpClient, HttpClientConfig};
use runner_types::ids::RunId;
use runner_types::types::{ExecutionContext, SandboxReuseResult};

fn workflow_context(run_id: RunId, workflow_id: uuid::Uuid) -> ExecutionContext {
    let mut context = minimal_context();
    context.run_id = run_id;
    context.storage_manifest = Some(serde_json::from_value(serde_json::json!({
        "storageMounts": [],
        "workflowSkills": [{"workflowId":workflow_id,"mountPath":"/home/user/.claude/skills/selected-workflow"}],
    })).unwrap());
    context
}

#[tokio::test]
async fn current_documents_are_downloaded_and_installed_on_fresh_and_reused_sandboxes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, api) = test_executor_config_with_startup_api(dir.path()).await;
    config.api_url = api.base_url();
    let workflow_id = uuid::Uuid::new_v4();
    let first_run = RunId::new_v4();
    let next_run = RunId::new_v4();
    let first_body = "---\nname: current-name\n---\n\n正文 🦉\n";
    let next_body = format!(
        "---\nname: renamed-later\n---\n\n{}\n",
        "x".repeat(1_100_000)
    );
    for (run_id, body) in [(first_run, first_body), (next_run, next_body.as_str())] {
        api.mock(|when, then| {
            when.method(httpmock::Method::GET)
                .path(format!(
                    "/api/runners/runs/{run_id}/workflows/{workflow_id}"
                ))
                .header("authorization", "Bearer tok");
            then.status(200).json_body(
                serde_json::json!({"workflowId":workflow_id,"skillMd":body,"attachments":null}),
            );
        });
    }
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let (mut outcome, _) = execute_job(
        &factory,
        workflow_context(first_run, workflow_id),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    assert!(
        outcome.storage_fingerprints.storages["/home/user/.claude/skills/selected-workflow"]
            .matches(&format!("workflow:{workflow_id}"), "empty")
    );
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
    assert!(
        overrides
            .private_write_files_calls()
            .iter()
            .flat_map(|write| &write.files)
            .any(|file| file.content == first_body.as_bytes())
    );
    let sandbox = outcome.sandbox.take().unwrap();
    let (idle, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (mut next, _) = execute_job_reuse(
        idle,
        workflow_context(next_run, workflow_id),
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(next.exit_code(), 0, "{:?}", next.error());
    if let Some(report) = next.startup_report.take() {
        report.finish().await;
    }
    assert!(
        overrides
            .private_write_files_calls()
            .iter()
            .flat_map(|write| &write.files)
            .any(|file| file.content == next_body.as_bytes())
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 2);
}

#[tokio::test]
async fn unavailable_or_foreign_workflow_downloads_prevent_sandbox_and_agent_spawn() {
    for wrong_identity in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (mut config, api) = test_executor_config_with_startup_api(dir.path()).await;
        config.api_url = api.base_url();
        let run_id = RunId::new_v4();
        let workflow_id = uuid::Uuid::new_v4();
        api.mock(|when, then| {
            when.method(httpmock::Method::GET).path(format!("/api/runners/runs/{run_id}/workflows/{workflow_id}"));
            if wrong_identity {
                then.status(200).json_body(serde_json::json!({"workflowId":uuid::Uuid::new_v4(),"skillMd":"foreign text must not be applied","attachments":null}));
            } else { then.status(404); }
        });
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let (outcome, _) = execute_job(
            &factory,
            workflow_context(run_id, workflow_id),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoReuseKey,
            },
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await;
        assert_ne!(outcome.exit_code(), 0);
        assert!(outcome.sandbox.is_none());
        assert!(overrides.private_write_files_calls().is_empty());
        assert!(overrides.start_agent_process_calls().is_empty());
    }
}

#[tokio::test]
async fn cancellation_retires_a_stalled_download_before_sandbox_creation() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_executor_config(dir.path()).await;
    let mut api = RawHttpTestServer::spawn(vec![RawHttpAction::Stall]).await;
    config.api_url = api.url();
    config.http = HttpClient::new(HttpClientConfig {
        api_url: api.url(),
        vercel_bypass: None,
        client_session_id: "workflow-download-cancellation".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let factory = MockSandboxFactory::new();
    let cancel = CancellationToken::new();
    let params = default_params();
    let run_id = RunId::new_v4();
    let workflow_id = uuid::Uuid::new_v4();
    let run = execute_job(
        &factory,
        workflow_context(run_id, workflow_id),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &params,
        cancel.clone(),
    );
    tokio::pin!(run);
    let request = tokio::select! {
        request = api.next_request("Workflow download before cancellation") => request,
        _ = &mut run => panic!("execution completed before the download was admitted"),
    };
    assert!(request.starts_with(&format!(
        "GET /api/runners/runs/{run_id}/workflows/{workflow_id} "
    )));
    cancel.cancel();
    let (outcome, _) = tokio::time::timeout(std::time::Duration::from_secs(5), &mut run)
        .await
        .unwrap();
    assert_eq!(outcome.error(), Some("cancelled by user"));
    assert!(outcome.sandbox.is_none());
    assert!(
        outcome.storage_fingerprints.storages["/home/user/.claude/skills/selected-workflow"]
            .is_tainted()
    );
    api.cancel_and_reap().await;
}
