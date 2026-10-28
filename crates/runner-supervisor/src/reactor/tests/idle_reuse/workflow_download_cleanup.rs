use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides_and_api_url, push_job, shutdown,
    test_profiles, wait_idle_pool_reuse_keys,
};

#[tokio::test]
async fn downloaded_workflow_paths_are_cleaned_after_finalization_and_exact_reuse() {
    let api = httpmock::MockServer::start_async().await;
    let workflow_id = uuid::Uuid::new_v4();
    let first_run = RunId::new_v4();
    let next_run = RunId::new_v4();
    let mount = "/home/user/.claude/skills/retired-workflow";
    api.mock(|when, then| {
        when.method(httpmock::Method::GET).path(format!(
            "/api/runners/runs/{first_run}/workflows/{workflow_id}"
        ));
        then.status(200).json_body(serde_json::json!({
            "workflowId": workflow_id, "skillMd": "current body", "attachments": null,
        }));
    });
    api.mock(|when, then| {
        when.method(httpmock::Method::PUT);
        then.status(204);
    });
    api.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/api/webhooks/agent/telemetry");
        then.status(200)
            .json_body(serde_json::json!({"success": true, "id": "test"}));
    });
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        8,
        32_768,
        4,
        Arc::clone(&overrides),
        &api.base_url(),
    );
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let runner = tokio::spawn(run(config));
    let reuse_key = "workflow-download-cleanup";
    let mut first = context_with_session(first_run, reuse_key);
    first.storage_manifest = Some(
        serde_json::from_value(serde_json::json!({
            "storageMounts": [],
            "workflowSkills": [{"workflowId": workflow_id, "mountPath": mount}],
        }))
        .unwrap(),
    );
    push_job(&env, first_run, "vm0/default", Some(first));
    let completed = env
        .handle
        .wait_completion(first_run, Duration::from_secs(5))
        .await
        .expect("first Workflow Run must complete");
    assert_eq!(completed.exit_code, 0, "{:?}", completed.error);
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;

    let mut next = context_with_session(next_run, reuse_key);
    next.storage_manifest = Some(
        serde_json::from_value(serde_json::json!({
            "storageMounts": [], "workflowSkills": [],
        }))
        .unwrap(),
    );
    push_job(&env, next_run, "vm0/default", Some(next));
    let reused = env
        .handle
        .wait_completion(next_run, Duration::from_secs(5))
        .await
        .expect("following Run must complete");
    assert_eq!(reused.exit_code, 0, "{:?}", reused.error);
    assert_eq!(reused.sandbox_id, completed.sandbox_id);
    assert!(
        overrides.storage_manifest_calls().iter().any(|call| {
            if call.run_id != next_run.to_string() {
                return false;
            }
            let manifest: guest_contracts::storage_manifest::Manifest =
                serde_json::from_slice(&call.manifest_json).unwrap();
            manifest.cleanup_paths.iter().any(|path| path == mount)
        }),
        "the retained downloaded path must be removed before the next Agent starts"
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 2);
    shutdown(&env, runner).await;
}
