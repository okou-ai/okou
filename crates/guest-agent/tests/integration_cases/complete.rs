use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

const TEST_RUN_ID: &str = "test-run-001";
const TEST_SANDBOX_ID: &str = "00000000-0000-4000-8000-000000000abc";
const TEST_SANDBOX_REUSE_RESULT: &str = "reused";
const TEST_WORKSPACE_REUSE_RESULT: &str = "sandboxReused";

// =========================================================================
// Complete webhook
//
// Checkpoint-less completion is retained only for explicit cancellation when
// recovery preparation or combined reporting cannot be acknowledged. The
// runner's POST still fires on VM exit and is absorbed by idempotency.
// =========================================================================

#[tokio::test]
async fn cancellation_fallback_posts_full_payload_when_metadata_present() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .header("Authorization", "Bearer test-token-abc123")
            .json_body(json!({
                "runId": TEST_RUN_ID,
                "exitCode": 1,
                "lastEventSequence": 7,
                "sandboxId": TEST_SANDBOX_ID,
                "sandboxReuseResult": TEST_SANDBOX_REUSE_RESULT,
                "workspaceReuseResult": TEST_WORKSPACE_REUSE_RESULT,
            }));
        then.status(200).json_body(json!({
            "success": true,
            "status": "completed",
        }));
    });

    guest_agent::complete::report_user_cancellation_for_run(
        &http_client!(),
        TEST_RUN_ID,
        TEST_SANDBOX_ID,
        TEST_SANDBOX_REUSE_RESULT,
        TEST_WORKSPACE_REUSE_RESULT,
        Some(7),
    )
    .await;

    mock.assert_calls_async(1).await;
}

/// Unset canonical runner metadata (guest launched without `OKOU_SANDBOX_ID` /
/// `OKOU_SANDBOX_REUSE_RESULT`): empty strings must serialize as absent so the
/// payload carries only `runId` + `exitCode`. Matches the
/// `skip_serializing_if = "Option::is_none"` contract end-to-end.
#[tokio::test]
async fn cancellation_fallback_omits_metadata_when_env_absent() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body(json!({
                "runId": TEST_RUN_ID,
                "exitCode": 1,
            }));
        then.status(200).json_body(json!({"success": true}));
    });

    guest_agent::complete::report_user_cancellation_for_run(
        &http_client!(),
        TEST_RUN_ID,
        "",
        "",
        "",
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn cancellation_fallback_swallows_server_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(500);
    });

    // 1 attempt — no retry, no panic. Fire-and-forget semantics mean the
    // runner fallback is the correctness guarantee.
    guest_agent::complete::report_user_cancellation_for_run(
        &http_client!(),
        TEST_RUN_ID,
        TEST_SANDBOX_ID,
        TEST_SANDBOX_REUSE_RESULT,
        TEST_WORKSPACE_REUSE_RESULT,
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
}

/// 4xx takes a different branch in `post_json` than 5xx: it returns Err
/// immediately without retrying. Production is most likely to hit 401 when
/// the sandbox token has expired by the time /complete fires. Verify the
/// error still swallows cleanly and the runner fallback will be the only
/// call that actually transitions the run.
#[tokio::test]
async fn cancellation_fallback_swallows_4xx_auth_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(401).json_body(json!({
            "error": { "message": "Run expired", "code": "UNAUTHORIZED" }
        }));
    });

    guest_agent::complete::report_user_cancellation_for_run(
        &http_client!(),
        TEST_RUN_ID,
        TEST_SANDBOX_ID,
        TEST_SANDBOX_REUSE_RESULT,
        TEST_WORKSPACE_REUSE_RESULT,
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
}
