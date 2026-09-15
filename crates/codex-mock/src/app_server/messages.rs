use super::scenario::TurnFailure;
use crate::session;
use guest_contracts::managed_command::render_managed_shell_command;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const LARGE_NOTIFICATION_MESSAGE_BYTES: usize = 17 * 1024 * 1024;
const HISTORICAL_TURN_ID: &str = "00000000-0000-4000-8000-000000000099";

#[derive(Clone, Copy)]
struct MockTokenUsage {
    input_tokens: i64,
    cached_input_tokens: i64,
    cache_write_input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
    total_tokens: i64,
}

impl MockTokenUsage {
    const fn add(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens + other.input_tokens,
            cached_input_tokens: self.cached_input_tokens + other.cached_input_tokens,
            cache_write_input_tokens: self.cache_write_input_tokens
                + other.cache_write_input_tokens,
            output_tokens: self.output_tokens + other.output_tokens,
            reasoning_output_tokens: self.reasoning_output_tokens + other.reasoning_output_tokens,
            total_tokens: self.total_tokens + other.total_tokens,
        }
    }
}

const EMPTY_USAGE: MockTokenUsage = MockTokenUsage {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
};
const HISTORICAL_USAGE: MockTokenUsage = MockTokenUsage {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 5,
    output_tokens: 50,
    reasoning_output_tokens: 10,
    total_tokens: 150,
};
const HISTORICAL_LAST_USAGE: MockTokenUsage = MockTokenUsage {
    input_tokens: 6,
    cached_input_tokens: 1,
    cache_write_input_tokens: 1,
    output_tokens: 12,
    reasoning_output_tokens: 2,
    total_tokens: 18,
};
const FIRST_RESPONSE_USAGE: MockTokenUsage = MockTokenUsage {
    input_tokens: 7,
    cached_input_tokens: 2,
    cache_write_input_tokens: 1,
    output_tokens: 11,
    reasoning_output_tokens: 3,
    total_tokens: 18,
};
const SECOND_RESPONSE_USAGE: MockTokenUsage = MockTokenUsage {
    input_tokens: 5,
    cached_input_tokens: 1,
    cache_write_input_tokens: 2,
    output_tokens: 13,
    reasoning_output_tokens: 4,
    total_tokens: 18,
};
const SECONDARY_USAGE: MockTokenUsage = MockTokenUsage {
    input_tokens: 900,
    cached_input_tokens: 300,
    cache_write_input_tokens: 200,
    output_tokens: 700,
    reasoning_output_tokens: 400,
    total_tokens: 1600,
};

pub(super) fn initialize_response() -> Value {
    json!({
        "userAgent": format!("codex-mock-app-server/{}", env!("CARGO_PKG_VERSION")),
        "codexHome": session::codex_home(),
        "platformFamily": std::env::consts::FAMILY,
        "platformOs": std::env::consts::OS,
    })
}

pub(super) fn thread_response(thread_id: &str, resume: bool) -> Value {
    let mut response = json!({
        "thread": thread(thread_id),
        "model": "gpt-5",
        "modelProvider": "openai",
        "serviceTier": null,
        "cwd": "/tmp",
        "runtimeWorkspaceRoots": [],
        "instructionSources": [],
        "approvalPolicy": "on-failure",
        "approvalsReviewer": "user",
        "sandbox": {
            "type": "dangerFullAccess"
        },
        "activePermissionProfile": null,
        "reasoningEffort": null,
        "multiAgentMode": null
    });
    if resume && let Value::Object(fields) = &mut response {
        fields.insert("initialTurnsPage".to_string(), Value::Null);
    }
    response
}

pub(super) fn server_notification() -> Value {
    server_notification_with_index(0)
}

pub(super) fn server_notification_with_index(index: usize) -> Value {
    json!({
        "method": "experimental/server-notification",
        "params": {
            "message": "codex-mock notification",
            "index": index
        }
    })
}

pub(super) fn large_server_notification() -> Value {
    json!({
        "method": "experimental/server-notification",
        "params": {
            "message": "x".repeat(LARGE_NOTIFICATION_MESSAGE_BYTES),
        }
    })
}

pub(super) fn thread_started_notification(thread_id: &str) -> Value {
    json!({
        "method": "thread/started",
        "params": {
            "thread": thread(thread_id)
        }
    })
}

pub(super) fn turn_started_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "turn/started",
        "params": {
            "threadId": thread_id,
            "turn": turn(turn_id)
        }
    })
}

