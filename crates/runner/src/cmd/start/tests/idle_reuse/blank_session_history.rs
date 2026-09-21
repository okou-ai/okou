use std::io::Write;

use guest_contracts::env::CliFramework;
use sandbox::{
    StagedFileFinalizeMeasurements, StagedFileFinalizeOutcome, StagedFileNotPublishedReason,
};
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides, StagedFileDispositionCall};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config_with_overrides, push_job, shutdown, test_profiles,
    wait_cancel_handle, wait_idle_pool_len,
};
use crate::storage_manifest::{ArtifactEntry, StorageManifest};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use crate::types::{
    ExecutionContext, ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding,
    ResumeSessionHistoryRef, ResumeSessionHistoryRefKind, SandboxReuseResult,
};

const WAIT: Duration = Duration::from_secs(5);
// Full-workspace coverage instrumentation can delay decoding and validation
// between the remote response and the mock Guest write. The write is still
// deterministically gated; only this CPU-heavy transition needs extra headroom.
const INSTRUMENTED_WRITE_WAIT: Duration = Duration::from_secs(30);
const HISTORY: &[u8] = b"{\"type\":\"init\"}\n";

#[derive(Clone, Copy, Eq, PartialEq)]
enum PublicationExpectation {
    Published,
    SerialRecovery,
    SerialRecoveryCleanupFailure,
    AmbiguousFailure,
}

pub(super) fn history_context(run_id: RunId, url: String, history: &[u8]) -> ExecutionContext {
    let mut context = minimal_context(run_id);
    context.cli_agent_type = "claude-code".into();
    context.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-blank-history".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url,
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
    context
}

