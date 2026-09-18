use super::messages::{
    agent_message_item_started_notification, assistant_item_completed_notification,
    historical_token_usage_notification, initialize_response, large_server_notification,
    large_warning_notification, reasoning_item_started_notification,
    secondary_token_usage_notification, server_notification, server_notification_with_index,
    server_request, thread_response, thread_started_notification, turn,
    turn_completed_notification, turn_error_notification, turn_failed_notification,
    turn_interrupted_notification, turn_started_notification, warning_notification, write_error,
    write_error_with_data, write_json_line, write_malformed_thread_item_notification,
    write_oversized_delivery_notifications, write_resumed_turn_notifications,
    write_split_json_line_prefix, write_success, write_thread_item_notifications,
    write_turn_completion_notifications, write_turn_notifications, write_turn_start_notifications,
    write_turn_usage_notifications,
};
use super::persistence::{InputEventContext, persist_input_events, session_rollout_timestamp};
use super::scenario::{Scenario, TurnStartRpcError};
use super::{AppServerState, INVALID_REQUEST, PendingResponse, ServerAction, spawn_stderr_holder};
use guest_contracts::stdout_framing::CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use uuid::Uuid;

const HANG_ON_TURN_START_READY_FILE: &str = ".codex-mock-turn-start-ready";
const HANG_ON_TURN_START_READY_EVENT: &str = "codex_mock_turn_start_ready";
const TURN_COMPLETE_BEFORE_HEARTBEAT_READY_FILE: &str =
    ".codex-mock-turn-complete-before-heartbeat-ready";
const TURN_COMPLETE_BEFORE_HEARTBEAT_READY_EVENT: &str =
    "codex_mock_turn_complete_before_heartbeat_ready";
const SESSION_HISTORY_READY_FILE: &str = ".codex-mock-session-history-ready";
const SESSION_HISTORY_READY_EVENT: &str = "codex_mock_session_history_ready";
const WAIT_ON_TURN_STEER_READY_FILE: &str = ".codex-mock-turn-steer-ready";
const WAIT_ON_TURN_STEER_READY_EVENT: &str = "codex_mock_turn_steer_ready";
const WAIT_ON_TURN_STEER_RELEASE_SOCKET: &str = ".codex-mock-turn-steer-release.sock";
const EVENT_DELIVERY_LARGE_RELEASE_SOCKET: &str = ".codex-mock-event-delivery-large-release.sock";
const TURN_INTERRUPT_READY_FILE: &str = ".codex-mock-turn-interrupt-ready";
const TURN_INTERRUPT_READY_EVENT: &str = "codex_mock_turn_interrupt_ready";
const NOTIFICATION_OVERFLOW_COUNT: usize = 129;
const STDOUT_STREAM_CHUNK_BYTES: usize = 8 * 1024;
const EVENT_DELIVERY_FLOOD_COUNT: usize = 640;
// One in-flight payload plus seven queued payloads crosses the shared 16 MiB budget.
const EVENT_DELIVERY_LARGE_EVENT_COUNT: usize = 8;
const EVENT_DELIVERY_LARGE_EVENT_BYTES: usize = 2 * 1024 * 1024;
const SECONDARY_THREAD_ID: &str = "00000000-0000-4000-8000-000000000def";
const SECONDARY_ITEM_STARTED_AT_MS: u64 = 1_700_000_000_000;
const SHELL_PROMPT_PREFIX: &str = "@shell@\n";
const SHELL_PROMPT_END_SEPARATOR: &str = "\n@end-shell@";
const CHECKPOINTED_SHELL_PROMPT_PREFIX: &str = "@shell-checkpoint@\n";
const CHECKPOINTED_SHELL_SEPARATOR: &str = "\n@continue@\n";
const INVALID_PARAMS: i64 = -32602;
const INPUT_TOO_LARGE_ERROR_MESSAGE: &str = "do-not-expose-upstream-input-limit-message";

enum MockTurnOutput {
    Complete(String),
    Checkpoint {
        checkpoint_text: String,
        continuation_script: String,
    },
}

