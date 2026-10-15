use std::sync::Arc;

use sandbox_mock::{
    MockLifecycleGate, MockSandbox, MockSandboxOverrides, StagedFileDispositionCall,
};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

use super::history_prefix_attribution;
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, minimal_context, test_executor_config, test_telemetry,
};
use crate::executor::{
    SessionHistoryMaterializer, SessionHistoryRestorePlan, effective_cli_framework,
};
use crate::test_fixtures::session_history::OneShotSessionHistoryServer;
use runner_types::storage_manifest::{ArtifactEntry, StorageManifest};
use runner_types::types::{
    HomeReuseResult, ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding,
    ResumeSessionHistoryRef, ResumeSessionHistoryRefKind, SandboxReuseResult, SandboxStartupPath,
};

fn workspace_manifest() -> StorageManifest {
    StorageManifest {
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
    }
}

#[tokio::test]
async fn staged_and_serial_restore_preserve_materialization_completion() {
    for staged in [false, true] {
        for (completed, valid, cancelled) in [
            (true, true, false),
            (true, false, false),
            (true, true, true),
            (false, true, false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let config = test_executor_config(dir.path()).await;
            let overrides = Arc::new(MockSandboxOverrides::new());
            let sandbox = Arc::new(MockSandbox::with_overrides("test", Arc::clone(&overrides)));
            let storage_gate = MockLifecycleGate::new();
            overrides.set_storage_manifest_lifecycle_gate(storage_gate.clone());
            let write_gate = MockLifecycleGate::new();
            overrides.set_write_file_lifecycle_gate(write_gate.clone());
            let history = b"{\"type\":\"init\"}\n\xff\n";
            let (request_received, request) = oneshot::channel();
            let mut request = Some(request);
            let release_response = Arc::new(Notify::new());
            let mut server = Some(
                OneShotSessionHistoryServer::respond_once_after_request(
                    history.to_vec(),
                    request_received,
                    Arc::clone(&release_response),
                )
                .await,
            );
            let mut context = minimal_context();
            context.resume_session = Some(ResumeSession {
                cli_agent_session_id: "paired-completion".into(),
                history: ResumeSessionHistory::Ref {
                    history_ref: ResumeSessionHistoryRef {
                        kind: ResumeSessionHistoryRefKind::Blob,
                        hash: hex::encode(Sha256::digest(if valid {
                            history.as_slice()
                        } else {
                            b"wrong".as_slice()
                        })),
                        url: server.as_ref().unwrap().url(),
                        encoding: ResumeSessionHistoryEncoding::Identity,
                        raw_size: history.len() as u64,
                        encoded_size: history.len() as u64,
                        download_source: None,
                    },
                },
            });
            context.storage_manifest = Some(workspace_manifest());
            let mut controls = RunControls::new(CancellationToken::new(), None);
            if completed {
                // Keep task cancellation independent so its terminal result reaches
                // completion instead of racing the enclosing pre-spawn cancellation.
                let task_cancel = CancellationToken::new();
                let materializer =
                    SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
                        &config.http,
                        &config.session_history_cpu,
                        context.resume_session.as_ref(),
                        effective_cli_framework(&context.cli_agent_type),
                        task_cancel.clone(),
                        None,
                        history_prefix_attribution(&history[..4]),
                    );
                tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request.take().unwrap())
                    .await
                    .unwrap()
                    .unwrap();
                release_response.notify_one();
                tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
                    while !materializer.is_download_finished() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                server.take().unwrap().assert_served().await;
                if cancelled {
                    task_cancel.cancel();
                }
                controls = controls.with_session_history_restore_plan(
                    SessionHistoryRestorePlan::Prestarted {
                        materializer,
                        fallback: None,
                    },
                );
            }
            let staging_root = format!(
                "/home/user/.vm0/guest-agent/runs/{}/session-history-restore/",
                context.run_id
            );
            let run_sandbox = Arc::clone(&sandbox);
            let run = tokio::spawn(async move {
                let mut telemetry = test_telemetry(&config, &context);
                let result = run_in_sandbox(
                    &*run_sandbox,
                    &context,
                    &config,
                    RunStart {
                        sandbox_startup_path: if staged {
                            SandboxStartupPath::Home
                        } else {
                            SandboxStartupPath::Cold
                        },
                        restore_guest_state: false,
                        reuse_result: SandboxReuseResult::PoolMiss,
                        home_reuse_result: if staged {
                            HomeReuseResult::Reused
                        } else {
                            HomeReuseResult::NotConfigured
                        },
                        prev_storage: None,
                    },
                    &mut telemetry,
                    controls,
                )
                .await;
                (result, telemetry)
            });

            storage_gate
                .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
                .await
                .unwrap();
            assert!(overrides.start_agent_process_calls().is_empty());
            if !staged {
                storage_gate.release_one();
            }
            if !completed {
                tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request.take().unwrap())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(sandbox.write_file_calls().is_empty());
                assert!(overrides.start_agent_process_calls().is_empty());
                release_response.notify_one();
            }
            let success = valid && !cancelled;
            let final_path =
                "/home/user/.claude/projects/-home-user-workspace/paired-completion.jsonl";
            if success {
                write_gate
                    .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
                    .await
                    .unwrap();
                let writes = sandbox.write_file_calls();
                assert_eq!(writes.len(), 1);
                assert_eq!(writes[0].content, history);
                if staged {
                    assert!(writes[0].path.starts_with(&staging_root));
                } else {
                    assert_eq!(writes[0].path, final_path);
                }
                assert!(overrides.start_agent_process_calls().is_empty());
                assert!(overrides.finalize_staged_file_calls().is_empty());
                write_gate.release_one();
            }
            if staged {
                storage_gate.release_one();
            }
            let (result, telemetry) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run)
                .await
                .unwrap()
                .unwrap();
            if let Some(server) = server {
                server.assert_served().await;
            }
            if success {
                assert!(result.unwrap().failure.is_none());
                assert_eq!(overrides.start_agent_process_calls().len(), 1);
                let publications = overrides.finalize_staged_file_calls();
                if staged {
                    assert_eq!(publications.len(), 1);
                    assert_eq!(
                        publications[0].staging_path,
                        sandbox.write_file_calls()[0].path
                    );
                    assert_eq!(
                        publications[0].disposition,
                        StagedFileDispositionCall::Publish {
                            destination: final_path.into(),
                        }
                    );
                } else {
                    assert!(publications.is_empty());
                }
            } else {
                if cancelled {
                    let failure = result.unwrap().failure.unwrap();
                    assert_eq!(failure.exit_code, 137);
                    assert_eq!(failure.error, "cancelled by user");
                } else {
                    let Err(error) = result else {
                        panic!("invalid history must preserve its original failure");
                    };
                    assert!(matches!(
                        error,
                        crate::error::RunnerError::Internal(message)
                            if message == "session history hash mismatch"
                    ));
                }
                assert!(sandbox.write_file_calls().is_empty());
                assert!(overrides.start_agent_process_calls().is_empty());
                assert!(
                    overrides
                        .finalize_staged_file_calls()
                        .iter()
                        .all(|call| { call.disposition == StagedFileDispositionCall::Discard })
                );
            }

            let ops = telemetry.pending_ops_with_session_history_metadata_snapshot();
            let state = if completed {
                "session_history_materializer_completed_before_restore"
            } else {
                "session_history_materializer_waited_at_restore"
            };
            for action in [
                state,
                "session_history_materialization_wait",
                "session_history_download",
            ] {
                let samples: Vec<_> = ops.iter().filter(|op| op.action_type == action).collect();
                assert_eq!(samples.len(), 1, "{action}: {ops:?}");
                assert_eq!(samples[0].success, success);
                assert_eq!(
                    samples[0].error.as_deref(),
                    if success {
                        None
                    } else if action == "session_history_download" {
                        Some("session history download failed")
                    } else {
                        Some("session history materialization failed")
                    }
                );
                let metadata = samples[0].session_history.unwrap();
                assert_eq!(metadata.encoding(), "identity");
                assert_eq!(metadata.raw_size_bucket(), "lt_64_kib");
                assert_eq!(metadata.encoded_size_bucket(), "lt_64_kib");
                assert_eq!(metadata.compression_ratio_bucket(), "identity");
            }
            assert!(!ops.iter().any(|op| {
                op.action_type
                    == if completed {
                        "session_history_materializer_waited_at_restore"
                    } else {
                        "session_history_materializer_completed_before_restore"
                    }
            }));
            // Cancellation retains attempt attribution but intentionally omits
            // legacy phase observations, even when the bytes already completed.
            for (action, phase_success) in [
                ("session_history_download_request_status", true),
                ("session_history_download_body_read", true),
                ("session_history_download_validation", true),
                ("session_history_download_hash_verification", valid),
            ] {
                let phases: Vec<_> = ops.iter().filter(|op| op.action_type == action).collect();
                if cancelled {
                    assert!(phases.is_empty());
                } else {
                    assert_eq!(phases.len(), 1);
                    assert_eq!(phases[0].success, phase_success);
                }
            }
            assert_eq!(
                ops.iter()
                    .any(|op| op.action_type == "session_history_requested_larger_prefix_verified"),
                completed && success
            );
            if !success {
                assert!(ops.iter().all(|op| {
                    !op.action_type
                        .starts_with("session_history_requested_larger_prefix_")
                }));
            }
            let outcomes = telemetry.pending_ops_with_outcome_snapshot();
            let attribution: Vec<_> = outcomes
                .iter()
                .filter(|op| op.0 == "session_history_download_attribution")
                .collect();
            assert_eq!(attribution.len(), 1);
            assert_eq!(attribution[0].1, success);
            assert_eq!(
                attribution[0].2.as_deref(),
                Some(if cancelled {
                    "cancelled"
                } else if valid {
                    "succeeded"
                } else {
                    "failed"
                })
            );
        }
    }
}