#[tokio::test]
async fn blank_history_prestart_overlaps_storage_and_preserves_restore() {
    for (framework, keyed, encoding, publication) in [
        (
            CliFramework::ClaudeCode,
            true,
            ResumeSessionHistoryEncoding::Identity,
            PublicationExpectation::Published,
        ),
        (
            CliFramework::Pi,
            false,
            ResumeSessionHistoryEncoding::Gzip,
            PublicationExpectation::SerialRecovery,
        ),
        (
            CliFramework::Codex,
            true,
            ResumeSessionHistoryEncoding::Zstd,
            PublicationExpectation::Published,
        ),
        (
            CliFramework::ClaudeCode,
            true,
            ResumeSessionHistoryEncoding::Identity,
            PublicationExpectation::AmbiguousFailure,
        ),
        (
            CliFramework::ClaudeCode,
            true,
            ResumeSessionHistoryEncoding::Identity,
            PublicationExpectation::SerialRecoveryCleanupFailure,
        ),
    ] {
        let (framework, history, session_id, expected_path, storage_root): (
            &str,
            &[u8],
            &str,
            String,
            &str,
        ) = match framework {
            CliFramework::ClaudeCode => (
                "claude-code",
                HISTORY,
                "sess-blank-history",
                "/home/user/.claude/projects/-home-user-workspace/sess-blank-history.jsonl".into(),
                "/home/user/.claude/projects/-home-user-workspace",
            ),
            CliFramework::Pi => (
                "pi",
                br#"{"type":"session","version":3,"id":"22222222-2222-4222-8222-222222222222","timestamp":"2026-07-13T01:02:03Z","cwd":"/home/user/workspace"}"#,
                "22222222-2222-4222-8222-222222222222",
                format!("{}/restored-22222222-2222-4222-8222-222222222222.jsonl",
                    api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR),
                "/home/user/.pi/agent/sessions/--home-user-workspace--",
            ),
            CliFramework::Codex => (
                "codex",
                br#"{"type":"session_meta","payload":{"id":"019e9154-c304-70f0-adde-36efb1be1701","timestamp":"2026-07-13T01:02:03Z"}}"#,
                "019e9154-c304-70f0-adde-36efb1be1701",
                "/home/user/.codex/sessions/2026/07/13/rollout-2026-07-13T01-02-03-019e9154-c304-70f0-adde-36efb1be1701.jsonl.zst".into(),
                "/home/user/.codex/sessions",
            ),
        };
        let encoded = match encoding {
            ResumeSessionHistoryEncoding::Identity => history.to_vec(),
            ResumeSessionHistoryEncoding::Gzip => {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(history).unwrap();
                encoder.finish().unwrap()
            }
            ResumeSessionHistoryEncoding::Zstd => zstd::encode_all(history, 0).unwrap(),
        };
        let (release_history, history_release) = oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: history_release,
            response: http_response("200 OK", &encoded),
        }])
        .await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        match publication {
            PublicationExpectation::Published => {}
            PublicationExpectation::SerialRecovery
            | PublicationExpectation::SerialRecoveryCleanupFailure => {
                overrides.push_finalize_staged_file_result(Ok(
                    StagedFileFinalizeOutcome::NotPublished {
                        reason: StagedFileNotPublishedReason::CopyFailed,
                        measurements: StagedFileFinalizeMeasurements::default(),
                    },
                ));
                if publication == PublicationExpectation::SerialRecoveryCleanupFailure {
                    overrides.push_finalize_staged_file_result(Ok(
                        StagedFileFinalizeOutcome::NotPublished {
                            reason: StagedFileNotPublishedReason::DiscardFailed,
                            measurements: StagedFileFinalizeMeasurements::default(),
                        },
                    ));
                }
            }
            PublicationExpectation::AmbiguousFailure => {
                overrides.push_finalize_staged_file_result(Err(sandbox::SandboxError::Operation {
                    operation: sandbox::SandboxOperation::FinalizeStagedFile,
                    reason: sandbox::SandboxOperationReason::Other,
                    message: "ambiguous publication".into(),
                }));
            }
        }
        let storage_gate = MockLifecycleGate::new();
        overrides.set_storage_manifest_lifecycle_gate(storage_gate.clone());
        let write_gate = MockLifecycleGate::new();
        overrides.set_write_file_lifecycle_gate(write_gate.clone());
        let finalize_gate = MockLifecycleGate::new();
        overrides.set_finalize_staged_file_lifecycle_gate(finalize_gate.clone());
        let process_gate = MockLifecycleGate::new();
        overrides.set_start_process_lifecycle_gate(process_gate.clone());
        let (config, env) =
            mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, Arc::clone(&overrides));
        let budget = Arc::clone(&config.capacity.budget);
        let run_handle = tokio::spawn(run(config));
        wait_idle_pool_len(&env.idle_pool, 1, WAIT).await;
        let blank_id = env.idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;
        let run_id = RunId::new_v4();
        let mut context = history_context(run_id, server.url(), history);
        context.cli_agent_type = framework.into();
        context.storage_manifest.as_mut().unwrap().artifacts[0].mount_path = storage_root.into();
        if framework == "pi" {
            context.pi_session_id = Some(session_id.into());
            context.pi_launch_config = Some(serde_json::json!({
                "schemaVersion": 2,
                "apiFirstTurn": {
                    "schemaVersion": 1,
                    "resourceSnapshotDigest": "a".repeat(64),
                    "manifestUrl": server.url(),
                    "sessionUrl": server.url(),
                    "deadlineAt": 2_000_000_000_000_u64,
                    "baseSession": {"sessionId": session_id, "sha256": null},
                    "sandboxEventSequenceStart": 1
                }
            }));
            context.pi_model_config = Some(serde_json::json!({
                "provider": "deepseek",
                "baseUrl": server.url(),
                "model": "deepseek-v4-flash",
                "apiKeyEnv": "OPENAI_API_KEY",
                "credentialSecretName": "DEEPSEEK_API_KEY"
            }));
        }
        context.reuse_key = keyed.then(|| "thread:blank-history".into());
        let resume_session = context.resume_session.as_mut().unwrap();
        resume_session.cli_agent_session_id = session_id.into();
        let ResumeSessionHistory::Ref { history_ref } = &mut resume_session.history else {
            panic!("fixture should use remote history");
        };
        history_ref.encoding = encoding;
        history_ref.encoded_size = encoded.len() as u64;
        push_job(&env, run_id, "vm0/default", Some(context));

        storage_gate.wait_entered(1, WAIT).await.unwrap();
        let storage_calls = overrides.storage_manifest_calls();
        assert_eq!(storage_calls.len(), 1);
        let guest_manifest: guest_contracts::storage_manifest::Manifest =
            serde_json::from_slice(&storage_calls[0].manifest_json).unwrap();
        assert_eq!(guest_manifest.artifacts[0].mount_path, storage_root);
        // Storage is still blocked: release materialization and prove the
        // exact history bytes are staged without touching the canonical path.
        server
            .next_request("blank history before storage finishes")
            .await;
        release_history.send(()).unwrap();
        write_gate
            .wait_entered(1, INSTRUMENTED_WRITE_WAIT)
            .await
            .unwrap();
        let writes = overrides.write_file_calls();
        assert_eq!(writes.len(), 1);
        let restored = if framework == "codex" {
            encoded.as_slice()
        } else {
            history
        };
        assert_eq!(writes[0].content, restored);
        let staging_root =
            format!("/home/user/.vm0/guest-agent/runs/{run_id}/session-history-restore/");
        assert!(writes[0].path.starts_with(&staging_root));
        assert_ne!(writes[0].path, expected_path);
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(overrides.finalize_staged_file_calls().is_empty());
        write_gate.release_one();

        // Canonical publication is ordered after storage completion.
        storage_gate.release_one();
        finalize_gate.wait_entered(1, WAIT).await.unwrap();
        let finalizations = overrides.finalize_staged_file_calls();
        assert_eq!(finalizations.len(), 1);
        assert_eq!(finalizations[0].staging_path, writes[0].path);
        assert_eq!(
            finalizations[0].disposition,
            StagedFileDispositionCall::Publish {
                destination: expected_path.clone(),
            }
        );
        finalize_gate.release_one();

        if publication == PublicationExpectation::AmbiguousFailure {
            let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
            assert_ne!(completion.exit_code, 0);
            assert!(
                completion
                    .error
                    .as_deref()
                    .is_some_and(|error| error.contains("ambiguous publication"))
            );
            assert_eq!(overrides.write_file_calls().len(), 1);
            assert_eq!(overrides.finalize_staged_file_calls().len(), 1);
            assert!(overrides.start_agent_process_calls().is_empty());
            server.assert_finished().await;
            shutdown(&env, run_handle).await;
            assert_eq!(budget.allocated().2, 0);
            continue;
        }

        if matches!(
            publication,
            PublicationExpectation::SerialRecovery
                | PublicationExpectation::SerialRecoveryCleanupFailure
        ) {
            write_gate.wait_entered(2, WAIT).await.unwrap();
            let writes = overrides.write_file_calls();
            assert_eq!(writes.len(), 2);
            assert_eq!(writes[1].path, expected_path);
            assert_eq!(writes[1].content, restored);
            write_gate.release_one();

            finalize_gate.wait_entered(2, WAIT).await.unwrap();
            let finalizations = overrides.finalize_staged_file_calls();
            assert_eq!(finalizations.len(), 2);
            assert_eq!(finalizations[1].staging_path, writes[0].path);
            assert_eq!(
                finalizations[1].disposition,
                StagedFileDispositionCall::Discard
            );
            finalize_gate.release_one();

            if publication == PublicationExpectation::SerialRecoveryCleanupFailure {
                let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
                assert_ne!(completion.exit_code, 0);
                assert!(completion.error.as_deref().is_some_and(|error| {
                    error.contains("staged session history remained after serial recovery")
                }));
                assert!(overrides.start_agent_process_calls().is_empty());
                server.assert_finished().await;
                shutdown(&env, run_handle).await;
                assert_eq!(budget.allocated().2, 0);
                continue;
            }
        }

        process_gate.wait_entered(1, WAIT).await.unwrap();
        process_gate.release_one();
        let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
        assert_eq!(completion.exit_code, 0);
        assert_eq!(completion.sandbox_id, Some(blank_id));
        assert_eq!(
            completion.reuse_result,
            Some(if keyed {
                SandboxReuseResult::PoolMiss
            } else {
                SandboxReuseResult::NoReuseKey
            })
        );
        // The one-response server and successful restore require one download;
        // a second materialization cannot obtain another history response.
        server.assert_finished().await;
        shutdown(&env, run_handle).await;
        assert_eq!(budget.allocated().2, 0);
    }
}

