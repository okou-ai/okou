use std::path::Path;

use guest_contracts::file_write::WRITE_FILES_BATCH_CONTENT_LIMIT;
use guest_contracts::workflow_documents::decode;
use runner_types::types::ExecutionContext;
use sandbox::ExecResult;
use sandbox_mock::MockSandbox;

use crate::executor::storage::apply_workflow_skill_documents;
use crate::executor::tests::support::{
    minimal_context, sandbox_write_file_error, test_executor_config, test_telemetry,
};

fn context_with_documents(bodies: &[String]) -> serde_json::Result<ExecutionContext> {
    let mut context = minimal_context();
    context.storage_manifest = Some(serde_json::from_value(serde_json::json!({
        "storageMounts": [],
        "workflowSkills": bodies.iter().enumerate().map(|(index, body)| serde_json::json!({
            "workflowId": uuid::Uuid::new_v4(),
            "mountPath": format!("/home/user/.codex/skills/workflow-{index}"),
            "skillMd": body,
            "attachments": null,
        })).collect::<Vec<_>>()
    }))?);
    Ok(context)
}

#[tokio::test]
async fn workflow_document_groups_preserve_all_bytes_order_and_bounded_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    for count in [0usize, 1, 2, 64, 65, 78, 88] {
        let bodies = (0..count)
            .map(|index| {
                if index % 2 == 0 {
                    String::new()
                } else {
                    format!("Unicode 正文 {index} '$(never execute)'\n")
                }
            })
            .collect::<Vec<_>>();
        let context = context_with_documents(&bodies).unwrap();
        let sandbox = MockSandbox::new("workflow-batches");
        let mut telemetry = test_telemetry(&config, &context);
        apply_workflow_skill_documents(&sandbox, &context, &mut telemetry)
            .await
            .unwrap();
        let writes = sandbox.private_write_files_calls();
        assert_eq!(writes.len(), count.div_ceil(64));
        let files = writes
            .iter()
            .flat_map(|call| &call.files)
            .collect::<Vec<_>>();
        assert_eq!(files.len(), count);
        for (file, document) in files
            .iter()
            .zip(&context.storage_manifest.as_ref().unwrap().workflow_skills)
        {
            assert_eq!(file.content, document.skill_md.as_bytes());
            assert!(
                file.path
                    .ends_with(&format!("/workflow-{}", document.workflow_id))
            );
        }
        for (call, published) in sandbox.exec_calls().iter().zip(&writes) {
            assert!(!call.cmd.contains("never execute"));
            if published.files.len() == 1 {
                assert!(call.cmd.contains(" --skill "));
                assert!(call.stdin_bytes.is_none());
            } else {
                assert!(call.cmd.ends_with(" --skills-stdin"));
                let runtime = Path::new(&published.files[0].path).parent().unwrap();
                let metadata = decode(call.stdin_bytes.as_ref().unwrap(), runtime).unwrap();
                assert_eq!(metadata.len(), published.files.len());
                for (source, file) in metadata.iter().zip(&published.files) {
                    assert_eq!(source.source, file.path);
                    let position = files
                        .iter()
                        .position(|published| published.path == file.path)
                        .unwrap();
                    assert_eq!(
                        source.mount_path,
                        format!("/home/user/.codex/skills/workflow-{position}")
                    );
                }
            }
        }
        assert_eq!(sandbox.exec_calls().len(), writes.len());
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops.len(), if count == 0 { 2 } else { 5 });
        assert!(
            ops.iter()
                .all(|(_, success, error)| *success && error.is_none())
        );
        assert!(ops.iter().all(|(name, _, _)| !name.contains("workflow-")
            && !name.contains(&context.run_id.to_string())));
        assert!(ops[0].0.starts_with("runner_workflow_document_count_"));
        assert!(ops[1].0.starts_with("runner_workflow_document_bytes_"));
    }
}