#[tokio::test]
async fn missing_and_inline_history_keep_download_completion_observations_absent() {
    for home_reused in [false, true] {
        for inline in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let config = test_executor_config(dir.path()).await;
            let overrides = Arc::new(MockSandboxOverrides::new());
            let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
            let history = "{\"type\":\"init\"}\n";
            let mut context = minimal_context();
            context.storage_manifest = Some(workspace_manifest());
            context.resume_session =
                inline.then(|| ResumeSession::inline("inline-completion".into(), history.into()));
            let mut telemetry = test_telemetry(&config, &context);
            let result = tokio::time::timeout(
                RUN_IN_SANDBOX_TEST_TIMEOUT,
                run_in_sandbox(
                    &sandbox,
                    &context,
                    &config,
                    RunStart {
                        sandbox_startup_path: if home_reused {
                            SandboxStartupPath::Home
                        } else {
                            SandboxStartupPath::Cold
                        },
                        restore_guest_state: false,
                        reuse_result: SandboxReuseResult::PoolMiss,
                        home_reuse_result: if home_reused {
                            HomeReuseResult::Reused
                        } else {
                            HomeReuseResult::NotConfigured
                        },
                        prev_storage: None,
                    },
                    &mut telemetry,
                    RunControls::new(CancellationToken::new(), None),
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(result.failure.is_none());
            assert_eq!(overrides.start_agent_process_calls().len(), 1);
            let writes = sandbox.write_file_calls();
            let publications = overrides.finalize_staged_file_calls();
            if inline {
                assert_eq!(writes.len(), 1);
                assert_eq!(writes[0].content, history.as_bytes());
                let final_path =
                    "/home/user/.claude/projects/-home-user-workspace/inline-completion.jsonl";
                if home_reused {
                    assert_eq!(publications.len(), 1);
                    assert_eq!(publications[0].staging_path, writes[0].path);
                    assert_eq!(
                        publications[0].disposition,
                        StagedFileDispositionCall::Publish {
                            destination: final_path.into(),
                        }
                    );
                } else {
                    assert_eq!(writes[0].path, final_path);
                    assert!(publications.is_empty());
                }
                let transfers = telemetry.pending_history_transfer_payloads();
                assert_eq!(transfers.len(), 1);
                assert_eq!(transfers[0]["session_history_transfer_source"], "inline");
                assert_eq!(
                    transfers[0]["session_history_transfer_bytes"],
                    history.len()
                );
            } else {
                assert!(writes.is_empty());
                assert!(publications.is_empty());
                assert!(telemetry.pending_history_transfer_payloads().is_empty());
            }
            assert!(telemetry.pending_ops_snapshot().iter().all(|op| {
                !matches!(
                    op.0.as_str(),
                    "session_history_materializer_completed_before_restore"
                        | "session_history_materializer_waited_at_restore"
                        | "session_history_materialization_wait"
                        | "session_history_download"
                        | "session_history_download_attribution"
                )
            }));
        }
    }
}