pub(super) fn reasoning_item_started_notification(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    started_at_ms: u64,
) -> Value {
    json!({
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "startedAtMs": started_at_ms,
            "item": {
                "id": item_id,
                "type": "reasoning",
                "summary": ["mock reasoning content must not enter timing telemetry"],
                "content": []
            }
        }
    })
}

pub(super) fn agent_message_item_started_notification(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    started_at_ms: u64,
) -> Value {
    json!({
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "startedAtMs": started_at_ms,
            "item": {
                "id": item_id,
                "type": "agentMessage",
                "text": ""
            }
        }
    })
}

pub(super) fn assistant_item_completed_notification(
    thread_id: &str,
    turn_id: &str,
    text: &str,
) -> Value {
    json!({
        "method": "item/completed",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "completedAtMs": 2,
            "item": {
                "id": Uuid::now_v7().to_string(),
                "type": "agentMessage",
                "text": text
            }
        }
    })
}

fn item_notification(
    method: &str,
    thread_id: &str,
    turn_id: &str,
    timestamp_key: &str,
    timestamp: i64,
    item: Value,
) -> Value {
    json!({
        "method": method,
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            timestamp_key: timestamp,
            "item": item,
        }
    })
}

pub(super) fn write_thread_item_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(output, &turn_started_notification(thread_id, turn_id))?;
    let collab_id = "mock-collab-agent-tool-call";
    write_json_line(
        output,
        &item_notification(
            "item/started",
            thread_id,
            turn_id,
            "startedAtMs",
            1,
            json!({
                "id": collab_id,
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "status": "inProgress",
                "senderThreadId": thread_id,
                "receiverThreadIds": ["mock-subagent-thread"],
                "prompt": "inspect the adapter contract",
                "model": "gpt-5",
                "reasoningEffort": "high",
                "agentsStates": {
                    "mock-subagent-thread": {
                        "status": "running",
                        "message": null,
                    }
                }
            }),
        ),
    )?;
    write_json_line(
        output,
        &item_notification(
            "item/completed",
            thread_id,
            turn_id,
            "completedAtMs",
            2,
            json!({
                "id": collab_id,
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": thread_id,
                "receiverThreadIds": ["mock-subagent-thread"],
                "prompt": "inspect the adapter contract",
                "model": "gpt-5",
                "reasoningEffort": "high",
                "agentsStates": {
                    "mock-subagent-thread": {
                        "status": "completed",
                        "message": "adapter contract inspected",
                    }
                }
            }),
        ),
    )?;
    for (index, kind) in ["started", "interacted", "interrupted", "completed"]
        .into_iter()
        .enumerate()
    {
        write_json_line(
            output,
            &item_notification(
                "item/completed",
                thread_id,
                turn_id,
                "completedAtMs",
                i64::try_from(index).map_err(io::Error::other)? + 3,
                json!({
                    "id": format!("mock-subagent-activity-{kind}"),
                    "type": "subAgentActivity",
                    "kind": kind,
                    "agentThreadId": "mock-subagent-thread",
                    "agentPath": "/root/researcher",
                }),
            ),
        )?;
    }
    let compaction_id = "mock-context-compaction";
    write_json_line(
        output,
        &item_notification(
            "item/started",
            thread_id,
            turn_id,
            "startedAtMs",
            7,
            json!({ "id": compaction_id, "type": "contextCompaction" }),
        ),
    )?;
    write_json_line(
        output,
        &item_notification(
            "item/completed",
            thread_id,
            turn_id,
            "completedAtMs",
            8,
            json!({ "id": compaction_id, "type": "contextCompaction" }),
        ),
    )?;
    write_json_line(
        output,
        &item_notification(
            "item/completed",
            thread_id,
            turn_id,
            "completedAtMs",
            9,
            json!({
                "id": "mock-future-item",
                "type": "futureOperation",
                "status": "completed",
                "label": "future item remains generic",
            }),
        ),
    )?;
    write_json_line(output, &turn_completed_notification(thread_id, turn_id))
}

pub(super) fn write_malformed_thread_item_notification<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(output, &turn_started_notification(thread_id, turn_id))?;
    write_json_line(
        output,
        &item_notification(
            "item/completed",
            thread_id,
            turn_id,
            "completedAtMs",
            1,
            json!({
                "id": "mock-malformed-collab-item",
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": thread_id,
                "receiverThreadIds": ["mock-subagent-thread"],
                "prompt": null,
                "model": null,
                "reasoningEffort": "",
                "agentsStates": {},
            }),
        ),
    )
}

