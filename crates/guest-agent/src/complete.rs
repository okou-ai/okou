//! Guest-side `/webhooks/agent/complete` caller.
//!
//! The guest sends native history metadata and published file versions to
//! `/complete` after execution or recovery. The API saves those outputs and the
//! terminal state together before final telemetry and shutdown work.
//!
//! After the executor returns, the API-backed runner posts a finalization-less
//! fallback concurrently with sandbox park-or-destroy finalization
//! (`ConcurrentWithFinalization`). A subsequent call for an already-terminal run
//! is idempotent. The VM may remain alive for reuse, and a parked sandbox retains
//! capacity. Completion alone does not prove that sandbox ownership or active
//! status has settled, or that capacity has been released.
//!
//! `LocalProvider` instead reports after finalization (`AfterFinalization`) so an
//! immediate local submission can safely depend on reuse. See the [runner timing
//! contract] on `JobProvider::completion_report_timing` for the provider distinction.
//!
//! [runner timing contract]: https://github.com/okou-ai/okou/blob/main/crates/runner-provider/src/provider/mod.rs
//!
//! Completion with output metadata uses the finalization retry budget and returns
//! failures to the caller. Metadata-free cancellation fallback remains
//! fire-and-forget because the runner is its correctness guarantee.
//!
//! Trust model: sandbox and workspace metadata are relayed from
//! runner-set env vars and included in the payload for analytics only. The
//! guest is semi-trusted under the normal threat model, and the runner's
//! fallback call is idempotency-short-circuited, so a compromised guest
//! could skew these values with no way for the runner to correct them. Do
//! not treat these fields as authoritative for security decisions.

use crate::constants;
use crate::error::AgentError;
use crate::finalization::PreparedFinalization;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use api_contracts::generated::types::webhooks::agent::complete;
use guest_contracts::diagnostics::FailureReason;
use guest_telemetry::{log_info, log_warn};
use serde::Serialize;
use std::time::Instant;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletePayload<'a> {
    run_id: &'a str,
    exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_reason: Option<complete::RequestFailureReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_sequence: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_reuse_result: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    home_reuse_result: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completion: Option<&'a complete::RequestCompletion>,
}

fn as_optional(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

/// Atomically persist a prepared finalization and complete the run.
///
/// Sandbox and workspace reuse fields are relayed analytics values;
/// empty strings are serialized as absent so an unset env var is equivalent
/// to omitting the field.
///
/// `last_event_sequence` is the highest contiguous agent event sequence whose
/// events webhook POST succeeded. The host persists it on the run, and clients
/// use it as a terminal event-drain watermark after observing terminal status.
///
/// This uses the finalization request's retry budget and propagates failure so a
/// successful execution can return nonzero rather than silently lose
/// persistence. Recovery callers may handle the same error as best-effort.
pub async fn report_finalization_for_run(
    runtime: &GuestRuntime,
    exit_code: i32,
    failure_reason: Option<FailureReason>,
    error: Option<&str>,
    last_event_sequence: Option<u32>,
    finalization: PreparedFinalization,
) -> Result<(), AgentError> {
    let api_started_at = Instant::now();
    let result = report_payload(
        &runtime.http,
        payload_for_runtime(
            runtime,
            exit_code,
            failure_reason,
            error,
            last_event_sequence,
            Some(finalization.request()),
        ),
        constants::HTTP_MAX_ATTEMPTS,
    )
    .await;
    let api_elapsed = api_started_at.elapsed();
    match result {
        Ok(()) => {
            finalization.acknowledge(api_elapsed);
            log_info!(LOG_TAG, "Complete webhook acknowledged");
            Ok(())
        }
        Err(error) => {
            finalization.record_persistence_failure(api_elapsed);
            Err(error)
        }
    }
}

/// Report an explicit user cancellation after its recovery-finalization attempt.
///
/// Fire-and-forget. A failed request is logged and swallowed so runner
/// completion remains the fallback.
pub async fn report_user_cancellation_for_run(
    http: &HttpClient,
    run_id: &str,
    sandbox_id: &str,
    sandbox_reuse_result: &str,
    home_reuse_result: &str,
    last_event_sequence: Option<u32>,
) {
    if !http.has_api() {
        return;
    }

    if let Err(error) = report_payload(
        http,
        metadata_free_payload_for_run(
            run_id,
            1,
            sandbox_id,
            sandbox_reuse_result,
            home_reuse_result,
            last_event_sequence,
        ),
        1,
    )
    .await
    {
        log_warn!(
            LOG_TAG,
            "Complete webhook failed (runner will retry): {error}"
        );
        return;
    }
    log_info!(LOG_TAG, "Complete webhook acknowledged");
}

fn payload_for_runtime<'a>(
    runtime: &'a GuestRuntime,
    exit_code: i32,
    failure_reason: Option<FailureReason>,
    error: Option<&'a str>,
    last_event_sequence: Option<u32>,
    completion: Option<&'a complete::RequestCompletion>,
) -> CompletePayload<'a> {
    let config = &runtime.config;
    CompletePayload {
        run_id: &config.run_id,
        exit_code,
        failure_reason: failure_reason.map(Into::into),
        error,
        last_event_sequence,
        sandbox_id: as_optional(&config.sandbox_id),
        sandbox_reuse_result: as_optional(&config.sandbox_reuse_result),
        home_reuse_result: as_optional(&config.home_reuse_result),
        completion,
    }
}