impl AppServerState {
    pub(super) fn handle_initialize<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if self.initialized {
            write_error(output, id, INVALID_REQUEST, "Already initialized")?;
            return Ok(ServerAction::Continue);
        }
        if let Err(message) = validate_initialize_params(params) {
            write_error(output, id, INVALID_REQUEST, message)?;
            return Ok(ServerAction::Continue);
        }
        self.opt_out_notification_methods = initialize_opt_out_notification_methods(params);
        if self.scenario == Scenario::MalformedStdout {
            writeln!(output, "{{not-valid-json")?;
            output.flush()?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::OversizedStdout {
            let chunk = [b'x'; STDOUT_STREAM_CHUNK_BYTES];
            for _ in 0..CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES / STDOUT_STREAM_CHUNK_BYTES {
                output.write_all(&chunk)?;
            }
            output.write_all(b"x\n")?;
            output.flush()?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::MalformedInitializeResult {
            write_json_line(
                output,
                &json!({
                    "id": id,
                    "result": "do-not-log-malformed-initialize-result"
                }),
            )?;
            return Ok(ServerAction::Continue);
        }
        self.initialized = true;
        write_success(output, id, initialize_response())?;
        if self.scenario == Scenario::HangAfterInitializeResponse {
            loop {
                thread::park();
            }
        }
        if self.scenario == Scenario::DisconnectAfterInitialize {
            return Ok(ServerAction::Stop);
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_thread_start<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::ThreadStartInputTooLarge {
            write_error_with_data(
                output,
                id,
                INVALID_PARAMS,
                INPUT_TOO_LARGE_ERROR_MESSAGE,
                input_too_large_data(json!(101), json!(100)),
            )?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::HangOnThreadStart {
            loop {
                thread::park();
            }
        }
        let thread_id = Uuid::now_v7().to_string();
        let rollout_timestamp = session_rollout_timestamp()?;
        self.set_current_thread(
            thread_id.clone(),
            params.get("runtimeWorkspaceRoots").is_some(),
            params.get("excludeTurns").and_then(Value::as_bool) == Some(true),
            string_param(params, "model").map(str::to_string),
            string_param(params, "modelProvider").map(str::to_string),
            rollout_timestamp,
        );
        let response_thread_id = if self.scenario == Scenario::ThreadStartInvalidThreadId {
            "not-a-valid-codex-thread-id"
        } else {
            &thread_id
        };
        let result = thread_response(response_thread_id, false);
        match self.scenario {
            Scenario::InvalidResponseId => {
                write_success(
                    output,
                    json!({ "secret": "do-not-log-invalid-response-id" }),
                    result,
                )?;
            }
            Scenario::MalformedErrorResponse => {
                write_json_line(
                    output,
                    &json!({
                        "id": id,
                        "error": "do-not-log-malformed-error-payload"
                    }),
                )?;
            }
            Scenario::InterleavedNotification => {
                write_json_line(output, &server_notification())?;
                write_success(output, id, result)?;
            }
            Scenario::LargeNotificationBeforeResponse => {
                write_json_line(output, &large_server_notification())?;
                write_success(output, id, result)?;
            }
            Scenario::ServerRequestBeforeResponse | Scenario::NullIdServerRequestBeforeResponse => {
                let request_id = if self.scenario == Scenario::NullIdServerRequestBeforeResponse {
                    Value::Null
                } else {
                    json!("codex-mock-server-request-1")
                };
                write_json_line(output, &server_request(request_id))?;
                self.pending_response = Some(PendingResponse { id, result });
            }
            Scenario::NotificationOverflow => {
                for index in 0..NOTIFICATION_OVERFLOW_COUNT {
                    write_json_line(output, &server_notification_with_index(index))?;
                }
                write_success(output, id, result)?;
            }
            Scenario::UnknownResponseBeforeResponse => {
                write_success(
                    output,
                    json!("do-not-log-unknown-response-id"),
                    json!({ "ignored": true }),
                )?;
                write_success(output, id, result)?;
            }
            Scenario::RuntimeTurnComplete
            | Scenario::RuntimeTurnCompleteBeforeHeartbeat
            | Scenario::SecondaryThreadNotifications => {
                write_json_line(output, &thread_started_notification(&thread_id))?;
                write_success(output, id, result)?;
            }
            Scenario::SplitNotificationAfterThreadStart => {
                write_success(output, id, result)?;
                self.pending_split_stdout_suffix = Some(write_split_json_line_prefix(
                    output,
                    &server_notification(),
                )?);
            }
            _ => {
                write_success(output, id, result)?;
            }
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_thread_resume<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        let Some(thread_id) = non_empty_string_param(params, "threadId") else {
            write_error(output, id, INVALID_REQUEST, "missing threadId")?;
            return Ok(ServerAction::Continue);
        };
        if self.scenario == Scenario::ResumeRpcErrorWithThreadId {
            write_error(
                output,
                id,
                INVALID_REQUEST,
                &format!("resume failed for {thread_id}"),
            )?;
            return Ok(ServerAction::Continue);
        }
        let rollout_timestamp = session_rollout_timestamp()?;
        self.set_current_thread(
            thread_id.to_string(),
            params.get("runtimeWorkspaceRoots").is_some(),
            params.get("excludeTurns").and_then(Value::as_bool) == Some(true),
            string_param(params, "model").map(str::to_string),
            string_param(params, "modelProvider").map(str::to_string),
            rollout_timestamp,
        );
        let response_thread_id = if self.scenario == Scenario::ResumeDifferentThreadId {
            "0193abcd-ef01-7234-89ab-cdef01234568"
        } else {
            thread_id
        };
        write_success(output, id, thread_response(response_thread_id, true))?;
        if self.scenario == Scenario::RuntimeTurnUsageResumeReplay {
            write_json_line(output, &historical_token_usage_notification(thread_id))?;
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_turn_start<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::ExitOnTurnStart {
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::ExitOnTurnStartWithStderrHolder {
            spawn_stderr_holder()?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::HangOnTurnStart {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
            std::fs::write(
                PathBuf::from(home).join(HANG_ON_TURN_START_READY_FILE),
                HANG_ON_TURN_START_READY_EVENT,
            )?;
            loop {
                thread::park();
            }
        }
        if let Some(error) = self.scenario.turn_start_rpc_error() {
            write_turn_start_rpc_error(output, id, error)?;
            return Ok(ServerAction::Continue);
        }

        let Some(thread_id) = non_empty_string_param(params, "threadId") else {
            write_error(output, id, INVALID_REQUEST, "missing threadId")?;
            return Ok(ServerAction::Continue);
        };
        let current_thread = match self.current_thread(thread_id) {
            Ok(current_thread) => current_thread,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, message)?;
                return Ok(ServerAction::Continue);
            }
        };
        let thread_id = current_thread.protocol_thread_id.clone();
        let artifact_thread_id = current_thread.artifact_thread_id.clone();
        let thread_request_has_runtime_workspace_roots =
            current_thread.thread_request_has_runtime_workspace_roots;
        let thread_request_excludes_turns = current_thread.thread_request_excludes_turns;
        let thread_request_model = current_thread.thread_request_model.clone();
        let thread_request_model_provider = current_thread.thread_request_model_provider.clone();
        let rollout_timestamp = current_thread.rollout_timestamp;
        let inputs = match text_inputs(params) {
            Ok(inputs) => inputs,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, &message)?;
                return Ok(ServerAction::Continue);
            }
        };

        let turn_id = Uuid::now_v7().to_string();
        if !matches!(
            self.scenario,
            Scenario::NoActiveTurn | Scenario::RuntimeTurnStartedBeforeSteer
        ) && let Some(current_thread) = &mut self.current_thread
        {
            current_thread.active_turn_id = Some(turn_id.clone());
        }
        self.initial_inputs.extend(inputs.iter().cloned());
        persist_input_events(
            &InputEventContext {
                artifact_thread_id: &artifact_thread_id,
                thread_id: &thread_id,
                turn_id: &turn_id,
                kind: "initial",
                thread_request_has_runtime_workspace_roots,
                thread_request_excludes_turns,
                thread_request_model: thread_request_model.as_deref(),
                thread_request_model_provider: thread_request_model_provider.as_deref(),
                rollout_timestamp: &rollout_timestamp,
                turn_params: params,
            },
            &inputs,
        )?;
        if self.scenario == Scenario::RuntimeTurnStartedBeforeSteer {
            std::fs::write(
                crate::session::codex_home().join(SESSION_HISTORY_READY_FILE),
                SESSION_HISTORY_READY_EVENT,
            )?;
        }
        let turn_output = mock_turn_output(inputs.iter().map(String::as_str))?;
        let response_text = match &turn_output {
            MockTurnOutput::Complete(response_text)
            | MockTurnOutput::Checkpoint {
                checkpoint_text: response_text,
                ..
            } => response_text,
        };
        write_success(output, id, json!({ "turn": turn(&turn_id) }))?;
        if self.scenario == Scenario::UnexpectedThreadOutputItemStarted {
            write_json_line(
                output,
                &reasoning_item_started_notification(
                    "unexpected-thread-id",
                    &turn_id,
                    "unexpected-thread-reasoning-item",
                    1_700_000_000_000,
                ),
            )?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::UnexpectedTurnOutputItemStarted {
            write_json_line(
                output,
                &reasoning_item_started_notification(
                    &thread_id,
                    "unexpected-turn-id",
                    "unexpected-turn-reasoning-item",
                    1_700_000_000_000,
                ),
            )?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::SecondaryThreadNotifications {
            write_secondary_thread_notifications(output, &thread_id, &turn_id, response_text)?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::RuntimeThreadItems {
            write_thread_item_notifications(output, &thread_id, &turn_id)?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::RuntimeMalformedThreadItem {
            write_malformed_thread_item_notification(output, &thread_id, &turn_id)?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario.writes_turn_started_before_control() {
            if let Some(current_thread) = &mut self.current_thread
                && matches!(
                    self.scenario,
                    Scenario::RuntimeTurnStartedBeforeSteer | Scenario::WaitOnTurnSteerResponse
                )
            {
                current_thread.active_turn_id = Some(turn_id.clone());
            }
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
        }
        if self.scenario.waits_for_turn_interrupt() {
            write_json_line(
                output,
                &server_request(json!("codex-mock-active-turn-ready")),
            )?;
        }
        if matches!(
            self.scenario,
            Scenario::RuntimeTurnComplete
                | Scenario::RuntimeTurnCompleteBeforeHeartbeat
                | Scenario::RuntimeTurnCompleteWithoutThreadStarted
                | Scenario::RuntimeTurnUsageResumeNoReplay
                | Scenario::RuntimeTurnUsageResumeReplay
        ) {
            match turn_output {
                MockTurnOutput::Complete(response_text) => {
                    if matches!(
                        self.scenario,
                        Scenario::RuntimeTurnUsageResumeNoReplay
                            | Scenario::RuntimeTurnUsageResumeReplay
                    ) {
                        write_resumed_turn_notifications(
                            output,
                            &thread_id,
                            &turn_id,
                            &response_text,
                        )?;
                    } else {
                        write_turn_notifications(output, &thread_id, &turn_id, &response_text)?;
                        if self.scenario == Scenario::RuntimeTurnCompleteBeforeHeartbeat {
                            let home = std::env::var_os("HOME").ok_or_else(|| {
                                io::Error::new(io::ErrorKind::NotFound, "HOME is not set")
                            })?;
                            std::fs::write(
                                PathBuf::from(home).join(TURN_COMPLETE_BEFORE_HEARTBEAT_READY_FILE),
                                TURN_COMPLETE_BEFORE_HEARTBEAT_READY_EVENT,
                            )?;
                        }
                    }
                }
                MockTurnOutput::Checkpoint {
                    checkpoint_text,
                    continuation_script,
                } => {
                    write_turn_start_notifications(output, &thread_id, &turn_id)?;
                    write_json_line(
                        output,
                        &assistant_item_completed_notification(
                            &thread_id,
                            &turn_id,
                            &checkpoint_text,
                        ),
                    )?;
                    let response_text = shell_response_text(&continuation_script)?;
                    write_turn_completion_notifications(
                        output,
                        &thread_id,
                        &turn_id,
                        &response_text,
                    )?;
                }
            }
        } else if matches!(turn_output, MockTurnOutput::Checkpoint { .. }) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "checkpointed shell prompts require a runtime turn-complete scenario",
            ));
        }
        if let Some(failure) = self.scenario.turn_failure() {
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
            write_turn_usage_notifications(output, &thread_id, &turn_id)?;
            if matches!(
                self.scenario,
                Scenario::RuntimeTurnFailedOutputTokenLimit
                    | Scenario::RuntimeOutputTokenLimitError
            ) {
                write_json_line(
                    output,
                    &assistant_item_completed_notification(
                        &thread_id,
                        &turn_id,
                        "Partial answer before output limit",
                    ),
                )?;
            }
            if self.scenario == Scenario::RuntimeOutputTokenLimitError {
                write_json_line(
                    output,
                    &turn_error_notification(&thread_id, &turn_id, failure),
                )?;
            }
            write_json_line(
                output,
                &turn_failed_notification(&thread_id, &turn_id, failure),
            )?;
        }
        if self.scenario == Scenario::RuntimeEventFlood {
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
            for index in 0..EVENT_DELIVERY_FLOOD_COUNT {
                write_json_line(output, &warning_notification(&thread_id, index))?;
                thread::sleep(std::time::Duration::from_millis(1));
            }
            write_json_line(output, &turn_completed_notification(&thread_id, &turn_id))?;
        }
        if self.scenario == Scenario::RuntimeLargeEventFlood {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
            let release =
                UnixListener::bind(PathBuf::from(home).join(EVENT_DELIVERY_LARGE_RELEASE_SOCKET))?;
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
            for index in 0..EVENT_DELIVERY_LARGE_EVENT_COUNT {
                write_json_line(
                    output,
                    &large_warning_notification(
                        &thread_id,
                        index,
                        EVENT_DELIVERY_LARGE_EVENT_BYTES,
                    ),
                )?;
                if index == 0 {
                    release.accept()?;
                }
                thread::sleep(std::time::Duration::from_millis(50));
            }
            write_json_line(output, &turn_completed_notification(&thread_id, &turn_id))?;
        }
        if self.scenario == Scenario::RuntimeOversizedDelivery {
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
            write_oversized_delivery_notifications(output, &thread_id, &turn_id)?;
            write_json_line(output, &turn_completed_notification(&thread_id, &turn_id))?;
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_turn_interrupt<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        let Some(thread_id) = non_empty_string_param(params, "threadId") else {
            write_error(output, id, INVALID_REQUEST, "missing threadId")?;
            return Ok(ServerAction::Continue);
        };
        let Some(turn_id) = non_empty_string_param(params, "turnId") else {
            write_error(output, id, INVALID_REQUEST, "missing turnId")?;
            return Ok(ServerAction::Continue);
        };
        let current_thread = match self.current_thread(thread_id) {
            Ok(current_thread) => current_thread,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, message)?;
                return Ok(ServerAction::Continue);
            }
        };
        if current_thread.active_turn_id.as_deref() != Some(turn_id) {
            write_error(output, id, INVALID_REQUEST, "turn is not active")?;
            return Ok(ServerAction::Continue);
        }

        let home = std::env::var_os("HOME")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
        std::fs::write(
            PathBuf::from(home).join(TURN_INTERRUPT_READY_FILE),
            TURN_INTERRUPT_READY_EVENT,
        )?;
        if self.scenario == Scenario::HangOnTurnInterrupt {
            loop {
                thread::park();
            }
        }

        let thread_id = current_thread.protocol_thread_id.clone();
        if let Some(current_thread) = &mut self.current_thread {
            current_thread.active_turn_id = None;
        }
        if self.scenario == Scenario::CompleteBeforeTurnInterrupt {
            write_json_line(output, &turn_completed_notification(&thread_id, turn_id))?;
            write_error(output, id, INVALID_REQUEST, "turn is not active")?;
            return Ok(ServerAction::Continue);
        }
        write_success(output, id, json!({}))?;
        write_json_line(output, &turn_interrupted_notification(&thread_id, turn_id))?;
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_turn_steer<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::ExitOnTurnSteer {
            return Ok(ServerAction::Stop);
        }
        let Some(expected_turn_id) = string_param(params, "expectedTurnId") else {
            write_error(output, id, INVALID_REQUEST, "missing expectedTurnId")?;
            return Ok(ServerAction::Continue);
        };
        if expected_turn_id.is_empty() {
            write_error(
                output,
                id,
                INVALID_REQUEST,
                "expectedTurnId must not be empty",
            )?;
            return Ok(ServerAction::Continue);
        }
        let Some(thread_id) = non_empty_string_param(params, "threadId") else {
            write_error(output, id, INVALID_REQUEST, "missing threadId")?;
            return Ok(ServerAction::Continue);
        };
        let current_thread = match self.current_thread(thread_id) {
            Ok(current_thread) => current_thread,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, message)?;
                return Ok(ServerAction::Continue);
            }
        };
        let Some(active_turn_id) = current_thread.active_turn_id.clone() else {
            write_error(output, id, INVALID_REQUEST, "no active turn")?;
            return Ok(ServerAction::Continue);
        };
        if self.scenario == Scenario::StaleTurn || expected_turn_id != active_turn_id {
            write_error(output, id, INVALID_REQUEST, "stale expectedTurnId")?;
            return Ok(ServerAction::Continue);
        }

        let thread_id = current_thread.protocol_thread_id.clone();
        let artifact_thread_id = current_thread.artifact_thread_id.clone();
        let thread_request_has_runtime_workspace_roots =
            current_thread.thread_request_has_runtime_workspace_roots;
        let thread_request_excludes_turns = current_thread.thread_request_excludes_turns;
        let thread_request_model = current_thread.thread_request_model.clone();
        let thread_request_model_provider = current_thread.thread_request_model_provider.clone();
        let rollout_timestamp = current_thread.rollout_timestamp;
        let inputs = match text_inputs(params) {
            Ok(inputs) => inputs,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, &message)?;
                return Ok(ServerAction::Continue);
            }
        };
        self.steered_inputs.extend(inputs.iter().cloned());
        persist_input_events(
            &InputEventContext {
                artifact_thread_id: &artifact_thread_id,
                thread_id: &thread_id,
                turn_id: &active_turn_id,
                kind: "steered",
                thread_request_has_runtime_workspace_roots,
                thread_request_excludes_turns,
                thread_request_model: thread_request_model.as_deref(),
                thread_request_model_provider: thread_request_model_provider.as_deref(),
                rollout_timestamp: &rollout_timestamp,
                turn_params: params,
            },
            &inputs,
        )?;
        if self.scenario == Scenario::WaitOnTurnSteerResponse {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
            let home = PathBuf::from(home);
            let release = UnixListener::bind(home.join(WAIT_ON_TURN_STEER_RELEASE_SOCKET))?;
            std::fs::write(
                home.join(WAIT_ON_TURN_STEER_READY_FILE),
                WAIT_ON_TURN_STEER_READY_EVENT,
            )?;
            release.accept()?;
        }
        let response_text = mock_response_text(
            self.initial_inputs
                .iter()
                .chain(&self.steered_inputs)
                .map(String::as_str),
        )?;
        if self.scenario == Scenario::RuntimeTurnCompleteBeforeSteerResponse {
            write_turn_completion_notifications(
                output,
                &thread_id,
                &active_turn_id,
                &response_text,
            )?;
        }
        write_success(output, id, json!({ "turnId": active_turn_id }))?;
        if self.scenario == Scenario::RuntimeTurnCompleteAfterSteer {
            write_turn_notifications(output, &thread_id, &active_turn_id, &response_text)?;
        }
        if self.scenario == Scenario::RuntimeTurnStartedBeforeSteer {
            write_turn_completion_notifications(
                output,
                &thread_id,
                &active_turn_id,
                &response_text,
            )?;
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_mock_inputs<W: Write>(
        &mut self,
        id: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        write_success(
            output,
            id,
            json!({
                "initial": &self.initial_inputs,
                "steered": &self.steered_inputs,
            }),
        )?;
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_mock_state<W: Write>(
        &mut self,
        id: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        write_success(
            output,
            id,
            json!({
                "initializedNotificationReceived": self.initialized_notification_received,
                "optOutNotificationMethods": &self.opt_out_notification_methods,
                "serverRequestResponses": &self.server_request_responses,
                "hasPendingResponse": self.pending_response.is_some(),
            }),
        )?;
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_mock_complete_split_notification<W: Write>(
        &mut self,
        id: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        let Some(suffix) = self.pending_split_stdout_suffix.take() else {
            write_error(output, id, INVALID_REQUEST, "missing split notification")?;
            return Ok(ServerAction::Continue);
        };
        write!(output, "{suffix}")?;
        output.flush()?;
        write_success(output, id, json!({ "completed": true }))?;
        Ok(ServerAction::Continue)
    }
}

fn write_turn_start_rpc_error<W: Write>(
    output: &mut W,
    id: Value,
    error: TurnStartRpcError,
) -> io::Result<()> {
    let (code, data) = match error {
        TurnStartRpcError::InputTooLarge => (
            INVALID_PARAMS,
            Some(input_too_large_data(json!(101), json!(100))),
        ),
        TurnStartRpcError::WrongRpcCode => {
            (-32603, Some(input_too_large_data(json!(101), json!(100))))
        }
        TurnStartRpcError::WrongDiscriminator => (
            INVALID_PARAMS,
            Some(json!({
                "input_error_code": "invalid_attachment",
                "actual_chars": 101,
                "max_chars": 100,
            })),
        ),
        TurnStartRpcError::MissingData => (INVALID_PARAMS, None),
        TurnStartRpcError::MissingMaxChars => (
            INVALID_PARAMS,
            Some(json!({
                "input_error_code": "input_too_large",
                "actual_chars": 101,
            })),
        ),
        TurnStartRpcError::MissingActualChars => (
            INVALID_PARAMS,
            Some(json!({
                "input_error_code": "input_too_large",
                "max_chars": 100,
            })),
        ),
        TurnStartRpcError::StringActualChars => (
            INVALID_PARAMS,
            Some(input_too_large_data(json!("101"), json!(100))),
        ),
        TurnStartRpcError::FractionalActualChars => (
            INVALID_PARAMS,
            Some(input_too_large_data(json!(101.5), json!(100))),
        ),
        TurnStartRpcError::NegativeMaxChars => (
            INVALID_PARAMS,
            Some(input_too_large_data(json!(101), json!(-1))),
        ),
        TurnStartRpcError::ZeroMaxChars => (
            INVALID_PARAMS,
            Some(input_too_large_data(json!(101), json!(0))),
        ),
        TurnStartRpcError::NotExceeded => (
            INVALID_PARAMS,
            Some(input_too_large_data(json!(100), json!(100))),
        ),
    };
    if let Some(data) = data {
        write_error_with_data(output, id, code, INPUT_TOO_LARGE_ERROR_MESSAGE, data)
    } else {
        write_error(output, id, code, INPUT_TOO_LARGE_ERROR_MESSAGE)
    }
}

fn input_too_large_data(actual_chars: Value, max_chars: Value) -> Value {
    json!({
        "input_error_code": "input_too_large",
        "actual_chars": actual_chars,
        "max_chars": max_chars,
        "additive_field": true,
    })
}

fn write_secondary_thread_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
    response_text: &str,
) -> io::Result<()> {
    write_json_line(output, &thread_started_notification(SECONDARY_THREAD_ID))?;
    write_json_line(output, &warning_notification(thread_id, 0))?;
    write_json_line(
        output,
        &turn_started_notification(SECONDARY_THREAD_ID, turn_id),
    )?;
    write_json_line(
        output,
        &agent_message_item_started_notification(
            SECONDARY_THREAD_ID,
            turn_id,
            "secondary-agent-message-item",
            SECONDARY_ITEM_STARTED_AT_MS,
        ),
    )?;
    write_json_line(
        output,
        &assistant_item_completed_notification(thread_id, turn_id, response_text),
    )?;
    write_json_line(output, &warning_notification(SECONDARY_THREAD_ID, 1))?;
    write_json_line(
        output,
        &secondary_token_usage_notification(SECONDARY_THREAD_ID, turn_id),
    )?;
    write_json_line(
        output,
        &assistant_item_completed_notification(
            SECONDARY_THREAD_ID,
            turn_id,
            "codex-mock secondary app-server response",
        ),
    )?;
    write_json_line(
        output,
        &turn_completed_notification(SECONDARY_THREAD_ID, turn_id),
    )?;
    write_turn_usage_notifications(output, thread_id, turn_id)?;
    write_json_line(output, &turn_completed_notification(thread_id, turn_id))
}

fn mock_response_text<'a>(inputs: impl IntoIterator<Item = &'a str>) -> io::Result<String> {
    match mock_turn_output(inputs)? {
        MockTurnOutput::Complete(response_text) => Ok(response_text),
        MockTurnOutput::Checkpoint { .. } => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "checkpointed shell prompts are not supported for turn steering",
        )),
    }
}

