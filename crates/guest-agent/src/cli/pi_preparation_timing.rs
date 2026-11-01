//! Sandbox-side Pi preparation observations recorded as sandbox operations.
//!
//! The Pi CLI child measures its own session-preparation phases with
//! `measurePiPreparation`. The child has no telemetry sink of its own, so it
//! emits one bounded JSON envelope per observation on stderr and the guest
//! converts it here.
//!
//! ```json
//! {"type":"pi_preparation_timing","phase":"session_services","durationMs":41.2,"outcome":"success"}
//! ```
//!
//! The guest stays the only writer of the sandbox operation log, so these
//! records interleave safely with every other guest operation and reach Axiom
//! through the ordinary telemetry upload, where the ingestion boundary stamps
//! `source: sandbox`. CLI entry and official session preparation use the same
//! bounded envelope; neither introduces an API-side provider owner.
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

/// Preparation phases the CLI entry and official session can report.
///
/// Keeping this list closed bounds `op_type` cardinality. A phase added
/// upstream is ignored until it is added here deliberately.
const OBSERVED_PHASES: [&str; 18] = [
    "cli_node_bootstrap",
    "cli_initial_imports",
    "cli_instrument",
    "cli_entry_imports",
    "cli_proxy",
    "cli_command_import",
    "cli_config",
    "cli_launch_payload",
    "cli_credentials",
    "cli_session_file",
    "session_manager",
    "runtime_initialize",
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
pub(super) fn record_pi_preparation_timing_line(
    line: &[u8],
    startup: Option<&super::pi_startup::PiStartupSegments>,
) {
    let Some(observation) = parse_observation(line) else {
        return;
    };
    if let Some(startup) = startup {
        startup.observe_child_phase(&observation.op_type, observation.success);
    }
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

/// Accept only a finite, non-negative, representable duration.
///
/// An unusable value is dropped rather than clamped: a fabricated duration
/// would read as a real measurement in the telemetry dataset.
fn bounded_duration(duration_ms: f64) -> Option<Duration> {
    if !duration_ms.is_finite() || duration_ms < 0.0 {
        return None;
    }
    Duration::try_from_secs_f64(duration_ms / 1000.0).ok()
}

#[cfg(test)]
mod tests;