fn metadata_free_payload_for_run<'a>(
    run_id: &'a str,
    exit_code: i32,
    sandbox_id: &'a str,
    sandbox_reuse_result: &'a str,
    home_reuse_result: &'a str,
    last_event_sequence: Option<u32>,
) -> CompletePayload<'a> {
    CompletePayload {
        run_id,
        exit_code,
        failure_reason: None,
        error: None,
        last_event_sequence,
        sandbox_id: as_optional(sandbox_id),
        sandbox_reuse_result: as_optional(sandbox_reuse_result),
        home_reuse_result: as_optional(home_reuse_result),
        completion: None,
    }
}

async fn report_payload(
    http: &HttpClient,
    payload: CompletePayload<'_>,
    max_attempts: u32,
) -> Result<(), AgentError> {
    let url = http.complete_url()?;
    http.post_json(url, &payload, max_attempts).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_omits_missing_metadata() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            failure_reason: None,
            error: None,
            last_event_sequence: None,
            sandbox_id: None,
            sandbox_reuse_result: None,
            home_reuse_result: None,
            completion: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(json, r#"{"runId":"run-123","exitCode":0}"#);
    }

    #[test]
    fn payload_includes_metadata_when_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            failure_reason: None,
            error: None,
            last_event_sequence: None,
            sandbox_id: Some("abc"),
            sandbox_reuse_result: Some("reused"),
            home_reuse_result: Some("sandboxReused"),
            completion: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""sandboxId":"abc""#));
        assert!(json.contains(r#""sandboxReuseResult":"reused""#));
        assert!(json.contains(r#""homeReuseResult":"sandboxReused""#));
    }

    #[test]
    fn payload_uses_the_generated_failure_reason_contract() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 1,
            failure_reason: Some(FailureReason::InputTooLarge.into()),
            error: Some("Codex input exceeded the app-server limit"),
            last_event_sequence: None,
            sandbox_id: None,
            sandbox_reuse_result: None,
            home_reuse_result: None,
            completion: None,
        };

        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["failureReason"], "input_too_large");
    }

    /// Completion metadata fields must be skipped independently so one absent
    /// runner value does not silently drop another useful value.
    #[test]
    fn payload_skips_sandbox_id_when_only_reuse_result_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            failure_reason: None,
            error: None,
            last_event_sequence: None,
            sandbox_id: None,
            sandbox_reuse_result: Some("poolMiss"),
            home_reuse_result: None,
            completion: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("sandboxId"));
        assert!(json.contains(r#""sandboxReuseResult":"poolMiss""#));
    }

    #[test]
    fn payload_skips_reuse_result_when_only_sandbox_id_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            failure_reason: None,
            error: None,
            last_event_sequence: None,
            sandbox_id: Some("sid"),
            sandbox_reuse_result: None,
            home_reuse_result: Some("cacheMiss"),
            completion: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""sandboxId":"sid""#));
        assert!(!json.contains("sandboxReuseResult"));
        assert!(json.contains(r#""homeReuseResult":"cacheMiss""#));
    }

    #[test]
    fn as_optional_treats_empty_as_none() {
        assert_eq!(as_optional(""), None);
        assert_eq!(as_optional("value"), Some("value"));
    }

    #[test]
    fn payload_includes_last_event_sequence_when_present() {
        let payload = CompletePayload {
            run_id: "run-123",
            exit_code: 0,
            failure_reason: None,
            error: None,
            last_event_sequence: Some(7),
            sandbox_id: None,
            sandbox_reuse_result: None,
            home_reuse_result: None,
            completion: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(
            json,
            r#"{"runId":"run-123","exitCode":0,"lastEventSequence":7}"#
        );
    }
}
