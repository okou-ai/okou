use sandbox::{SandboxDnsReadinessAttempt, SandboxDnsReadinessOutcome};
use serde::Serialize;

use super::{JobTelemetry, sandbox_op_at};
use crate::duration::duration_ms;

#[derive(Clone, Serialize)]
pub(super) struct DnsReadinessTelemetryFields {
    dns_readiness_attempt: u16,
    dns_readiness_final_attempt: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    dns_readiness_guest_duration_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dns_readiness_host_residual_ms: Option<u64>,
    dns_readiness_timing: &'static str,
}

impl JobTelemetry {
    pub(crate) fn record_dns_readiness_attempt(&mut self, attempt: SandboxDnsReadinessAttempt) {
        // Subtract only a complete same-attempt pair at the telemetry's integer
        // millisecond resolution. This residual is not pure transport latency.
        let residual = attempt
            .guest_duration_ms
            .and_then(|guest| duration_ms(attempt.duration).checked_sub(u64::from(guest)));
        let timing = match (attempt.guest_duration_ms, residual) {
            (None, _) => "unavailable",
            (Some(_), None) => "inconsistent",
            (Some(_), Some(_)) => "paired",
        };
        let success = attempt.outcome == SandboxDnsReadinessOutcome::Success;
        let mut operation = sandbox_op_at(
            "runner_fresh_sandbox_start_guest_dns_readiness_attempt",
            attempt.duration,
            success,
            (!success).then_some(attempt.outcome.as_str()),
            Some(attempt.outcome.as_str()),
            attempt.completed_at.into(),
        );
        operation.dns_readiness = Some(DnsReadinessTelemetryFields {
            dns_readiness_attempt: attempt.attempt,
            dns_readiness_final_attempt: attempt.final_attempt,
            dns_readiness_guest_duration_ms: attempt.guest_duration_ms,
            dns_readiness_host_residual_ms: residual,
            dns_readiness_timing: timing,
        });
        self.push_operation(operation);
    }
}

#[cfg(test)]
mod tests;