fn mock_turn_output<'a>(inputs: impl IntoIterator<Item = &'a str>) -> io::Result<MockTurnOutput> {
    let prompt = inputs.into_iter().collect::<Vec<_>>().join(" ");
    if let Some(scripts) = prompt.strip_prefix(CHECKPOINTED_SHELL_PROMPT_PREFIX) {
        let Some((checkpoint_script, continuation_script)) =
            scripts.split_once(CHECKPOINTED_SHELL_SEPARATOR)
        else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "checkpointed shell prompt is missing @continue@ separator",
            ));
        };
        return Ok(MockTurnOutput::Checkpoint {
            checkpoint_text: shell_response_text(checkpoint_script)?,
            continuation_script: continuation_script.to_string(),
        });
    }
    if let Some(script_with_suffix) = prompt.strip_prefix(SHELL_PROMPT_PREFIX) {
        let Some((script, _)) = script_with_suffix.split_once(SHELL_PROMPT_END_SEPARATOR) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "shell prompt is missing @end-shell@ separator",
            ));
        };
        return shell_response_text(script).map(MockTurnOutput::Complete);
    }
    Ok(MockTurnOutput::Complete(format!(
        "codex-mock app-server response: {prompt}"
    )))
}

fn shell_response_text(script: &str) -> io::Result<String> {
    let output = Command::new("bash").args(["-c", script]).output()?;
    let mut response = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        if !response.is_empty() && !response.ends_with('\n') {
            response.push('\n');
        }
        response.push_str(&stderr);
    }
    if !output.status.success() {
        if !response.is_empty() && !response.ends_with('\n') {
            response.push('\n');
        }
        response.push_str(&format!("mock shell exited with {}", output.status));
    }
    Ok(response)
}

