mod handlers;
mod messages;
mod persistence;
mod scenario;

use chrono::{DateTime, Utc};
use messages::{write_json_line, write_success};
use persistence::session_artifact_thread_id;
use scenario::Scenario;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::process::Command;
use std::thread;

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const ACTIVE_TURN_READY_FILE: &str = ".codex-mock-active-turn-ready";
const ACTIVE_TURN_READY_EVENT: &str = "codex_mock_active_turn_ready";

/// Run the mock Codex app server over process stdio.
///
/// `listen` must be exactly `stdio://`. The function locks process stdin and
/// stdout, then synchronously processes newline-delimited JSON-RPC messages on
/// the calling thread. The loop normally returns when stdin reaches EOF or the
/// configured scenario requests a stop. Selected scenarios can instead park
/// the thread indefinitely, either while handling a message or after EOF, or
/// start a helper process that continues holding stderr after this function
/// returns.
///
/// Mock behavior is selected by `MOCK_CODEX_APP_SERVER_SCENARIO`.
///
/// # Errors
///
/// Returns an error when `listen` is unsupported, the environment names an
/// unsupported scenario, stdin cannot be read, an input line cannot be decoded
/// as JSON, a client response is invalid, input events cannot be persisted, a
/// response cannot be serialized or written to stdout, stdout cannot be
/// flushed, or a scenario-specific helper process cannot be started.
pub fn run_app_server(listen: &str) -> io::Result<()> {
    if listen != "stdio://" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "codex-mock app-server only supports stdio transport, got {:?}",
                listen
            ),
        ));
    }

    let scenario = Scenario::from_env()?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut state = AppServerState::new(scenario);
    // Batch serializer writes while retaining each protocol flush.
    state.run(stdin.lock(), io::BufWriter::new(stdout.lock()))
}

#[derive(Debug)]
struct AppServerState {
    initialized: bool,
    current_thread: Option<AppServerThread>,
    session_artifact_thread_ids: BTreeMap<String, String>,
    initial_inputs: Vec<String>,
    steered_inputs: Vec<String>,
    initialized_notification_received: bool,
    opt_out_notification_methods: Vec<String>,
    pending_response: Option<PendingResponse>,
    pending_split_stdout_suffix: Option<String>,
    server_request_responses: Vec<Value>,
    scenario: Scenario,
}

#[derive(Debug)]
struct PendingResponse {
    id: Value,
    result: Value,
}

#[derive(Debug)]
struct AppServerThread {
    protocol_thread_id: String,
    artifact_thread_id: String,
    active_turn_id: Option<String>,
    thread_request_has_runtime_workspace_roots: bool,
    thread_request_excludes_turns: bool,
    thread_request_model: Option<String>,
    thread_request_model_provider: Option<String>,
    rollout_timestamp: DateTime<Utc>,
}

impl AppServerState {
    fn new(scenario: Scenario) -> Self {
        Self {
            initialized: false,
            current_thread: None,
            session_artifact_thread_ids: BTreeMap::new(),
            initial_inputs: Vec::new(),
            steered_inputs: Vec::new(),
            initialized_notification_received: false,
            opt_out_notification_methods: Vec::new(),
            pending_response: None,
            pending_split_stdout_suffix: None,
            server_request_responses: Vec::new(),
            scenario,
        }
    }

