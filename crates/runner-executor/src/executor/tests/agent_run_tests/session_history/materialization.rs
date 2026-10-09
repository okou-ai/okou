use std::io::Write;
use std::sync::Arc;

use flate2::{Compression, write::GzEncoder};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, oneshot};

use super::{history_prefix_attribution, serve_history_once};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::agent_run_tests::support::assert_failed_action_error_once;
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, minimal_context, test_executor_config, test_telemetry,
};
use crate::executor::{
    SessionHistoryMaterializer, SessionHistoryRestorePlan, effective_cli_framework,
};
use crate::telemetry::SessionHistoryTelemetrySnapshot;
use crate::test_fixtures::session_history::OneShotSessionHistoryServer;
use runner_types::types::{
    ResumeSession, ResumeSessionHistory, ResumeSessionHistoryDownloadSource,
    ResumeSessionHistoryEncoding, ResumeSessionHistoryRef, ResumeSessionHistoryRefKind,
    SandboxReuseResult,
};

fn gzip_bytes(raw: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(raw).unwrap();
    encoder.finish().unwrap()
}

fn zstd_bytes(raw: &[u8]) -> Vec<u8> {
    zstd::encode_all(raw, 0).unwrap()
}

async fn serve_history_once_after_request(
    body: &'static [u8],
    request_received: oneshot::Sender<()>,
    release_response: Arc<Notify>,
) -> OneShotSessionHistoryServer {
    OneShotSessionHistoryServer::respond_once_after_request(
        body,
        request_received,
        release_response,
    )
    .await
}
fn assert_successful_action_with_session_history_metadata(
    ops: &[SessionHistoryTelemetrySnapshot],
    action: &str,
    encoding: &str,
    raw_size_bucket: &str,
    encoded_size_bucket: &str,
    compression_ratio_bucket: &str,
) {
    assert!(
        ops.iter().any(|op| {
            op.action_type == action
                && op.success
                && op.session_history.is_some_and(|fields| {
                    fields.encoding() == encoding
                        && fields.raw_size_bucket() == raw_size_bucket
                        && fields.encoded_size_bucket() == encoded_size_bucket
                        && fields.compression_ratio_bucket() == compression_ratio_bucket
                })
        }),
        "expected {action} telemetry with session history metadata, got: {ops:?}"
    );
}

fn assert_successful_action_with_session_history_probe(
    ops: &[SessionHistoryTelemetrySnapshot],
    action: &str,
    seen_recently: &str,
    download_inflight: &str,
) {
    assert!(
        ops.iter().any(|op| {
            op.action_type == action
                && op.success
                && op.session_history.is_some_and(|fields| {
                    fields.ref_seen_recently() == Some(seen_recently)
                        && fields.ref_download_inflight() == Some(download_inflight)
                })
        }),
        "expected {action} telemetry with session history probe metadata, got: {ops:?}"
    );
}

fn assert_successful_action_with_session_history_download_source(
    ops: &[SessionHistoryTelemetrySnapshot],
    action: &str,
    download_source: &str,
) {
    assert!(
        ops.iter().any(|op| {
            op.action_type == action
                && op.success
                && op
                    .session_history
                    .is_some_and(|fields| fields.download_source() == Some(download_source))
        }),
        "expected {action} telemetry with session history download source, got: {ops:?}"
    );
}
#[tokio::test]
async fn run_in_sandbox_materializes_resume_session_history_ref_before_restore() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let history_server = serve_history_once(history).await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: history_server.url(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-ref-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    history_server.assert_served().await;
}

