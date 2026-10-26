use std::collections::HashMap;
use std::sync::Arc;

use guest_contracts::file_write::WRITE_FILES_BATCH_CONTENT_LIMIT;
use sandbox::ExecResult;
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};
use tokio_util::sync::CancellationToken;

use crate::executor::env::{
    build_user_env_json, guest_connector_account_context_file_path, guest_run_payload_file_path,
    guest_user_env_file_path, prepare_required_agent_files, prepare_run_payload_for_run,
};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, default_params, minimal_context,
    run_new_sandbox_outcome, sandbox_write_file_error, spawn_run_in_sandbox_test,
    test_executor_config,
};

#[tokio::test]
async fn bootstrap_batches_current_instructions_including_authoritative_empty_body() {
    for instructions in [None, Some(""), Some("Unicode 指令\n'$(never execute)'")] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut context = minimal_context();
        context.agent_instructions = instructions.map(str::to_owned);
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
        let offset = usize::from(instructions.is_some());
        assert_eq!(writes[0].files.len(), 3 + offset);
        if let Some(body) = instructions {
            assert_eq!(writes[0].files[0].content, body.as_bytes());
            assert!(writes[0].files[0].path.ends_with("/agent-instructions"));
        }
        let files = &writes[0].files[offset..];
        assert_eq!(
            files[0].path,
            guest_connector_account_context_file_path(context.run_id).unwrap()
        );
        let account: guest_contracts::connector_account_context::RunConnectorAccountContext =
            serde_json::from_slice(&files[0].content).unwrap();
        assert!(account.targets.is_empty());
        assert_eq!(
            files[1].path,
            guest_user_env_file_path(context.run_id).unwrap()
        );
        let environment: HashMap<String, String> =
            serde_json::from_slice(&files[1].content).unwrap();
        assert_eq!(environment.get("USER_VALUE").unwrap(), "synthetic-value");
        assert_eq!(
            environment
                .get(guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV)
                .unwrap(),
            &files[0].path
        );
        assert_eq!(
            files[2].path,
            guest_run_payload_file_path(context.run_id).unwrap()
        );
        let payload: guest_contracts::env::RunPayload =
            serde_json::from_slice(&files[2].content).unwrap();
        assert_eq!(payload.prompt, context.prompt);
        let helpers = overrides
            .exec_calls()
            .into_iter()
            .filter(|call| call.cmd.contains(" --instructions "))
            .collect::<Vec<_>>();
        assert_eq!(helpers.len(), offset);
        assert!(
            helpers
                .iter()
                .all(|call| !call.cmd.contains("never execute"))
        );
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
    }
}

#[tokio::test]
async fn bootstrap_preserves_separate_groups_above_combined_content_limit() {
    for extra in [0, 1] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut context = minimal_context();
        let payload = prepare_run_payload_for_run(&context)
            .unwrap()
            .into_run_payload(&context)
            .unwrap();
        let prepared =
            prepare_required_agent_files(&context, &mut build_user_env_json(&context), &payload)
                .unwrap();
        let required_bytes: usize = prepared
            .entries()
            .iter()
            .map(|file| file.content.len())
            .sum();
        context.agent_instructions =
            Some("x".repeat(WRITE_FILES_BATCH_CONTENT_LIMIT - required_bytes + extra));
        let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(outcome.exit_code(), 0);
        let writes = overrides.private_write_files_calls();
        assert_eq!(writes.len(), 1 + extra);
        if extra == 0 {
            assert_eq!(writes[0].files.len(), 4);
        } else {
            assert_eq!(writes[0].files.len(), 1);
            assert_eq!(writes[1].files.len(), 3);
        }
        assert_eq!(
            writes[0].files[0].content,
            context.agent_instructions.unwrap().as_bytes()
        );
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
    }
}

#[tokio::test]
async fn bootstrap_keeps_full_oversized_payload_and_original_grouping() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut context = minimal_context();
    context.agent_instructions = Some("current instructions".into());
    context.prompt = "p".repeat(WRITE_FILES_BATCH_CONTENT_LIMIT + 1);
    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 0);
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].files.len(), 1);
    assert_eq!(writes[1].files.len(), 3);
    let payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&writes[1].files[2].content).unwrap();
    assert_eq!(payload.prompt, context.prompt);
}

#[tokio::test]
async fn bootstrap_source_or_account_batch_failure_never_applies_or_spawns() {
    for failure in ["source write failed", "account context write failed"] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(failure)));
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut context = minimal_context();
        context.agent_instructions = Some("current instructions".into());
        let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(outcome.exit_code(), 1);
        assert_eq!(overrides.private_write_files_calls().len(), 1);
        assert!(
            overrides
                .exec_calls()
                .iter()
                .all(|call| !call.cmd.contains(" --instructions "))
        );
        assert!(overrides.start_agent_process_calls().is_empty());
    }
}

#[tokio::test]
async fn bootstrap_instruction_helper_failure_stops_after_the_combined_write() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_result_matcher(
        " --instructions ",
        ExecResult::new(1, Vec::new(), Vec::new()),
    );
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut context = minimal_context();
    context.agent_instructions = Some("current instructions".into());
    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert_eq!(overrides.private_write_files_calls()[0].files.len(), 4);
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn bootstrap_preserves_workflow_order_and_stops_on_document_helper_failure() {
    for fail_first in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        if fail_first {
            overrides.add_exec_result_matcher(
                " --skill /home/user/.codex/skills/first-workflow ",
                ExecResult::new(1, Vec::new(), Vec::new()),
            );
        }
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut context = minimal_context();
        context.agent_instructions = Some("current instructions".into());
        context.storage_manifest = Some(serde_json::from_value(serde_json::json!({
            "storageMounts": [],
            "workflowSkills": [
                {"workflowId": uuid::Uuid::new_v4(), "mountPath": "/home/user/.codex/skills/first-workflow", "skillMd": "first document", "attachments": null},
                {"workflowId": uuid::Uuid::new_v4(), "mountPath": "/home/user/.codex/skills/second-workflow", "skillMd": "second document", "attachments": null}
            ]
        })).unwrap());
        let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(outcome.exit_code(), i32::from(fail_first));
        let writes = overrides.private_write_files_calls();
        assert_eq!(writes.len(), if fail_first { 2 } else { 3 });
        assert_eq!(writes[0].files.len(), 4);
        assert_eq!(writes[1].files[0].content, b"first document");
        let helpers = overrides
            .exec_calls()
            .into_iter()
            .filter(|call| call.cmd.contains(" --instructions ") || call.cmd.contains(" --skill "))
            .collect::<Vec<_>>();
        assert!(helpers[0].cmd.contains(" --instructions "));
        assert!(helpers[1].cmd.contains("/first-workflow "));
        if !fail_first {
            assert_eq!(writes[2].files[0].content, b"second document");
            assert!(helpers[2].cmd.contains("/second-workflow "));
        }
        assert_eq!(
            overrides.start_agent_process_calls().len(),
            usize::from(!fail_first)
        );
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
    let mut context = minimal_context();
    context.agent_instructions = Some("current instructions".into());
    let cancel = CancellationToken::new();
    let run = spawn_run_in_sandbox_test(sandbox, context, config, cancel.clone());
    gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains(" --instructions "))
    );
    cancel.cancel();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_some());
    assert!(overrides.start_agent_process_calls().is_empty());
}