pub(super) fn write_oversized_delivery_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    let large = "α".repeat(2_150_000);
    let secret = "delivery-secret-value";
    let completed_at_ms = 2;
    let original_command = format!("command-head-{secret}-{large}-command-tail");
    let managed_command =
        render_managed_shell_command(&original_command).map_err(io::Error::other)?;
    let codex_command = format!("/bin/bash -lc '{managed_command}'");
    write_json_line(
        output,
        &json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "completedAtMs": completed_at_ms,
                "item": {
                    "id": "oversized-agent-message",
                    "type": "agentMessage",
                    "text": format!("agent-head-{secret}-{large}-agent-tail"),
                }
            }
        }),
    )?;
    write_json_line(
        output,
        &json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "completedAtMs": completed_at_ms + 1,
                "item": {
                    "id": "oversized-reasoning",
                    "type": "reasoning",
                    "summary": [format!("reasoning-head-{large}")],
                    "content": [format!("{secret}-{large}-reasoning-tail")],
                }
            }
        }),
    )?;
    write_json_line(
        output,
        &json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "completedAtMs": completed_at_ms + 2,
                "item": {
                    "id": "oversized-plan",
                    "type": "plan",
                    "text": format!("plan-head-{large}-{secret}-plan-tail"),
                }
            }
        }),
    )?;
    write_json_line(
        output,
        &json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "completedAtMs": completed_at_ms + 3,
                "item": {
                    "id": "oversized-command",
                    "type": "commandExecution",
                    "command": codex_command,
                    "cwd": "/workspace",
                    "status": "completed",
                    "aggregatedOutput": format!("output-head-{secret}-{large}-output-tail"),
                    "exitCode": 0,
                    "durationMs": 123,
                }
            }
        }),
    )?;
    write_json_line(
        output,
        &json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "completedAtMs": completed_at_ms + 4,
                "item": {
                    "id": "oversized-file-change",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{
                        "path": "large.txt",
                        "kind": "modify",
                        "diff": format!("diff-head-{secret}-{large}-diff-tail"),
                    }],
                }
            }
        }),
    )?;
    write_json_line(
        output,
        &json!({
            "method": "turn/plan/updated",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "explanation": "oversized structural plan",
                "plan": (0..75_000).map(|index| json!({
                    "step": format!("step-{index:06}-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz"),
                    "status": "pending",
                })).collect::<Vec<_>>(),
            }
        }),
    )?;
    write_json_line(
        output,
        &json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "completedAtMs": completed_at_ms + 6,
                "item": {
                    "id": "oversized-multi-change",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "structure-a.txt",
                            "kind": "modify",
                            "diff": format!("structure-a-head-{secret}-{large}-structure-a-tail"),
                        },
                        {
                            "path": "structure-b.txt",
                            "kind": "modify",
                            "diff": format!("structure-b-head-{secret}-{large}-structure-b-tail"),
                        }
                    ],
                }
            }
        }),
    )?;
    if let Some(path) = std::env::var_os("MOCK_CODEX_DELIVERY_ITEMS_PATH") {
        let items: Vec<Value> = serde_json::from_slice(&std::fs::read(path)?)?;
        for item in items {
            write_json_line(
                output,
                &json!({
                    "method": "item/completed",
                    "params": {"threadId": thread_id, "turnId": turn_id, "completedAtMs": 9, "item": item}
                }),
            )?;
        }
    }
    write_json_line(output, &warning_notification(thread_id, 999))
}

pub(super) fn turn_completed_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": completed_turn(turn_id)
        }
    })
}

pub(super) fn turn_interrupted_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": {
                "id": turn_id,
                "items": [],
                "itemsView": "notLoaded",
                "status": "interrupted",
                "error": null,
                "startedAt": 1,
                "completedAt": 3,
                "durationMs": 2
            }
        }
    })
}

pub(super) fn turn_failed_notification(
    thread_id: &str,
    turn_id: &str,
    failure: TurnFailure,
) -> Value {
    let message = turn_failure_message(failure);
    let error = match turn_failure_error_info(failure) {
        Some(codex_error_info) => json!({
            "message": message,
            "codexErrorInfo": codex_error_info
        }),
        None => json!({ "message": message }),
    };

    json!({
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": {
                "id": turn_id,
                "items": [],
                "itemsView": "notLoaded",
                "status": "failed",
                "error": error,
                "startedAt": 1,
                "completedAt": 3,
                "durationMs": 2
            }
        }
    })
}

