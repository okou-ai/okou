use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, minimal_context, test_executor_config, test_telemetry,
};
use crate::executor::{
    SessionHistoryMaterializer, SessionHistoryRestorePlan, effective_cli_framework,
};
use runner_types::storage_manifest::{ArtifactEntry, StorageManifest};
use runner_types::types::{
    HomeReuseResult, ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding,
    ResumeSessionHistoryRef, ResumeSessionHistoryRefKind, SandboxReuseResult,
};

use super::serve_history_once;

const READINESS: &str = "session_history_readiness_at_guest_storage_start";

#[tokio::test]
async fn readiness_observer_keeps_cancellation_ahead_of_completed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let history = br#"{"type":"init"}"#;
    let server = serve_history_once(history).await;
    let session = ResumeSession {
        cli_agent_session_id: "cancelled-handoff-session".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    };
    let cancel = CancellationToken::new();
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        Some(&session),
        effective_cli_framework("claude-code"),
        cancel.clone(),
        None,
    );
    let observer = materializer.readiness_observer();
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        while !materializer.is_download_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    server.assert_served().await;
    assert_eq!(observer.snapshot().outcome(), "ready");
    cancel.cancel();
    assert_eq!(observer.snapshot().outcome(), "cancelled");
    assert!(matches!(
        materializer.finish(&cancel).await,
        crate::executor::session_history_download::SessionHistoryMaterialization::Failed {
            error: crate::error::RunnerError::Cancelled,
            ..
        }
    ));
}

#[tokio::test]
async fn storage_handoff_counts_only_successful_complete_materialization_as_ready() {
    for prepared in [false, true] {
        for valid in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let config = test_executor_config(dir.path()).await;
            let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
            let sandbox = sandbox_mock::MockSandbox::with_overrides("test", Arc::clone(&overrides));
            let history = br#"{"type":"init"}"#;
            let server = serve_history_once(history).await;
            let mut context = minimal_context();
            context.resume_session = Some(ResumeSession {
                cli_agent_session_id: "handoff-session".into(),
                history: ResumeSessionHistory::Ref {
                    history_ref: ResumeSessionHistoryRef {
                        kind: ResumeSessionHistoryRefKind::Blob,
                        hash: hex::encode(Sha256::digest(if valid {
                            history.as_slice()
                        } else {
                            b"wrong".as_slice()
                        })),
                        url: server.url(),
                        encoding: ResumeSessionHistoryEncoding::Identity,
                        raw_size: history.len() as u64,
                        encoded_size: history.len() as u64,
                        download_source: None,
                    },
                },
            });
            context.storage_manifest = Some(StorageManifest {
                storages: vec![],
                artifacts: vec![ArtifactEntry {
                    mount_path: "/home/user/workspace".into(),
                    vas_storage_name: "workspace".into(),
                    vas_storage_id: "workspace-id".into(),
                    vas_version_id: "empty-version".into(),
                    archive_url: None,
                    archive_size: None,
                    empty: Some(true),
                    missing_root_policy: None,
                }],
            });
            let cancel = CancellationToken::new();
            let materializer = SessionHistoryMaterializer::start_cancellable(
                &config.http,
                &config.session_history_cpu,
                context.resume_session.as_ref(),
                effective_cli_framework(&context.cli_agent_type),
                cancel.clone(),
                None,
            );
            tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
                while !materializer.is_download_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            server.assert_served().await;
            let mut telemetry = test_telemetry(&config, &context);
            let mut controls = RunControls::new(cancel.clone(), None)
                .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                    materializer,
                    fallback: None,
                });
            if prepared {
                controls.prepared_storage = crate::executor::sandbox_run::prepare_storage(
                    &context,
                    None,
                    &config,
                    &cancel,
                    &mut telemetry,
                )
                .await
                .unwrap();
                assert!(controls.prepared_storage.is_some());
            }
            let result = run_in_sandbox(
                &sandbox,
                &context,
                &config,
                RunStart {
                    sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
                    restore_guest_state: false,
                    reuse_result: SandboxReuseResult::PoolMiss,
                    home_reuse_result: HomeReuseResult::NotConfigured,
                    prev_storage: None,
                },
                &mut telemetry,
                controls,
            )
            .await;

            let ops = telemetry.pending_ops_with_outcome_snapshot();
            let samples: Vec<_> = ops.iter().filter(|op| op.0 == READINESS).collect();
            assert_eq!(samples.len(), 1);
            assert!(samples[0].1);
            assert_eq!(
                samples[0].2.as_deref(),
                Some(if valid { "ready" } else { "not_ready" })
            );
            let readiness_index = ops.iter().position(|op| op.0 == READINESS).unwrap();
            let storage_index = ops
                .iter()
                .position(|op| op.0 == "runner_storage_manifest_guest_storage_apply")
                .unwrap();
            assert!(readiness_index < storage_index);
            assert_eq!(sandbox.storage_manifest_calls().len(), 1);
            if valid {
                assert!(result.unwrap().failure.is_none());
                let writes = sandbox.write_file_calls();
                assert_eq!(writes.len(), 1);
                assert_eq!(writes[0].content, history);
                assert_eq!(
                    writes[0].path,
                    "/home/user/.claude/projects/-home-user-workspace/handoff-session.jsonl"
                );
                assert_eq!(overrides.start_agent_process_calls().len(), 1);
            } else {
                let error = match result {
                    Ok(_) => panic!("invalid history must fail before spawn"),
                    Err(error) => error,
                };
                assert!(error.to_string().contains("hash mismatch"));
                assert!(sandbox.write_file_calls().is_empty());
                assert!(overrides.start_agent_process_calls().is_empty());
            }
        }
    }
}
