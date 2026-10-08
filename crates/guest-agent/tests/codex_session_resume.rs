//! Integration tests for Codex session-resume metadata capture.
//!
//! # Why a dedicated test binary
//!
//! The pre-existing `tests/integration.rs` binary defaults to Claude. This
//! binary keeps Codex metadata tests separate so their setup can stay focused
//! on Codex config and file layout.
//!
//! # Coverage
//!
//! - End-to-end `send_event` -> session metadata capture for the Codex
//!   `thread.started` event shape.
//! - Checkpoint history is resolved from the launch-owned Codex sessions root.
//! - Invalid/non-Codex events do not persist Codex session metadata.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct CodexResumeFixture {
    home: tempfile::TempDir,
    run_id: String,
    runtime_dir: PathBuf,
    paths: guest_agent::paths::GuestPaths,
}

impl CodexResumeFixture {
    fn new() -> TestResult<Self> {
        let home = tempfile::Builder::new()
            .prefix("codex-resume-home-")
            .tempdir()?;
        let run_id = "codex-resume-test".to_string();
        let runtime_dir = home
            .path()
            .join(".vm0")
            .join("guest-agent")
            .join("runs")
            .join(&run_id);
        let paths = guest_agent::paths::GuestPaths::from_runtime_dir(&runtime_dir);

        Ok(Self {
            home,
            run_id,
            runtime_dir,
            paths,
        })
    }

    fn paths(&self) -> &guest_agent::paths::GuestPaths {
        &self.paths
    }

    fn codex_home(&self) -> PathBuf {
        self.home.path().join("codex-home")
    }

    fn config(&self, api_url: &str, api_token: &str) -> TestResult<guest_agent::env::GuestConfig> {
        let run_payload_file = common::write_run_payload_file_for_test(
            &self.runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "test prompt".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )
        .map_err(std::io::Error::other)?;
        let mut config =
            guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
                run_id: self.run_id.clone(),
                api_url: api_url.to_string(),
                api_token: api_token.to_string(),
                sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
                sandbox_reuse_result: "reused".to_string(),
                cli_agent_type: "codex".to_string(),
                home: Some(self.home.path().to_string_lossy().into_owned()),
                run_payload_file: run_payload_file.to_string_lossy().into_owned(),
                guest_runtime_dir: Some(self.runtime_dir.clone()),
                ..Default::default()
            })
            .map_err(std::io::Error::other)?;
        config.codex_home_dir = self.codex_home().to_string_lossy().into_owned();
        Ok(config)
    }

    fn send_event(&self, event: serde_json::Value, seq: u32, masker: &SecretMasker) -> TestResult {
        let config = self.config("http://127.0.0.1:1", "")?;
        let http = guest_agent::http::HttpClient::for_config(&config)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(guest_agent::events::send_event_for_config(
            &http,
            event,
            seq,
            masker,
            &config,
            &self.paths,
        ))?;
        Ok(())
    }

    fn session_id_file(&self) -> &str {
        self.paths.session_id_file()
    }

    fn write_codex_session_file(&self, thread_id: &str, history: &str) -> TestResult {
        let id_no_dashes = thread_id.replace('-', "");
        let path = self
            .codex_home()
            .join("sessions")
            .join("2026")
            .join("06")
            .join("18")
            .join(format!("rollout-2026-06-18T10-00-00-{id_no_dashes}.jsonl"));
        let parent = path.parent().ok_or_else(|| {
            std::io::Error::other(format!("session path has no parent: {}", path.display()))
        })?;
        std::fs::create_dir_all(parent)?;
        std::fs::write(&path, history)?;
        Ok(())
    }
}

fn checkpoint_http_client(
    server: &MockServer,
) -> Result<guest_agent::http::HttpClient, guest_agent::error::AgentError> {
    guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-run-001",
        Duration::ZERO,
    )
}

#[test]
fn send_event_extracts_codex_thread_id() -> TestResult {
    let fixture = CodexResumeFixture::new()?;
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": thread_id
    });

    // No API token -> send_event skips the HTTP POST but still captures
    // session metadata, which is the part we want to assert.
    fixture.send_event(event, 1, &masker)?;

    let stored_id = std::fs::read_to_string(fixture.session_id_file())?;
    assert_eq!(stored_id, thread_id);
    assert_eq!(masker.mask_string(thread_id), thread_id);
    Ok(())
}