fn turn_failure_message(failure: TurnFailure) -> &'static str {
    match failure {
        TurnFailure::ContentPolicyRejection => {
            r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#
        }
        TurnFailure::InvalidRequestFormat => {
            r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#
        }
        _ => "mock codex primary failure",
    }
}

fn turn_failure_error_info(failure: TurnFailure) -> Option<Value> {
    match failure {
        TurnFailure::Generic
        | TurnFailure::ContentPolicyRejection
        | TurnFailure::InvalidRequestFormat => None,
        TurnFailure::ContextWindowExceeded => Some(json!("contextWindowExceeded")),
        TurnFailure::InternalServerError => Some(json!("internalServerError")),
        TurnFailure::ResponseStreamConnectionFailed => Some(json!({
            "responseStreamConnectionFailed": {
                "httpStatusCode": 502
            }
        })),
        TurnFailure::ResponseStreamDisconnected => Some(json!({
            "responseStreamDisconnected": {
                "httpStatusCode": 502
            }
        })),
        TurnFailure::ResponseTooManyFailedAttempts => Some(json!({
            "responseTooManyFailedAttempts": {
                "httpStatusCode": 401
            }
        })),
        TurnFailure::Unauthorized => Some(json!("unauthorized")),
        TurnFailure::Unknown => Some(json!("futureStructuredError")),
    }
}

pub(super) fn historical_token_usage_notification(thread_id: &str) -> Value {
    token_usage_updated_notification(
        thread_id,
        HISTORICAL_TURN_ID,
        HISTORICAL_USAGE,
        HISTORICAL_LAST_USAGE,
    )
}

pub(super) fn secondary_token_usage_notification(thread_id: &str, turn_id: &str) -> Value {
    token_usage_updated_notification(thread_id, turn_id, SECONDARY_USAGE, SECONDARY_USAGE)
}

pub(super) fn warning_notification(thread_id: &str, index: usize) -> Value {
    json!({
        "method": "warning",
        "params": {
            "threadId": thread_id,
            "message": format!("codex-mock warning {index}")
        }
    })
}

pub(super) fn large_warning_notification(
    thread_id: &str,
    index: usize,
    message_bytes: usize,
) -> Value {
    json!({
        "method": "warning",
        "params": {
            "threadId": thread_id,
            "message": format!("{index}:{}", "x".repeat(message_bytes)),
        }
    })
}

pub(super) fn write_turn_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
    response_text: &str,
) -> io::Result<()> {
    write_turn_start_notifications(output, thread_id, turn_id)?;
    write_turn_completion_notifications(output, thread_id, turn_id, response_text)
}

pub(super) fn write_resumed_turn_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
    response_text: &str,
) -> io::Result<()> {
    write_turn_start_notifications(output, thread_id, turn_id)?;
    write_turn_completion_notifications_with_baseline(
        output,
        thread_id,
        turn_id,
        response_text,
        HISTORICAL_USAGE,
    )
}

pub(super) fn write_turn_start_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(output, &turn_started_notification(thread_id, turn_id))?;
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis();
    let started_at_ms = u64::try_from(started_at_ms).map_err(io::Error::other)?;
    for (index, offset_ms) in [0_u64, 1].into_iter().enumerate() {
        write_json_line(
            output,
            &reasoning_item_started_notification(
                thread_id,
                turn_id,
                &format!("mock-reasoning-item-{index}"),
                started_at_ms + offset_ms,
            ),
        )?;
    }
    for (index, offset_ms) in [2_u64, 3].into_iter().enumerate() {
        write_json_line(
            output,
            &agent_message_item_started_notification(
                thread_id,
                turn_id,
                &format!("mock-agent-message-item-{index}"),
                started_at_ms + offset_ms,
            ),
        )?;
    }
    Ok(())
}

pub(super) fn write_turn_completion_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
    response_text: &str,
) -> io::Result<()> {
    write_turn_completion_notifications_with_baseline(
        output,
        thread_id,
        turn_id,
        response_text,
        EMPTY_USAGE,
    )
}

fn write_turn_completion_notifications_with_baseline<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
    response_text: &str,
    baseline: MockTokenUsage,
) -> io::Result<()> {
    write_json_line(
        output,
        &assistant_item_completed_notification(thread_id, turn_id, response_text),
    )?;
    write_turn_usage_notifications_with_baseline(output, thread_id, turn_id, baseline)?;
    write_json_line(output, &turn_completed_notification(thread_id, turn_id))
}