#[tokio::test]
async fn blank_history_storage_failure_precedes_staging_failure() {
    let (release_history, history_release) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: history_release,
        response: http_response("200 OK", HISTORY),
    }])
    .await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_storage_manifest_result(Ok(sandbox::ExecResult::new(
        1,
        Vec::new(),
        "storage preparation failed".into(),
    )));
    overrides.push_write_file_result(Err(sandbox::SandboxError::Operation {
        operation: sandbox::SandboxOperation::WriteFile,
        reason: sandbox::SandboxOperationReason::Other,
        message: "staging write failed".into(),
    }));
    let storage_gate = MockLifecycleGate::new();
    overrides.set_storage_manifest_lifecycle_gate(storage_gate.clone());
    let write_gate = MockLifecycleGate::new();
    overrides.set_write_file_lifecycle_gate(write_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_idle_pool_len(&env.idle_pool, 1, WAIT).await;
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(history_context(run_id, server.url(), HISTORY)),
    );

    storage_gate.wait_entered(1, WAIT).await.unwrap();
    server
        .next_request("history for dual preparation failure")
        .await;
    release_history.send(()).unwrap();
    write_gate
        .wait_entered(1, INSTRUMENTED_WRITE_WAIT)
        .await
        .unwrap();
    write_gate.release_one();
    storage_gate.release_one();

    let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_ne!(completion.exit_code, 0);
    let error = completion.error.as_deref().unwrap();
    assert!(error.contains("storage preparation failed"), "{error}");
    assert!(!error.contains("staging write failed"), "{error}");
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.write_file_calls().len(), 1);
    assert_eq!(overrides.finalize_staged_file_calls().len(), 1);
    assert_eq!(
        overrides.finalize_staged_file_calls()[0].disposition,
        StagedFileDispositionCall::Discard
    );
    server.assert_finished().await;
    shutdown(&env, run_handle).await;
    assert_eq!(budget.allocated().2, 0);
}