#[tokio::test]
async fn unverifiable_home_candidates_use_owned_authoritative_restore_after_preparation() {
    use guest_contracts::home_cache_history::{
        HomeCacheHistoryProof, HomeCacheHistoryProofBinding,
    };
    use guest_contracts::session_history_identity::SessionHistoryIdentity;
    for (wrong_source, response) in [
        (
            false,
            sandbox::ExecResult::new(0, br#"{"verified":false}"#.to_vec(), Vec::new()),
        ),
        (
            false,
            sandbox::ExecResult::new(0, b"corrupt report".to_vec(), Vec::new()),
        ),
        (false, sandbox::ExecResult::new(2, Vec::new(), Vec::new())),
        (true, sandbox::ExecResult::new(0, Vec::new(), Vec::new())),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let history = br#"{"type":"init"}"#;
        let history_server = serve_history_once(history).await;
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            cli_agent_session_id: "session-home-fallback".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: hex::encode(Sha256::digest(history)),
                    url: history_server.url(),
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: history.len() as u64,
                    encoded_size: history.len() as u64,
                    download_source: None,
                },
            },
        });
        let expected = crate::executor::home_history::expected_history(&ctx).unwrap();
        let mut source = crate::executor::tests::agent_run_tests::support::claude_history_source(
            "session-home-fallback",
        );
        if wrong_source {
            if let guest_contracts::session_history_identity::SessionHistorySourceRef::ClaudeCode {config_dir, ..} = &mut source { *config_dir = "/home/user/stale-config".into(); }
        }
        let identity = SessionHistoryIdentity::new(
            expected.framework,
            expected.session_id_hash,
            expected.history_ref_kind,
            expected.history_hash,
            expected.history_size_bytes,
            source,
        )
        .unwrap();
        let proof = HomeCacheHistoryProof {
            format_version: 1,
            generation: uuid::Uuid::new_v4().to_string(),
            identity,
        };
        let binding = HomeCacheHistoryProofBinding {
            sha256: hex::encode(Sha256::digest(proof.to_json_vec().unwrap())),
            proof,
        };
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.add_exec_result_matcher("verify-home-cache-history", response);
        let sandbox =
            crate::executor::tests::support::create_overridden_sandbox(overrides.clone()).await;
        let mut telemetry = test_telemetry(&config, &ctx);
        let result = run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                home_reuse_result: runner_types::types::HomeReuseResult::Reused,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                .with_session_history_restore_plan(SessionHistoryRestorePlan::HomeCacheCandidate {
                    binding,
                    fallback: None,
                }),
        )
        .await
        .unwrap();
        assert!(result.failure.is_none());
        history_server.assert_served().await;
        let writes = overrides.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].content, history);
        assert_eq!(
            writes[0].path,
            "/home/user/.claude/projects/-home-user-workspace/session-home-fallback.jsonl"
        );
        assert!(
            !telemetry
                .pending_ops_snapshot()
                .iter()
                .any(|op| op.0 == "session_history_restore_skip"
                    || op.0 == "session_history_home_cache_hit")
        );
        assert_eq!(
            overrides
                .exec_calls()
                .iter()
                .filter(|call| call.cmd.contains("verify-home-cache-history"))
                .count(),
            if wrong_source { 0 } else { 1 }
        );
    }
}

#[tokio::test]
async fn run_in_sandbox_records_gzip_session_history_download_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let compressed = gzip_bytes(history);
    let history_server = serve_history_once(&compressed).await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-gzip-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: history_server.url(),
                encoding: ResumeSessionHistoryEncoding::Gzip,
                raw_size: history.len() as u64,
                encoded_size: compressed.len() as u64,
                download_source: Some(ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint),
            },
        },
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-gzip-ref-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_with_session_history_metadata_snapshot();
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download",
        "gzip",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_request_status",
        "gzip",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_body_read",
        "gzip",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_validation",
        "gzip",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_decompression",
        "gzip",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_hash_verification",
        "gzip",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    history_server.assert_served().await;
    assert_successful_action_with_session_history_probe(
        &ops,
        "session_history_download",
        "false",
        "false",
    );
    assert_successful_action_with_session_history_download_source(
        &ops,
        "session_history_download",
        "configured_public_endpoint",
    );
}

