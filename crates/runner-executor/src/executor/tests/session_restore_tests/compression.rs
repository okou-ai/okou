use super::*;
use sandbox::{FileCompression, SandboxError, SandboxOperation, SandboxOperationReason};

#[tokio::test]
async fn history_business_selects_compression_without_changing_restored_bytes() {
    for framework in ["claude-code", "codex", "pi"] {
        for size in [16 * 1024 * 1024 - 1, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1] {
            let sandbox = MockSandbox::new("history-policy");
            let mut context = minimal_context();
            context.cli_agent_type = framework.into();
            let history = vec![b'x'; size];
            let session = materialized_bytes_session(CODEX_SESSION_ID, &history);
            let diagnostics = restore_session_in_fresh_sandbox(&sandbox, &context, &session)
                .await
                .unwrap();
            let writes = sandbox.write_file_calls();
            assert_eq!(writes.len(), 1);
            assert_eq!(writes[0].content, history);
            assert_eq!(diagnostics.bytes_in, size);
            let metadata = serde_json::to_value(&diagnostics.transfer).unwrap();
            assert_eq!(metadata["session_history_transfer_bytes"], size);
            assert_eq!(metadata["session_history_restore_representation"], "raw");
            assert_eq!(
                metadata["session_history_codec_decision"],
                if size < 16 * 1024 * 1024 {
                    "below_threshold"
                } else {
                    "above_threshold"
                }
            );
            assert_eq!(
                metadata["session_history_wire_codec"],
                if size < 16 * 1024 * 1024 {
                    "none"
                } else {
                    "zstd"
                }
            );
            assert!(metadata.get("session_history_wire_bytes").is_none());
            assert_eq!(
                writes[0].compression,
                if size < 16 * 1024 * 1024 {
                    FileCompression::None
                } else {
                    FileCompression::Zstd
                },
                "{framework} with {size} bytes"
            );
        }
    }
}

#[tokio::test]
async fn native_codex_zstd_representation_is_not_recompressed() {
    let mut state = 32931_u64;
    let raw = (0..17 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 32) as u8
        })
        .collect::<Vec<_>>();
    let encoded = zstd::stream::encode_all(raw.as_slice(), -1).unwrap();
    assert!(encoded.len() > 16 * 1024 * 1024);
    let session = materialized_codex_zstd_session(
        CODEX_SESSION_ID,
        &encoded,
        "2026-06-04T07:18:08Z".parse().unwrap(),
    );
    let sandbox = MockSandbox::new("native-zstd");
    let diagnostics = restore_session_in_fresh_sandbox(&sandbox, &codex_context(), &session)
        .await
        .unwrap();
    let metadata = serde_json::to_value(&diagnostics.transfer).unwrap();
    assert_eq!(metadata["session_history_codec_decision"], "native_zstd");
    assert_eq!(metadata["session_history_wire_codec"], "none");
    assert_eq!(
        metadata["session_history_restore_representation"],
        "codex_zstd"
    );
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].compression, FileCompression::None);
    assert_eq!(writes[0].content, encoded);
    assert_eq!(
        writes[0].path,
        format!("{CODEX_CANONICAL_ROLLOUT_PATH}.zst")
    );
}

#[tokio::test]
async fn compressed_history_failure_is_propagated_without_raw_retry() {
    let sandbox = MockSandbox::new("failed-history");
    sandbox.push_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "compressed transfer failure".into(),
    }));
    let session = materialized_bytes_session(CODEX_SESSION_ID, &vec![b'x'; 16 * 1024 * 1024]);
    let error = restore_session_in_fresh_sandbox(&sandbox, &codex_context(), &session)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        crate::error::RunnerError::Sandbox(SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            ..
        })
    ));
    assert_eq!(sandbox.write_file_calls().len(), 1);
}

#[tokio::test]
async fn large_low_compressibility_text_uses_compressed_transfer() {
    let sandbox = MockSandbox::new("low-benefit");
    let mut state = 34573_u64;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut history = (0..16 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            alphabet[((state >> 32) & 63) as usize]
        })
        .collect::<Vec<_>>();
    // Text histories can mix repetitive headers with low-compressibility payloads.
    history[..64 * 1024].fill(b'x');
    let session = materialized_bytes_session(CODEX_SESSION_ID, &history);
    let diagnostics = restore_session_in_fresh_sandbox(&sandbox, &codex_context(), &session)
        .await
        .unwrap();
    let metadata = serde_json::to_value(&diagnostics.transfer).unwrap();
    assert_eq!(
        metadata["session_history_codec_decision"],
        "above_threshold"
    );
    assert_eq!(metadata["session_history_wire_codec"], "zstd");
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].compression, FileCompression::Zstd);
    assert_eq!(writes[0].content, history);
}