#[tokio::test]
async fn blank_history_prestart_is_cancelled_on_storage_failure_and_shutdown() {
    for storage_failure in [true, false] {
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        let storage_gate = MockLifecycleGate::new();
        overrides.set_storage_manifest_lifecycle_gate(storage_gate.clone());
        if storage_failure {
            overrides.push_storage_manifest_result(Ok(sandbox::ExecResult::new(
                1,
                Vec::new(),
                "storage preparation failed".into(),
            )));
        }
        let (config, env) =
            mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, Arc::clone(&overrides));
        let budget = Arc::clone(&config.capacity.budget);
        let run_handle = tokio::spawn(run(config));
        wait_idle_pool_len(&env.idle_pool, 1, WAIT).await;
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(history_context(run_id, server.url(), HISTORY)),
        );
        storage_gate.wait_entered(1, WAIT).await.unwrap();
        server.next_request("pending blank history").await;
        if storage_failure {
            storage_gate.release_one();
        } else {
            env.trigger_stopping().await;
            // An admitted Guest storage operation owns its terminal result.
            storage_gate.release_one();
        }
        let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
        assert_ne!(completion.exit_code, 0);
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(overrides.write_file_calls().is_empty());
        // Prove the client cancelled its HTTP request without releasing a
        // response, instead of just checking that the sandbox eventually exits.
        server.assert_finished().await;
        shutdown(&env, run_handle).await;
        assert_eq!(budget.allocated().2, 0);
    }
}

#[tokio::test]
async fn blank_history_prestart_run_cancellation_drops_pending_download() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let storage_gate = MockLifecycleGate::new();
    overrides.set_storage_manifest_lifecycle_gate(storage_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_idle_pool_len(&env.idle_pool, 1, WAIT).await;
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(history_context(run_id, server.url(), HISTORY)),
    );
    storage_gate.wait_entered(1, WAIT).await.unwrap();
    server
        .next_request("blank history before cancellation")
        .await;
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, WAIT).await;
    cancellation.request_hard_cancellation().await;
    // Hard cancellation prevents publication and process spawn but does not
    // abandon an admitted Guest storage operation.
    storage_gate.release_one();
    let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(completion.exit_code, 137);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.write_file_calls().is_empty());
    server.assert_finished().await;
    shutdown(&env, run_handle).await;
    assert_eq!(budget.allocated().2, 0);
}

#[tokio::test]
async fn blank_history_prestart_validation_failure_never_spawns() {
    let mut corrupted = HISTORY.to_vec();
    corrupted[0] = b'!';
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(http_response(
        "200 OK", &corrupted,
    ))])
    .await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_idle_pool_len(&env.idle_pool, 1, WAIT).await;
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(history_context(run_id, server.url(), HISTORY)),
    );
    let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_ne!(completion.exit_code, 0);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.write_file_calls().is_empty());
    server.assert_finished().await;
    shutdown(&env, run_handle).await;
    assert_eq!(budget.allocated().2, 0);
}