fn validate_initialize_params(params: &Value) -> Result<(), &'static str> {
    let Some(client_info) = params.get("clientInfo") else {
        return Err("missing clientInfo");
    };
    let Some(name) = client_info.get("name").and_then(Value::as_str) else {
        return Err("missing clientInfo.name");
    };
    if name.contains(['\r', '\n']) {
        return Err("invalid clientInfo.name");
    }
    if client_info.get("version").and_then(Value::as_str).is_none() {
        return Err("missing clientInfo.version");
    }
    let Some(capabilities) = params.get("capabilities") else {
        return Err("missing capabilities");
    };
    if capabilities.get("experimentalApi").and_then(Value::as_bool) != Some(true) {
        return Err("missing capabilities.experimentalApi");
    }
    Ok(())
}

fn initialize_opt_out_notification_methods(params: &Value) -> Vec<String> {
    params
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("optOutNotificationMethods"))
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params.get(name).and_then(Value::as_str)
}

fn non_empty_string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    string_param(params, name).filter(|value| !value.is_empty())
}

fn text_inputs(params: &Value) -> Result<Vec<String>, String> {
    let Some(values) = params.get("input").and_then(Value::as_array) else {
        return Err("missing input".to_string());
    };
    if values.is_empty() {
        return Err("input must not be empty".to_string());
    }

    let mut inputs = Vec::with_capacity(values.len());
    for value in values {
        let input_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if input_type != "text" {
            return Err(format!("unsupported input type {input_type:?}"));
        }
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return Err("text input is missing text".to_string());
        };
        if text.is_empty() {
            return Err("text input must not be empty".to_string());
        }
        inputs.push(text.to_string());
    }
    Ok(inputs)
}
