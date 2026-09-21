//! Sandbox-side Pi preparation observations recorded as sandbox operations.
//!
//! The Pi CLI child already measures its own session-preparation phases with
//! `measurePiPreparation`. On the API-first path those observations are written
//! straight to the sandbox operation log by the API. Inside the sandbox the
//! child has no telemetry sink of its own, so it emits one bounded JSON
//! envelope per observation on stderr and the guest converts it here.
//!
//! ```json
//! {"type":"pi_preparation_timing","phase":"session_services","durationMs":41.2,"outcome":"success"}
//! ```
//!
//! The guest stays the only writer of the sandbox operation log, so these
//! records interleave safely with every other guest operation and reach Axiom
//! through the ordinary telemetry upload, where the ingestion boundary stamps
//! `source: sandbox`. The API-side observer stamps `source: api` on the
//! identical `op_type`, so `source` is the field that separates the two
//! populations.
//!
//! `phase` is validated against the closed set the Pi session runtime can
//! report. An unrecognized phase is dropped rather than forwarded, so a CLI
//! child can never widen `op_type` cardinality in the telemetry dataset.

use std::time::Duration;

use guest_telemetry::telemetry::{SandboxOpDimensions, record_sandbox_op_with_dimensions};
use serde::Deserialize;

/// Envelope type the Pi CLI child uses for a preparation observation.
///
/// Kept identical to `STRUCTURED_AGENT_DIAGNOSTIC_TYPES` in
/// `failure_diagnostics`, which keeps these envelopes out of user-visible
/// failure output.
const PI_PREPARATION_TIMING_TYPE: &str = "pi_preparation_timing";

/// Preparation phases `createPiAgentSession` can report from the sandbox.
///
/// Keeping this list closed bounds `op_type` cardinality. A phase added
/// upstream is ignored until it is added here deliberately.
const OBSERVED_PHASES: [&str; 6] = [
    "resources_prompt",
    "model_runtime",
    "session_services",
    "resource_loader",
    "session_create",
    "session_finalize",
];

/// Bounded outcomes `startPiPreparationObservation` can report.
const OBSERVED_OUTCOMES: [&str; 3] = ["success", "error", "cancelled"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiPreparationTimingEnvelope {
    #[serde(rename = "type")]
    envelope_type: String,
    phase: String,
    duration_ms: f64,
    outcome: String,
}

/// Record one stderr line as a Pi preparation sandbox operation.
///
/// Best-effort by construction: a line that is not a well-formed observation
/// envelope is left alone for the ordinary stderr diagnostic path.
pub(super) fn record_pi_preparation_timing_line(line: &[u8]) {
    let Some(observation) = parse_observation(line) else {
        return;
    };
    record_sandbox_op_with_dimensions(
        &observation.op_type,
        observation.duration,
        observation.success,
        None,
        SandboxOpDimensions {
            outcome: Some(observation.outcome),
            reason: None,
        },
    );
}

struct PiPreparationObservation {
    op_type: String,
    duration: Duration,
    success: bool,
    outcome: &'static str,
}

fn parse_observation(line: &[u8]) -> Option<PiPreparationObservation> {
    if line.first() != Some(&b'{') {
        return None;
    }
    let envelope: PiPreparationTimingEnvelope = serde_json::from_slice(line).ok()?;
    if envelope.envelope_type != PI_PREPARATION_TIMING_TYPE {
        return None;
    }
    let phase = OBSERVED_PHASES
        .into_iter()
        .find(|known| *known == envelope.phase)?;
    let outcome = OBSERVED_OUTCOMES
        .into_iter()
        .find(|known| *known == envelope.outcome)?;
    Some(PiPreparationObservation {
        op_type: format!("pi_prepare_{phase}"),
        duration: bounded_duration(envelope.duration_ms)?,
        success: outcome == "success",
        outcome,
    })
}

/// Clamp a reported duration into a recordable, finite, non-negative value.
fn bounded_duration(duration_ms: f64) -> Option<Duration> {
    if !duration_ms.is_finite() || duration_ms < 0.0 {
        return None;
    }
    Some(Duration::try_from_secs_f64(duration_ms / 1000.0).unwrap_or(Duration::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(line: &str) -> Option<(String, u128, bool, &'static str)> {
        parse_observation(line.as_bytes()).map(|observation| {
            (
                observation.op_type,
                observation.duration.as_millis(),
                observation.success,
                observation.outcome,
            )
        })
    }

    #[test]
    fn parses_a_successful_sandbox_phase() {
        assert_eq!(
            observation(
                r#"{"type":"pi_preparation_timing","runId":"run-1","phase":"session_services","durationMs":41.6,"outcome":"success"}"#
            ),
            Some((
                "pi_prepare_session_services".to_string(),
                41,
                true,
                "success"
            ))
        );
    }

    #[test]
    fn a_non_success_outcome_is_recorded_as_a_failed_operation() {
        assert_eq!(
            observation(
                r#"{"type":"pi_preparation_timing","phase":"session_create","durationMs":2,"outcome":"cancelled"}"#
            ),
            Some((
                "pi_prepare_session_create".to_string(),
                2,
                false,
                "cancelled"
            ))
        );
    }

    #[test]
    fn every_observed_phase_maps_to_the_api_side_op_name() {
        for phase in OBSERVED_PHASES {
            let line = format!(
                r#"{{"type":"pi_preparation_timing","phase":"{phase}","durationMs":1,"outcome":"success"}}"#
            );
            assert_eq!(
                observation(&line).map(|parsed| parsed.0),
                Some(format!("pi_prepare_{phase}"))
            );
        }
    }

    #[test]
    fn unknown_phases_and_outcomes_are_dropped() {
        assert_eq!(
            observation(
                r#"{"type":"pi_preparation_timing","phase":"invented_phase","durationMs":1,"outcome":"success"}"#
            ),
            None
        );
        assert_eq!(
            observation(
                r#"{"type":"pi_preparation_timing","phase":"model_runtime","durationMs":1,"outcome":"invented"}"#
            ),
            None
        );
    }

    #[test]
    fn other_stderr_content_is_left_for_the_diagnostic_path() {
        for line in [
            "plain CLI stderr",
            r#"["pi_preparation_timing"]"#,
            r#"{"type":"pi_memory_recall_outcome","phase":"model_runtime"}"#,
            r#"{"type":"pi_preparation_timing","phase":"model_runtime"}"#,
            r#"prefix {"type":"pi_preparation_timing","phase":"model_runtime","durationMs":1,"outcome":"success"}"#,
        ] {
            assert_eq!(observation(line), None, "{line}");
        }
    }

    #[test]
    fn unusable_durations_are_dropped() {
        for duration in ["-1", "1e400"] {
            let line = format!(
                r#"{{"type":"pi_preparation_timing","phase":"model_runtime","durationMs":{duration},"outcome":"success"}}"#
            );
            assert_eq!(observation(&line), None, "{line}");
        }
    }
}