#[tokio::test]
async fn workflow_document_byte_groups_keep_oversized_individuals_and_continue() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    for sizes in [
        [WRITE_FILES_BATCH_CONTENT_LIMIT, 1, 1],
        [WRITE_FILES_BATCH_CONTENT_LIMIT + 1, 1, 1],
        [8 * 1024 * 1024, 8 * 1024 * 1024, 1],
    ] {
        let context = context_with_documents(
            &sizes
                .iter()
                .map(|size| "x".repeat(*size))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let sandbox = MockSandbox::new("workflow-byte-batches");
        apply_workflow_skill_documents(&sandbox, &context, &mut test_telemetry(&config, &context))
            .await
            .unwrap();
        let writes = sandbox.private_write_files_calls();
        assert_eq!(
            writes
                .iter()
                .map(|call| call.files.len())
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(writes[0].files[0].content.len(), sizes[0]);
        assert_eq!(writes[1].files[0].content.len(), sizes[1]);
        assert_eq!(writes[1].files[1].content.len(), sizes[2]);
        let calls = sandbox.exec_calls();
        assert!(calls[0].cmd.contains(" --skill "));
        assert!(calls[0].stdin_bytes.is_none());
        assert!(calls[1].cmd.ends_with(" --skills-stdin"));
    }
}

#[tokio::test]
async fn workflow_batch_write_and_helper_failures_stop_later_groups() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    for fail_write in [true, false] {
        let context = context_with_documents(&vec!["captured text".into(); 65]).unwrap();
        let sandbox = MockSandbox::new("workflow-failure");
        if fail_write {
            sandbox.push_private_write_files_result(Err(sandbox_write_file_error(
                "partial source batch failed",
            )));
        } else {
            sandbox.push_exec_result(Ok(ExecResult::new(1, Vec::new(), Vec::new())));
        }
        let mut telemetry = test_telemetry(&config, &context);
        assert!(
            apply_workflow_skill_documents(&sandbox, &context, &mut telemetry)
                .await
                .is_err()
        );
        assert_eq!(sandbox.private_write_files_calls().len(), 1);
        assert_eq!(sandbox.exec_calls().len(), usize::from(!fail_write));
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops[0].0, "runner_workflow_document_count_65_plus");
        assert_eq!(ops[1].0, "runner_workflow_document_bytes_le_64_kib");
        assert!(
            ops[2].1,
            "metadata preparation succeeded before the failed operation"
        );
        assert!(ops.iter().all(|(_, _, error)| error.is_none()));
        assert_eq!(ops.len(), if fail_write { 4 } else { 5 });
        assert!(!ops.last().unwrap().1);
        if !fail_write {
            assert!(
                ops[3].1,
                "source publication succeeded before application failed"
            );
        }
    }
}

#[tokio::test]
async fn workflow_source_identity_reuse_keeps_publication_and_consumption_order() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let mut context =
        context_with_documents(&["first".into(), "second".into(), "third".into()]).unwrap();
    let documents = &mut context.storage_manifest.as_mut().unwrap().workflow_skills;
    documents[1].workflow_id = documents[0].workflow_id;
    let sandbox = MockSandbox::new("workflow-identity-reuse");
    apply_workflow_skill_documents(&sandbox, &context, &mut test_telemetry(&config, &context))
        .await
        .unwrap();
    let writes = sandbox.private_write_files_calls();
    assert_eq!(
        writes
            .iter()
            .map(|call| call.files.len())
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(writes[0].files[0].path, writes[1].files[0].path);
    assert_eq!(writes[0].files[0].content, b"first");
    assert_eq!(writes[1].files[0].content, b"second");
    let calls = sandbox.exec_calls();
    assert!(calls[0].cmd.contains(" --skill "));
    let metadata = decode(
        calls[1].stdin_bytes.as_ref().unwrap(),
        Path::new(&writes[1].files[0].path).parent().unwrap(),
    )
    .unwrap();
    assert!(metadata[0].mount_path.ends_with("/workflow-1"));
}