pub(super) fn write_turn_usage_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_turn_usage_notifications_with_baseline(output, thread_id, turn_id, EMPTY_USAGE)
}

fn write_turn_usage_notifications_with_baseline<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
    baseline: MockTokenUsage,
) -> io::Result<()> {
    let first_total = baseline.add(FIRST_RESPONSE_USAGE);
    let first =
        token_usage_updated_notification(thread_id, turn_id, first_total, FIRST_RESPONSE_USAGE);
    write_json_line(output, &first)?;
    write_json_line(output, &first)?;
    write_json_line(
        output,
        &token_usage_updated_notification(
            thread_id,
            turn_id,
            first_total.add(SECOND_RESPONSE_USAGE),
            SECOND_RESPONSE_USAGE,
        ),
    )
}

fn token_usage_updated_notification(
    thread_id: &str,
    turn_id: &str,
    total: MockTokenUsage,
    last: MockTokenUsage,
) -> Value {
    json!({
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "tokenUsage": {
                "total": token_usage_breakdown(total),
                "last": token_usage_breakdown(last),
                "modelContextWindow": 258400
            }
        }
    })
}

fn token_usage_breakdown(usage: MockTokenUsage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "cachedInputTokens": usage.cached_input_tokens,
        "cacheWriteInputTokens": usage.cache_write_input_tokens,
        "outputTokens": usage.output_tokens,
        "reasoningOutputTokens": usage.reasoning_output_tokens,
        "totalTokens": usage.total_tokens
    })
}

pub(super) fn server_request(id: Value) -> Value {
    json!({
        "id": id,
        "method": "experimental/server-request",
        "params": {
            "message": "codex-mock server request"
        }
    })
}

fn thread(thread_id: &str) -> Value {
    json!({
        "id": thread_id,
        "sessionId": thread_id,
        "forkedFromId": null,
        "parentThreadId": null,
        "preview": "codex-mock app-server thread",
        "ephemeral": false,
        "modelProvider": "openai",
        "createdAt": 1,
        "updatedAt": 1,
        "recencyAt": 1,
        "status": {
            "type": "idle"
        },
        "path": null,
        "cwd": "/tmp",
        "cliVersion": "codex-mock",
        "source": "appServer",
        "threadSource": null,
        "agentNickname": null,
        "agentRole": null,
        "gitInfo": null,
        "name": null,
        "turns": []
    })
}

pub(super) fn turn(turn_id: &str) -> Value {
    json!({
        "id": turn_id,
        "items": [],
        "itemsView": "notLoaded",
        "status": "inProgress",
        "error": null,
        "startedAt": null,
        "completedAt": null,
        "durationMs": null
    })
}

fn completed_turn(turn_id: &str) -> Value {
    json!({
        "id": turn_id,
        "items": [],
        "itemsView": "notLoaded",
        "status": "completed",
        "error": null,
        "startedAt": 1,
        "completedAt": 3,
        "durationMs": 2
    })
}

pub(super) fn write_success<W: Write>(output: &mut W, id: Value, result: Value) -> io::Result<()> {
    write_json_line(output, &json!({ "id": id, "result": result }))
}

pub(super) fn write_error<W: Write>(
    output: &mut W,
    id: Value,
    code: i64,
    message: &str,
) -> io::Result<()> {
    write_json_line(
        output,
        &json!({
            "id": id,
            "error": {
                "code": code,
                "message": message
            }
        }),
    )
}

pub(super) fn write_error_with_data<W: Write>(
    output: &mut W,
    id: Value,
    code: i64,
    message: &str,
    data: Value,
) -> io::Result<()> {
    write_json_line(
        output,
        &json!({
            "id": id,
            "error": {
                "code": code,
                "message": message,
                "data": data
            }
        }),
    )
}

pub(super) fn write_json_line<W: Write>(output: &mut W, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(io::Error::other)?;
    writeln!(output)?;
    output.flush()
}

pub(super) fn write_split_json_line_prefix<W: Write>(
    output: &mut W,
    value: &Value,
) -> io::Result<String> {
    const SPLIT_AT: usize = 24;
    let mut line = serde_json::to_string(value).map_err(io::Error::other)?;
    line.push('\n');
    let suffix = line.split_off(SPLIT_AT.min(line.len()));
    write!(output, "{line}")?;
    output.flush()?;
    Ok(suffix)
}