#[tokio::test]
async fn run_in_sandbox_records_zstd_session_history_download_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let compressed = zstd_bytes(history);
    let history_server = serve_history_once(&compressed).await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-zstd-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: history_server.url(),
                encoding: ResumeSessionHistoryEncoding::Zstd,
                raw_size: history.len() as u64,
                encoded_size: compressed.len() as u64,
                download_source: None,
            },
        },
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-zstd-ref-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_with_session_history_metadata_snapshot();
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download",
        "zstd",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_request_status",
        "zstd",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_body_read",
        "zstd",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_validation",
        "zstd",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_decompression",
        "zstd",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_hash_verification",
        "zstd",
        "lt_64_kib",
        "lt_64_kib",
        "ge_1",
    );
    history_server.assert_served().await;
    assert_successful_action_with_session_history_probe(
        &ops,
        "session_history_download",
        "false",
        "false",
    );
}

#[tokio::test]
async fn run_in_sandbox_uses_prestarted_session_history_materializer() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let (request_received_tx, request_received_rx) = oneshot::channel();
    let release_response = Arc::new(Notify::new());
    let history_server = serve_history_once_after_request(
        history,
        request_received_tx,
        Arc::clone(&release_response),
    )
    .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-prestarted-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: history_server.url(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });

    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        ctx.resume_session.as_ref(),
        effective_cli_framework(&ctx.cli_agent_type),
        tokio_util::sync::CancellationToken::new(),
        Some(&config.session_history_probe),
    );
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_received_rx)
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
    history_server.assert_served().await;

    let mut telemetry = test_telemetry(&config, &ctx);
    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: None,
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-prestarted-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_with_session_history_metadata_snapshot();
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_materializer_completed_before_restore",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_materialization_wait",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_request_status",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_body_read",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_validation",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_metadata(
        &ops,
        "session_history_download_hash_verification",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_successful_action_with_session_history_probe(
        &ops,
        "session_history_download",
        "false",
        "false",
    );
}

#[tokio::test]
async fn run_in_sandbox_restores_large_inline_codex_history_without_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let mut history =
        "{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-06-04T07:18:08Z\"}}\n"
            .to_string();
    history.push_str(&"{}\n".repeat(22 * 1024));
    assert!(history.len() > 64 * 1024);
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.resume_session = Some(ResumeSession::inline(session_id.into(), history.clone()));

    let mut telemetry = test_telemetry(&config, &ctx);
    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
    );
    assert_eq!(writes[0].content, history.as_bytes());
    assert!(
        sandbox
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("collect_matching_session_entries")),
        "completed fresh cold restore must not scan retained Codex sessions"
    );
    let transfers = telemetry.pending_history_transfer_payloads();
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0]["session_history_transfer_source"], "inline");
    assert_eq!(transfers[0]["session_history_framework"], "codex");
    assert_eq!(
        transfers[0]["session_history_transfer_bytes"],
        history.len()
    );
    assert_eq!(
        transfers[0]["session_history_codec_decision"],
        "below_threshold"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_completed_prestarted_materializer_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let history_server = serve_history_once(history).await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-prestarted-failed-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(b"different")),
                url: history_server.url(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });

    let materializer = SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
        &config.http,
        &config.session_history_cpu,
        ctx.resume_session.as_ref(),
        effective_cli_framework(&ctx.cli_agent_type),
        tokio_util::sync::CancellationToken::new(),
        None,
        history_prefix_attribution(&history[..4]),
    );
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        while !materializer.is_download_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    history_server.assert_served().await;

    let mut telemetry = test_telemetry(&config, &ctx);
    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: None,
            }),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("expected completed prestarted materializer failure"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("hash mismatch"));
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "session_history_materializer_completed_before_restore",
        "session history materialization failed",
    );
    assert_failed_action_error_once(
        &ops,
        "session_history_download",
        "session history download failed",
    );
    assert_failed_action_error_once(
        &ops,
        "session_history_download_hash_verification",
        "session history download phase failed",
    );
    assert!(
        ops.iter()
            .all(|op| !op.0.starts_with("session_history_requested_larger_prefix_")),
        "failed materialization must not emit prefix attribution telemetry: {ops:?}"
    );
}