#[test]
fn send_event_canonicalizes_codex_thread_id_before_persisting_it() -> TestResult {
    let fixture = CodexResumeFixture::new()?;
    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": "0193ABCDEF01723489ABCDEF01234567"
    });
    let expected = "0193abcd-ef01-7234-89ab-cdef01234567";

    fixture.send_event(event, 1, &masker)?;

    let stored_id = std::fs::read_to_string(fixture.session_id_file())?;
    assert_eq!(stored_id, expected);
    Ok(())
}

#[test]
fn send_event_keeps_existing_codex_thread_id_for_ordinary_events() -> TestResult {
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let fixture = CodexResumeFixture::new()?;
    guest_agent::paths::write_private(fixture.session_id_file(), thread_id)?;
    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "turn.completed"});

    fixture.send_event(event, 1, &masker)?;

    let stored_id = std::fs::read_to_string(fixture.session_id_file())?;
    assert_eq!(stored_id, thread_id);
    assert_eq!(masker.mask_string(thread_id), thread_id);
    Ok(())
}

#[test]
fn recovery_checkpoint_resolves_history_from_codex_sessions_root() -> TestResult {
    let fixture = CodexResumeFixture::new()?;
    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let history = r#"{"type":"thread.started"}"#.to_string() + "\n";
    guest_agent::paths::write_private(fixture.session_id_file(), thread_id)?;
    fixture.write_codex_session_file(thread_id, &history)?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let server = MockServer::start();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/codex-derived-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/codex-derived-history-upload")
            .body(history.as_str());
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"exitCode":1,"checkpoint":{{"cliAgentSessionId":"{thread_id}"}}}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let config = fixture.config(&server.base_url(), "test-token")?;
    let http = checkpoint_http_client(&server)?;
    let guest_runtime = guest_agent::run_context::GuestRuntime {
        config,
        paths: fixture.paths().clone(),
        http,
        workload_containment: None,
        process_control_endpoint: None,
    };
    let session_metadata = guest_agent::session_metadata::CapturedSessionMetadata::for_test(
        thread_id,
        Some(
            guest_contracts::session_history_identity::SessionHistorySourceRef::Codex {
                sessions_dir: Path::new(&guest_runtime.config.codex_home_dir)
                    .join("sessions")
                    .to_string_lossy()
                    .into_owned(),
                thread_id: thread_id.to_string(),
            },
        ),
    );
    runtime.block_on(async {
        let checkpoint = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
            &guest_runtime,
            &session_metadata,
        )
        .await?;
        guest_agent::complete::report_checkpoint_for_run(
            &guest_runtime,
            1,
            None,
            None,
            None,
            checkpoint,
        )
        .await
    })?;
    prepare_mock.assert_calls(1);
    upload_mock.assert_calls(1);
    complete_mock.assert_calls(1);
    Ok(())
}

#[test]
fn send_event_codex_ignores_non_thread_started_event() -> TestResult {
    let fixture = CodexResumeFixture::new()?;
    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "turn.completed"});
    fixture.send_event(event, 1, &masker)?;

    assert!(
        !Path::new(fixture.session_id_file()).exists(),
        "session id file must not be written for non-thread.started events"
    );
    Ok(())
}

#[test]
fn send_event_codex_ignores_empty_thread_id() -> TestResult {
    let fixture = CodexResumeFixture::new()?;
    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "thread.started", "thread_id": ""});
    fixture.send_event(event, 1, &masker)?;

    assert!(
        !Path::new(fixture.session_id_file()).exists(),
        "empty thread_id must not be persisted"
    );
    Ok(())
}

#[test]
fn send_event_codex_ignores_malformed_thread_id() -> TestResult {
    for thread_id in [
        "abc",
        "0193-abcd-ef01-7234-89abcdef01234567",
        "{0193abcd-ef01-7234-89ab-cdef01234567}",
        "urn:uuid:0193abcd-ef01-7234-89ab-cdef01234567",
    ] {
        let fixture = CodexResumeFixture::new()?;
        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "thread.started", "thread_id": thread_id});
        fixture.send_event(event, 1, &masker)?;

        assert!(
            !Path::new(fixture.session_id_file()).exists(),
            "malformed thread_id must not be persisted: {thread_id}"
        );
        assert_eq!(masker.mask_string(thread_id), thread_id);
    }
    Ok(())
}
