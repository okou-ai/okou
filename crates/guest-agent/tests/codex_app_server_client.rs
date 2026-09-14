mod common;

use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::task::Poll;
use std::time::Duration;

use guest_agent::cli::codex_app_server::{
    CodexAppServerClient, CodexAppServerConfig, CodexAppServerError, InitializeResponse,
};
use guest_contracts::stdout_framing::CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES;
use serde_json::{Value, json};
use tempfile::TempDir;

const CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const BLOCKED_STDIN_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

static MOCK_CODEX_BUILD: OnceLock<Result<PathBuf, String>> = OnceLock::new();

struct ClientFixture {
    client: CodexAppServerClient,
    _codex_home: TempDir,
}

impl Deref for ClientFixture {
    type Target = CodexAppServerClient;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl DerefMut for ClientFixture {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.client
    }
}

#[tokio::test]
async fn codex_app_server_initializes_and_sends_initialized_notification() -> Result<(), String> {
    let mut client = spawn_client(None)?;

    let initialized = wait_result(client.initialize(), "initialize").await?;
    assert!(initialized.user_agent.starts_with("codex-mock-app-server/"));
    assert!(!initialized.codex_home.is_empty());

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    assert_eq!(state["initializedNotificationReceived"], true);
    assert_eq!(state["optOutNotificationMethods"], json!([]));
    assert_eq!(state["hasPendingResponse"], false);

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_initialize_sends_configured_opt_out_notifications() -> Result<(), String>
{
    let codex_home = TempDir::new().map_err(|error| format!("create codex home: {error}"))?;
    let config = new_config(mock_codex_path()?, codex_home.path())
        .with_opt_out_notification_methods([
            "process/outputDelta",
            "item/agentMessage/delta",
            "item/reasoning/textDelta",
        ]);
    let mut client = CodexAppServerClient::spawn(config).map_err(|error| format!("{error:?}"))?;

    wait_result(client.initialize(), "initialize").await?;

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    let opt_out_methods = state["optOutNotificationMethods"]
        .as_array()
        .ok_or_else(|| "missing opt-out notification methods".to_string())?;
    assert!(opt_out_methods.contains(&json!("process/outputDelta")));
    assert!(opt_out_methods.contains(&json!("item/agentMessage/delta")));
    assert!(opt_out_methods.contains(&json!("item/reasoning/textDelta")));
    assert!(!opt_out_methods.contains(&json!("thread/started")));
    assert_eq!(state["hasPendingResponse"], false);

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_extra_env_cannot_override_codex_home() -> Result<(), String> {
    let codex_home = TempDir::new().map_err(|error| format!("create codex home: {error}"))?;
    let override_home =
        TempDir::new().map_err(|error| format!("create override codex home: {error}"))?;
    let config = new_config(mock_codex_path()?, codex_home.path())
        .with_env("CODEX_HOME", override_home.path().to_string_lossy());
    let mut client = CodexAppServerClient::spawn(config).map_err(|error| format!("{error:?}"))?;

    let initialized = wait_result(client.initialize(), "initialize").await?;

    assert_eq!(initialized.codex_home, codex_home.path().to_string_lossy());
    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_correlates_request_response_by_id() -> Result<(), String> {
    let mut client = spawn_client(None)?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({ "cwd": "/tmp" })),
        "thread/start",
    )
    .await?;

    assert!(started["thread"]["id"].as_str().is_some());
    assert_eq!(started["thread"]["source"], "appServer");

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_returns_structured_rpc_errors() -> Result<(), String> {
    let mut client = spawn_client(None)?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("unknown/method", json!({})),
        "unknown/method",
    )
    .await;

    match result {
        Err(CodexAppServerError::Rpc { method, error, .. }) => {
            assert_eq!(method, "unknown/method");
            assert_eq!(error.code, -32601);
            assert_eq!(error.message, "unsupported method");
            assert_eq!(
                error.data,
                Some(json!({
                    "request": {
                        "method": "unknown/method"
                    },
                    "retryable": false
                }))
            );
        }
        other => return Err(format!("expected RPC error, got {other:?}")),
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_buffers_interleaved_notifications() -> Result<(), String> {
    let mut client = spawn_client(Some("interleaved-notification"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    let notification = client
        .pop_notification()
        .ok_or_else(|| "expected buffered notification".to_string())?;
    assert_eq!(notification.method, "experimental/server-notification");
    assert_eq!(
        notification
            .params
            .as_ref()
            .and_then(|value| value.get("message")),
        Some(&json!("codex-mock notification"))
    );
    assert!(client.pop_notification().is_none());

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_next_notification_returns_buffered_notification() -> Result<(), String> {
    let mut client = spawn_client(Some("runtime-turn-complete"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    let thread_id = started["thread"]["id"]
        .as_str()
        .ok_or_else(|| "missing thread id".to_string())?
        .to_string();

    let notification = wait_result(
        client.next_notification("thread/started notification"),
        "next notification",
    )
    .await?;
    assert_eq!(notification.method, "thread/started");
    assert_eq!(
        notification
            .params
            .as_ref()
            .and_then(|params| params.pointer("/thread/id"))
            .and_then(Value::as_str),
        Some(thread_id.as_str())
    );

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_next_notification_reads_after_response() -> Result<(), String> {
    let mut client = spawn_client(Some("runtime-turn-complete-without-thread-started"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    let thread_id = started["thread"]["id"]
        .as_str()
        .ok_or_else(|| "missing thread id".to_string())?
        .to_string();
    let turn_started = wait_result(
        client.request_value(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [text_input("initial prompt")]
            }),
        ),
        "turn/start",
    )
    .await?;
    assert!(turn_started["turn"]["id"].as_str().is_some());

    let notification = wait_result(
        client.next_notification("turn notification"),
        "next notification",
    )
    .await?;
    assert_eq!(notification.method, "turn/started");
    assert_eq!(
        notification
            .params
            .as_ref()
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str),
        Some(thread_id.as_str())
    );

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_preserves_partial_notification_after_cancelled_read() -> Result<(), String>
{
    let mut client = spawn_client(Some("split-notification-after-thread-start"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    cancel_after_first_pending(
        client.next_notification("split notification"),
        "split notification",
    )
    .await?;

    let completed = wait_result(
        client.request_value("mock/complete-split-notification", json!({})),
        "mock/complete-split-notification",
    )
    .await?;
    assert_eq!(completed["completed"], true);

    let notification = client
        .pop_notification()
        .ok_or_else(|| "expected restored split notification".to_string())?;
    assert_eq!(notification.method, "experimental/server-notification");
    assert_eq!(
        notification
            .params
            .as_ref()
            .and_then(|params| params.get("message")),
        Some(&json!("codex-mock notification"))
    );

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_notification_queue_overflow() -> Result<(), String> {
    let mut client = spawn_client(Some("notification-overflow"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;

    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("server notification queue exceeded"));
        }
        other => {
            return Err(format!(
                "expected notification overflow error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_large_buffered_notifications() -> Result<(), String> {
    let mut client = spawn_client(Some("large-notification-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;

    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("server notification queue exceeded"));
            assert!(!message.contains("xxx"));
        }
        other => {
            return Err(format!(
                "expected large notification queue error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_server_requests_and_continues() -> Result<(), String> {
    let mut client = spawn_client(Some("server-request-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    assert_eq!(state["hasPendingResponse"], false);
    assert_eq!(
        state["serverRequestResponses"][0]["id"],
        "codex-mock-server-request-1"
    );
    assert_eq!(state["serverRequestResponses"][0]["error"]["code"], -32601);
    assert!(
        state["serverRequestResponses"][0]["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unsupported server request method"))
    );

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_null_id_server_requests_and_continues() -> Result<(), String> {
    let mut client = spawn_client(Some("null-id-server-request-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    assert_eq!(state["hasPendingResponse"], false);
    assert!(state["serverRequestResponses"][0]["id"].is_null());
    assert_eq!(state["serverRequestResponses"][0]["error"]["code"], -32601);

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_malformed_stdout_fails_without_hanging() -> Result<(), String> {
    let mut client = spawn_client(Some("malformed-stdout"))?;

    let result = wait_result_allow_error(client.initialize(), "initialize").await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("malformed app-server stdout JSON"));
            assert!(!message.contains("not-valid-json"));
        }
        other => {
            return Err(format!(
                "expected malformed stdout protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_oversized_stdout_line_is_rejected() -> Result<(), String> {
    let mut client = spawn_client(Some("oversized-stdout"))?;

    let result = wait_result_allow_error(client.initialize(), "initialize").await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            let expected_error = format!(
                "app-server stdout line exceeded {CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES} bytes"
            );
            assert!(message.contains(&expected_error));
            assert!(!message.contains("xxx"));
        }
        other => {
            return Err(format!(
                "expected oversized stdout protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_malformed_rpc_error_fails_without_raw_payload() -> Result<(), String> {
    let mut client = spawn_client(Some("malformed-error-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("error response must be an object"));
            assert!(!message.contains("do-not-log-malformed-error-payload"));
        }
        other => {
            return Err(format!(
                "expected malformed error response protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_unexpected_typed_response_fails_without_raw_payload() -> Result<(), String>
{
    let mut client = spawn_client(Some("malformed-initialize-result"))?;

    let result: Result<InitializeResponse, CodexAppServerError> = wait_result_allow_error(
        client.request("initialize", initialize_params()),
        "initialize",
    )
    .await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("unexpected shape"));
            assert!(!message.contains("do-not-log-malformed-initialize-result"));
        }
        other => {
            return Err(format!(
                "expected unexpected typed response protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_unknown_response_id_fails_without_raw_payload() -> Result<(), String> {
    let mut client = spawn_client(Some("unknown-response-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("received response for unknown id"));
            assert!(!message.contains("do-not-log-unknown-response-id"));
        }
        other => {
            return Err(format!(
                "expected unknown response id protocol error, got {other:?}"
            ));
        }
    }

    let retry =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    match retry {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("received response for unknown id"));
        }
        other => {
            return Err(format!(
                "expected persistent unknown response id error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_invalid_response_id_fails_without_raw_payload() -> Result<(), String> {
    let mut client = spawn_client(Some("invalid-response-id"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("app-server message id must be"));
            assert!(!message.contains("do-not-log-invalid-response-id"));
        }
        other => {
            return Err(format!(
                "expected invalid response id protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_disconnect_after_initialize_fails_next_request() -> Result<(), String> {
    let mut client = spawn_client(Some("disconnect-after-initialize"))?;

    let initialized: InitializeResponse = wait_result(
        client.request("initialize", initialize_params()),
        "manual initialize",
    )
    .await?;
    assert_eq!(initialized.platform_family, std::env::consts::FAMILY);

    let result =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    assert_disconnect_like(result)?;

    let retry =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    match retry {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(
                message.contains("Broken pipe")
                    || message.contains("child exited")
                    || message.contains("disconnected"),
                "unexpected retry error message: {message}"
            );
        }
        other => {
            return Err(format!(
                "expected persistent disconnected protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_child_exit_before_response_fails_pending_request() -> Result<(), String> {
    let mut client = spawn_client(Some("exit-on-turn-start"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    let thread_id = started["thread"]["id"]
        .as_str()
        .ok_or_else(|| "missing thread id".to_string())?;

    let result = wait_result_allow_error(
        client.request_value(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [text_input("initial prompt")]
            }),
        ),
        "turn/start",
    )
    .await;
    assert_disconnect_like(result)?;

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_unexpected_exit_kills_stdio_holding_descendant_before_reap()
-> Result<(), String> {
    assert_unexpected_exit_kills_stdio_holding_descendant(spawn_client(Some(
        "exit-on-turn-start-with-stderr-holder",
    ))?)
    .await
}

#[tokio::test]
async fn codex_app_server_pidfd_fallback_kills_stdio_holding_descendant_before_reap()
-> Result<(), String> {
    let codex_home = TempDir::new().map_err(|error| format!("create codex home: {error}"))?;
    let config = new_config(mock_codex_path()?, codex_home.path())
        .with_env(
            "MOCK_CODEX_APP_SERVER_SCENARIO",
            "exit-on-turn-start-with-stderr-holder",
        )
        .without_pidfd_exit_notification();
    let client = CodexAppServerClient::spawn(config).map_err(|error| format!("{error:?}"))?;

    assert_unexpected_exit_kills_stdio_holding_descendant(ClientFixture {
        client,
        _codex_home: codex_home,
    })
    .await
}

async fn assert_unexpected_exit_kills_stdio_holding_descendant(
    mut client: ClientFixture,
) -> Result<(), String> {
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    let process_group = wait_for_child_process_group(pid).await?;
    let test_result = async {
        wait_result(client.initialize(), "initialize").await?;

        let started = wait_result(
            client.request_value("thread/start", json!({})),
            "thread/start",
        )
        .await?;
        let thread_id = started
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "missing thread id".to_string())?;

        let result = wait_result_allow_error(
            client.request_value(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [text_input("initial prompt")]
                }),
            ),
            "turn/start",
        )
        .await;
        match result {
            Err(CodexAppServerError::ChildExited { .. }) => {}
            other => return Err(format!("expected child exit, got {other:?}")),
        }
        assert!(client.process_id().is_none());

        match tokio::time::timeout(Duration::from_millis(1500), client.shutdown()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(format!("shutdown failed: {error:?}")),
            Err(_) => return Err("shutdown waited for stderr drain timeout".to_string()),
        }
        Ok(())
    }
    .await;
    drop(client);
    let cleanup_result = wait_for_process_group_exit(process_group).await;
    test_result?;
    cleanup_result
}

#[tokio::test]
async fn codex_app_server_cancelled_request_fails_next_request() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-on-thread-start"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    wait_result(client.initialize(), "initialize").await?;

    cancel_after_first_pending(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;

    let next_result =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    match next_result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("previous app-server request did not complete"));
        }
        other => {
            return Err(format!(
                "expected previous request protocol error, got {other:?}"
            ));
        }
    }

    let retry_result =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    match retry_result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("previous app-server request did not complete"));
        }
        other => {
            return Err(format!(
                "expected persistent previous request protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await?;
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_poisoning_one_client_does_not_stop_another() -> Result<(), String> {
    let mut victim = spawn_client(Some("hang-on-thread-start"))?;
    let victim_pid = victim
        .process_id()
        .ok_or_else(|| "victim app-server child missing pid".to_string())?;
    wait_result(victim.initialize(), "victim initialize").await?;

    let mut survivor = spawn_client(None)?;
    let survivor_pid = survivor
        .process_id()
        .ok_or_else(|| "survivor app-server child missing pid".to_string())?;
    wait_result(survivor.initialize(), "survivor initialize").await?;

    cancel_after_first_pending(
        victim.request_value("thread/start", json!({})),
        "victim thread/start",
    )
    .await?;

    let poisoned = wait_result_allow_error(
        victim.request_value("mock/state", json!({})),
        "victim poison",
    )
    .await;
    match poisoned {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("previous app-server request did not complete"));
        }
        other => return Err(format!("expected victim poison error, got {other:?}")),
    }

    let survivor_state = wait_result(
        survivor.request_value("mock/state", json!({})),
        "survivor mock/state",
    )
    .await?;
    assert_eq!(survivor_state["initializedNotificationReceived"], true);

    wait_result(victim.shutdown(), "victim shutdown").await?;
    assert_process_exited(victim_pid)?;
    wait_result(survivor.shutdown(), "survivor shutdown").await?;
    assert_process_exited(survivor_pid)
}

#[tokio::test]
async fn codex_app_server_cancelled_notification_fails_next_request() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-after-initialize-response"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    let initialized: InitializeResponse = wait_result(
        client.request("initialize", initialize_params()),
        "manual initialize",
    )
    .await?;
    assert_eq!(initialized.platform_family, std::env::consts::FAMILY);

    cancel_after_first_pending(
        client.notify(
            "initialized",
            Value::String("x".repeat(BLOCKED_STDIN_PAYLOAD_BYTES)),
        ),
        "initialized notification",
    )
    .await?;

    let next_result =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    match next_result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("previous app-server write did not complete"));
        }
        other => {
            return Err(format!(
                "expected previous write protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await?;
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_shutdown_reaps_child() -> Result<(), String> {
    let mut client = spawn_client(None)?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    wait_result(client.initialize(), "initialize").await?;

    wait_result(client.shutdown(), "shutdown").await?;
    assert!(client.process_id().is_none());
    assert_process_exited(pid)?;
    wait_result(client.shutdown(), "second shutdown").await
}

#[tokio::test]
async fn codex_app_server_cancelled_shutdown_can_retry_and_reap_child() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;

    cancel_after_first_pending(client.shutdown(), "shutdown").await?;

    match tokio::time::timeout(Duration::from_millis(1500), client.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("shutdown after cancellation failed: {error:?}")),
        Err(_) => return Err("shutdown after cancellation waited for grace".to_string()),
    }
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_terminate_completes_cancelled_shutdown() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    wait_result(client.initialize(), "initialize").await?;

    cancel_after_first_pending(client.shutdown(), "shutdown").await?;

    wait_result(client.terminate(), "terminate after cancelled shutdown").await?;
    assert!(client.process_id().is_none());
    assert_process_exited(pid)?;
    wait_result(client.terminate(), "second terminate").await?;
    wait_result(client.shutdown(), "shutdown after terminate").await
}

#[tokio::test]
async fn codex_app_server_shutdown_skips_stdin_eof_grace() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;

    match tokio::time::timeout(Duration::from_millis(1500), client.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("shutdown failed: {error:?}")),
        Err(_) => return Err("shutdown waited for stdin EOF grace".to_string()),
    }
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_terminate_skips_stdin_eof_grace() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;

    match tokio::time::timeout(Duration::from_millis(1500), client.terminate()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("terminate failed: {error:?}")),
        Err(_) => return Err("terminate waited for stdin EOF grace".to_string()),
    }
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_terminate_sigkills_sigterm_deaf_child() -> Result<(), String> {
    let mut client = spawn_client(Some("sigterm-deaf-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;

    match tokio::time::timeout(Duration::from_millis(1500), client.terminate()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("terminate failed: {error:?}")),
        Err(_) => return Err("terminate waited for SIGTERM grace".to_string()),
    }
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_request_after_cancelled_shutdown_kills_child() -> Result<(), String> {
    let mut client = spawn_client(Some("hang-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;

    cancel_after_first_pending(client.shutdown(), "shutdown").await?;

    let result =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("app-server stdin is closed"));
        }
        other => {
            return Err(format!(
                "expected closed stdin protocol error, got {other:?}"
            ));
        }
    }

    match tokio::time::timeout(Duration::from_millis(1500), client.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("shutdown failed: {error:?}")),
        Err(_) => return Err("shutdown waited for grace after half-closed request".to_string()),
    }
    assert!(client.process_id().is_none());
    assert_process_exited(pid)
}

#[tokio::test]
async fn codex_app_server_shutdown_kills_stderr_holder_without_drain_timeout() -> Result<(), String>
{
    let mut client = spawn_client(Some("stderr-holder-on-stdin-eof"))?;
    wait_result(client.initialize(), "initialize").await?;

    match tokio::time::timeout(Duration::from_millis(1500), client.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("shutdown failed: {error:?}")),
        Err(_) => return Err("shutdown waited for stderr drain timeout".to_string()),
    }
    assert!(client.process_id().is_none());
    Ok(())
}

#[tokio::test]
async fn codex_app_server_drop_kills_open_child() -> Result<(), String> {
    let client = spawn_client(Some("hang-on-stdin-eof"))?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    let process_group = wait_for_child_process_group(pid).await?;

    drop(client);
    wait_for_process_group_exit(process_group).await
}

#[test]
fn codex_app_server_spawn_without_tokio_runtime_returns_error() -> Result<(), String> {
    let codex_home = TempDir::new().map_err(|error| format!("create codex home: {error}"))?;
    let config = new_config("/definitely/missing/codex", codex_home.path());

    match CodexAppServerClient::spawn(config) {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("requires a Tokio runtime"));
            Ok(())
        }
        Err(error) => Err(format!(
            "expected Tokio runtime protocol error, got {error:?}"
        )),
        Ok(_) => Err("expected Tokio runtime protocol error, got client".to_string()),
    }
}

fn spawn_client(scenario: Option<&str>) -> Result<ClientFixture, String> {
    let codex_home = TempDir::new().map_err(|error| format!("create codex home: {error}"))?;
    let mut config = new_config(mock_codex_path()?, codex_home.path());
    if let Some(scenario) = scenario {
        config = config.with_env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
    }
    let client = CodexAppServerClient::spawn(config).map_err(|error| format!("{error:?}"))?;
    Ok(ClientFixture {
        client,
        _codex_home: codex_home,
    })
}

fn new_config(binary: impl Into<PathBuf>, codex_home: impl Into<PathBuf>) -> CodexAppServerConfig {
    let codex_home = codex_home.into();
    CodexAppServerConfig::new(binary, codex_home.clone()).with_child_env(
        codex_home.to_string_lossy().into_owned(),
        &HashMap::new(),
        "http://127.0.0.1:1",
    )
}

fn mock_codex_path() -> Result<PathBuf, String> {
    MOCK_CODEX_BUILD
        .get_or_init(common::build_and_locate_mock_codex)
        .clone()
}

async fn wait_result<T>(
    future: impl Future<Output = Result<T, CodexAppServerError>>,
    label: &str,
) -> Result<T, String> {
    match tokio::time::timeout(CLIENT_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("{label} failed: {error:?}")),
        Err(_) => Err(format!("{label} timed out")),
    }
}

async fn wait_result_allow_error<T>(
    future: impl Future<Output = Result<T, CodexAppServerError>>,
    label: &str,
) -> Result<T, CodexAppServerError> {
    tokio::time::timeout(CLIENT_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| Err(CodexAppServerError::Protocol(format!("{label} timed out"))))
}

async fn cancel_after_first_pending<T>(
    future: impl Future<Output = Result<T, CodexAppServerError>>,
    label: &str,
) -> Result<(), String> {
    let mut future = Box::pin(future);
    poll_fn(|cx| match future.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(Ok(())),
        Poll::Ready(Ok(_)) => Poll::Ready(Err(format!(
            "{label} completed before it could be cancelled"
        ))),
        Poll::Ready(Err(error)) => Poll::Ready(Err(format!(
            "{label} failed before it could be cancelled: {error:?}"
        ))),
    })
    .await?;
    drop(future);
    Ok(())
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "vm0-guest-agent-tests",
            "title": null,
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false
        }
    })
}

fn text_input(text: &str) -> Value {
    json!({
        "type": "text",
        "text": text,
        "text_elements": []
    })
}

fn assert_disconnect_like<T: std::fmt::Debug>(
    result: Result<T, CodexAppServerError>,
) -> Result<(), String> {
    match result {
        Err(CodexAppServerError::Disconnected { .. })
        | Err(CodexAppServerError::ChildExited { .. })
        | Err(CodexAppServerError::Io(_)) => Ok(()),
        other => Err(format!("expected disconnect-like failure, got {other:?}")),
    }
}

#[derive(Clone, Copy)]
struct ObservedProcessGroup {
    pgid: i32,
    leader_pid: u32,
    leader_identity: Option<LinuxProcessIdentity>,
}

impl ObservedProcessGroup {
    fn from_child_pid(pid: u32) -> Result<Option<Self>, String> {
        let pgid = i32::try_from(pid).map_err(|_| format!("child pid {pid} exceeds i32"))?;
        let current_pgid = unsafe { libc::getpgrp() };
        if pgid <= 1 || pgid == current_pgid {
            return Err(format!("refusing to observe unsafe process group {pgid}"));
        }
        let leader_identity = linux_process_identity(pid)?;
        let group_exists = process_group_exists(pgid)?;
        let procfs_available = linux_procfs_available();
        if let Some(identity) = leader_identity
            && identity.process_group_id != pgid
        {
            return Ok(None);
        }
        if !group_exists {
            if leader_identity.is_none() && procfs_available {
                return Err(format!(
                    "app-server child process group {pgid} was not running before drop"
                ));
            }
            return Ok(None);
        }
        if leader_identity.is_none() && procfs_available {
            return Err(format!(
                "app-server child {pid} disappeared before drop while process group {pgid} still exists"
            ));
        }

        Ok(Some(Self {
            pgid,
            leader_pid: pid,
            leader_identity,
        }))
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct LinuxProcessIdentity {
    process_group_id: i32,
    start_time_ticks: u64,
}

async fn wait_for_child_process_group(pid: u32) -> Result<ObservedProcessGroup, String> {
    let deadline = tokio::time::Instant::now() + CLIENT_TIMEOUT;
    loop {
        if let Some(process_group) = ObservedProcessGroup::from_child_pid(pid)? {
            return Ok(process_group);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "app-server child {pid} did not become a running process-group leader"
            ));
        }
        tokio::time::sleep(PROCESS_EXIT_POLL_INTERVAL).await;
    }
}

async fn wait_for_process_group_exit(process_group: ObservedProcessGroup) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + CLIENT_TIMEOUT;
    loop {
        if process_group_exited(process_group)? {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            unsafe {
                libc::kill(-process_group.pgid, libc::SIGKILL);
            }
            let cleanup_deadline = tokio::time::Instant::now() + CLIENT_TIMEOUT;
            while !process_group_exited(process_group)?
                && tokio::time::Instant::now() < cleanup_deadline
            {
                tokio::time::sleep(PROCESS_EXIT_POLL_INTERVAL).await;
            }
            return Err(format!(
                "process group {} for app-server child {} did not exit",
                process_group.pgid, process_group.leader_pid
            ));
        }
        tokio::time::sleep(PROCESS_EXIT_POLL_INTERVAL).await;
    }
}

fn process_group_exited(process_group: ObservedProcessGroup) -> Result<bool, String> {
    if !process_group_exists(process_group.pgid)? {
        return Ok(true);
    }

    if let Some(original_identity) = process_group.leader_identity {
        let current_identity = linux_process_identity(process_group.leader_pid)?;
        if current_identity.is_some_and(|identity| identity != original_identity) {
            return Ok(true);
        }
    }

    linux_process_group_has_no_live_members(process_group.pgid)
}

fn process_group_exists(pgid: i32) -> Result<bool, String> {
    let kill_result = unsafe { libc::kill(-pgid, 0) };
    if kill_result == 0 {
        return Ok(true);
    }

    let kill_error = std::io::Error::last_os_error();
    match kill_error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(format!("kill -0 -{pgid} failed: {kill_error}")),
    }
}

#[cfg(target_os = "linux")]
fn linux_process_identity(pid: u32) -> Result<Option<LinuxProcessIdentity>, String> {
    let stat_path = format!("/proc/{pid}/stat");
    let stat = match std::fs::read_to_string(&stat_path) {
        Ok(stat) => stat,
        Err(error) if linux_proc_task_disappeared(&error) => return Ok(None),
        Err(error) => return Err(format!("read {stat_path}: {error}")),
    };

    let process_stat =
        parse_linux_process_stat(&stat).map_err(|error| format!("parse {stat_path}: {error}"))?;
    Ok(Some(LinuxProcessIdentity {
        process_group_id: process_stat.process_group_id,
        start_time_ticks: process_stat.start_time_ticks,
    }))
}

#[cfg(not(target_os = "linux"))]
fn linux_process_identity(_pid: u32) -> Result<Option<LinuxProcessIdentity>, String> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn linux_procfs_available() -> bool {
    std::path::Path::new("/proc/self/stat").is_file()
}

#[cfg(not(target_os = "linux"))]
fn linux_procfs_available() -> bool {
    false
}

#[cfg(target_os = "linux")]
struct LinuxProcessStat {
    state: char,
    process_group_id: i32,
    start_time_ticks: u64,
}

#[cfg(target_os = "linux")]
fn linux_process_group_has_no_live_members(pgid: i32) -> Result<bool, String> {
    if !linux_procfs_available() {
        return Ok(false);
    }

    let entries = std::fs::read_dir("/proc").map_err(|error| format!("read /proc: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read /proc entry: {error}"))?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.parse::<u32>().is_err() {
            continue;
        }

        let stat_path = entry.path().join("stat");
        let stat = match std::fs::read_to_string(&stat_path) {
            Ok(stat) => stat,
            Err(error) if linux_proc_task_disappeared(&error) => continue,
            Err(error) => return Err(format!("read {}: {error}", stat_path.display())),
        };
        let process_stat = parse_linux_process_stat(&stat)
            .map_err(|error| format!("parse {}: {error}", stat_path.display()))?;
        if process_stat.process_group_id == pgid && !matches!(process_stat.state, 'Z' | 'X' | 'x') {
            return Ok(false);
        }
    }

    Ok(true)
}

#[cfg(target_os = "linux")]
fn linux_proc_task_disappeared(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(target_os = "linux"))]
fn linux_process_group_has_no_live_members(_pgid: i32) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn parse_linux_process_stat(stat: &str) -> Result<LinuxProcessStat, String> {
    let (_comm, fields_text) = stat
        .rsplit_once(") ")
        .ok_or_else(|| "missing command terminator".to_string())?;
    let fields = fields_text.split_whitespace().collect::<Vec<_>>();
    let state = fields
        .first()
        .and_then(|state| {
            let mut chars = state.chars();
            let state = chars.next()?;
            chars.next().is_none().then_some(state)
        })
        .ok_or_else(|| "invalid process state field".to_string())?;
    let process_group_id = fields
        .get(2)
        .ok_or_else(|| "missing process group field".to_string())?
        .parse::<i32>()
        .map_err(|error| format!("invalid process group field: {error}"))?;
    let start_time_ticks = fields
        .get(19)
        .ok_or_else(|| "missing start time field".to_string())?
        .parse::<u64>()
        .map_err(|error| format!("invalid start time field: {error}"))?;

    Ok(LinuxProcessStat {
        state,
        process_group_id,
        start_time_ticks,
    })
}

fn assert_process_exited(pid: u32) -> Result<(), String> {
    if process_exited(pid)? {
        Ok(())
    } else {
        Err(format!("process {pid} is still running"))
    }
}

fn process_exited(pid: u32) -> Result<bool, String> {
    let mut status = 0;
    let wait_result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    if wait_result == pid as libc::pid_t {
        return Ok(true);
    }
    if wait_result == 0 {
        return Ok(false);
    }

    let wait_error = std::io::Error::last_os_error();
    if wait_error.raw_os_error() != Some(libc::ECHILD) {
        return Err(format!("waitpid({pid}) failed: {wait_error}"));
    }

    let kill_result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if kill_result == 0 {
        return Ok(false);
    }
    let kill_error = std::io::Error::last_os_error();
    if kill_error.raw_os_error() == Some(libc::ESRCH) {
        Ok(true)
    } else {
        Err(format!("kill -0 {pid} failed: {kill_error}"))
    }
}