    fn run<R: BufRead, W: Write>(&mut self, input: R, mut output: W) -> io::Result<()> {
        for line_result in input.lines() {
            let line = line_result?;
            if line.trim().is_empty() {
                continue;
            }

            let message: Value = serde_json::from_str(&line)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            if self.handle_message(message, &mut output)? == ServerAction::Stop {
                return Ok(());
            }
        }
        match self.scenario {
            Scenario::HangOnStdinEof => loop {
                thread::park();
            },
            Scenario::SigtermDeafOnStdinEof => {
                ignore_sigterm();
                loop {
                    thread::park();
                }
            }
            Scenario::StderrHolderOnStdinEof => {
                spawn_stderr_holder()?;
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_message<W: Write>(
        &mut self,
        message: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").unwrap_or(&Value::Null);
            if let Some(id) = message.get("id").cloned() {
                self.handle_request(id, method, params, output)
            } else {
                self.handle_notification(method);
                Ok(ServerAction::Continue)
            }
        } else {
            self.handle_client_response(message, output)
        }
    }

    fn handle_request<W: Write>(
        &mut self,
        id: Value,
        method: &str,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        match method {
            "initialize" => self.handle_initialize(id, params, output),
            "thread/start" => self.handle_thread_start(id, params, output),
            "thread/resume" => self.handle_thread_resume(id, params, output),
            "turn/start" => self.handle_turn_start(id, params, output),
            "turn/steer" => self.handle_turn_steer(id, params, output),
            "turn/interrupt" => self.handle_turn_interrupt(id, params, output),
            "mock/inputs" => self.handle_mock_inputs(id, output),
            "mock/state" => self.handle_mock_state(id, output),
            "mock/complete-split-notification" => {
                self.handle_mock_complete_split_notification(id, output)
            }
            _ => {
                write_json_line(
                    output,
                    &json!({
                        "id": id,
                        "error": {
                            "code": METHOD_NOT_FOUND,
                            "message": "unsupported method",
                            "data": {
                                "request": {
                                    "method": method
                                },
                                "retryable": false
                            }
                        }
                    }),
                )?;
                Ok(ServerAction::Continue)
            }
        }
    }

    fn handle_client_response<W: Write>(
        &mut self,
        message: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if message.get("id").is_none()
            || (message.get("result").is_none() && message.get("error").is_none())
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "missing method"));
        }

        if !self.scenario.accepts_client_response() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected client response",
            ));
        }

        if self.scenario.waits_for_turn_interrupt() && self.pending_response.is_none() {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
            std::fs::write(
                std::path::PathBuf::from(home).join(ACTIVE_TURN_READY_FILE),
                ACTIVE_TURN_READY_EVENT,
            )?;
            self.server_request_responses.push(message);
            return Ok(ServerAction::Continue);
        }

        let Some(pending) = self.pending_response.take() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected client response",
            ));
        };
        self.server_request_responses.push(message);
        write_success(output, pending.id, pending.result)?;

        Ok(ServerAction::Continue)
    }

    fn handle_notification(&mut self, method: &str) {
        // The client sends `initialized` after the `initialize` request. It
        // must not substitute for the request itself because later requests
        // need initialize response state to exist.
        if method == "initialized" {
            self.initialized_notification_received = true;
        }
    }

    fn set_current_thread(
        &mut self,
        thread_id: String,
        thread_request_has_runtime_workspace_roots: bool,
        thread_request_excludes_turns: bool,
        thread_request_model: Option<String>,
        thread_request_model_provider: Option<String>,
        rollout_timestamp: DateTime<Utc>,
    ) {
        let artifact_thread_id = self
            .session_artifact_thread_ids
            .entry(thread_id.clone())
            .or_insert_with(|| session_artifact_thread_id(&thread_id))
            .clone();
        self.current_thread = Some(AppServerThread {
            protocol_thread_id: thread_id,
            artifact_thread_id,
            active_turn_id: None,
            thread_request_has_runtime_workspace_roots,
            thread_request_excludes_turns,
            thread_request_model,
            thread_request_model_provider,
            rollout_timestamp,
        });
    }

    fn current_thread(&self, requested_thread_id: &str) -> Result<&AppServerThread, &str> {
        let Some(current_thread) = &self.current_thread else {
            return Err("no active thread");
        };
        if requested_thread_id != current_thread.protocol_thread_id {
            return Err("unknown threadId");
        }
        Ok(current_thread)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServerAction {
    Continue,
    Stop,
}

fn spawn_stderr_holder() -> io::Result<()> {
    let _child = Command::new("tail").args(["-f", "/dev/null"]).spawn()?;
    Ok(())
}

#[cfg(unix)]
fn ignore_sigterm() {
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
}

#[cfg(not(unix))]
fn ignore_sigterm() {}
