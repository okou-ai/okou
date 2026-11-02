use std::collections::HashMap;
use std::sync::Arc;

use guest_contracts::file_write::WRITE_FILES_BATCH_CONTENT_LIMIT;
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};
use tokio_util::sync::CancellationToken;

use crate::executor::env::{
    guest_connector_account_context_file_path, guest_run_payload_file_path,
    guest_user_env_file_path,
};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, default_params, minimal_context,
    run_new_sandbox_outcome, sandbox_write_file_error, spawn_run_in_sandbox_test,
    test_executor_config,
};

#[tokio::test]
async fn bootstrap_keeps_full_oversized_payload_and_original_grouping() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut context = minimal_context();
    context.prompt = "p".repeat(WRITE_FILES_BATCH_CONTENT_LIMIT + 1);
    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 0);
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].files.len(), 3);
    let payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&writes[0].files[2].content).unwrap();
    assert_eq!(payload.prompt, context.prompt);
}

#[tokio::test]
async fn bootstrap_account_batch_failure_never_spawns() {
    for failure in ["source write failed", "account context write failed"] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(failure)));
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let context = minimal_context();
        let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(outcome.exit_code(), 1);
        assert_eq!(overrides.private_write_files_calls().len(), 1);
        assert!(overrides.start_agent_process_calls().is_empty());
    }
}

#[tokio::test]
async fn bootstrap_cancellation_while_publishing_never_applies_or_spawns() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_private_write_file_lifecycle_gate(gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let context = minimal_context();
    let cancel = CancellationToken::new();
    let run = spawn_run_in_sandbox_test(sandbox, context, config, cancel.clone());
    gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    cancel.cancel();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_some());
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn bootstrap_publishes_complete_required_inputs_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut context = minimal_context();
    context.environment = Some(HashMap::from([(
        "USER_VALUE".into(),
        "synthetic-value".into(),
    )]));
    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 0);
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 1);
    let files = &writes[0].files;
    assert_eq!(files.len(), 3);
    assert_eq!(
        files[0].path,
        guest_connector_account_context_file_path(context.run_id).unwrap()
    );
    assert_eq!(
        files[1].path,
        guest_user_env_file_path(context.run_id).unwrap()
    );
    assert_eq!(
        files[2].path,
        guest_run_payload_file_path(context.run_id).unwrap()
    );
    let environment: HashMap<String, String> = serde_json::from_slice(&files[1].content).unwrap();
    assert_eq!(environment.get("USER_VALUE").unwrap(), "synthetic-value");
    let payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&files[2].content).unwrap();
    assert_eq!(payload.prompt, context.prompt);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
}
