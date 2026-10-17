//! Check-only evidence stays outside operational history, including nested consumers.

use super::{
    Cause, Handle, MAX_REPORT_BYTES, Operation, Protocol, Report, State, Store, trace::Progress,
};
use chrono::Utc;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

impl Handle {
    pub(crate) fn check_scope(&self) -> Self {
        let assignment = Uuid::new_v4();
        Self {
            store: Arc::new(Store {
                run: self.store.run,
                state: Mutex::new(State {
                    assignment,
                    ..State::default()
                }),
                parent: Some(self.clone()),
            }),
            assignment,
            enabled: self.enabled,
        }
    }

    pub(crate) fn finish_check(&self, report: Option<Report>, cleanup: Progress) -> Value {
        if !self.enabled() || !self.current() {
            return unavailable();
        }
        let Some(mut report) = report else {
            return unavailable();
        };
        report.operation = Operation::ActiveCheck;
        report.assignment_id = self.assignment;
        let status = if report.cause.is_none() && cleanup == Progress::Passed {
            "passed"
        } else if matches!(
            report.cause,
            Some(
                Cause::Ssh(
                    crate::ssh::FailureReason::Unavailable
                        | crate::ssh::FailureReason::AuthorityFailure
                        | crate::ssh::FailureReason::ConfigurationChanged
                        | crate::ssh::FailureReason::ResourceExhausted
                ) | Cause::Vnc(
                    crate::vnc::Failure::Unavailable
                        | crate::vnc::Failure::Authority
                        | crate::vnc::Failure::ConfigurationChanged
                        | crate::vnc::Failure::ResourceExhausted
                        | crate::vnc::Failure::UnsupportedProfile
                )
            )
        ) {
            "blocked"
        } else {
            "failed"
        };
        let mut state = self.store.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.assignment != self.assignment {
            return unavailable();
        }
        state.sequence = state.sequence.saturating_add(1).min((1 << 53) - 1);
        report.sequence = state.sequence;
        // This slot never replaces either protocol's pinned operational failure.
        state.last_check = Some(report.clone());
        drop(state);
        // Reserve the fixed header and cleanup-scope explanation within 8 KiB.
        let detail = report.message().filter(|text| text.len() <= MAX_REPORT_BYTES - 512).unwrap_or_else(|| {
            format!("Detailed check evidence unavailable within the output budget. Run: {}\nAttempt: {}\nConnection: {}\nDo not infer unobserved stages or replay work.", report.run_id, report.attempt_id, report.connection_id)
        });
        let cleanup = if cleanup == Progress::Passed {
            "passed"
        } else {
            "unknown"
        };
        let protocol = match report.protocol {
            Protocol::Ssh => "SSH",
            Protocol::Vnc => "VNC",
        };
        let cleanup_scope = match report.protocol {
            Protocol::Ssh => {
                "Physical SSH transport release. Shared native resources remain Run-owned."
            }
            Protocol::Vnc => {
                "Temporary VNC session closure. SSH/Kerberos descendants retain their own owners until completion; their cleanup and shared native cleanup are not asserted here."
            }
        };
        let message = format!(
            "Active check ({protocol}): {status}. Checked at: {}\nCheck-owned cleanup: {cleanup}.\nCleanup scope: {cleanup_scope}\n{detail}",
            Utc::now().to_rfc3339()
        );
        tracing::info!(active_check = %message, "Remote active check completed");
        json!({"type":"active_check","status":status,"message":message})
    }
}

pub(crate) fn unavailable() -> Value {
    json!({"type":"active_check","status":"blocked","message":"Active check unavailable: diagnostics or current Run authority/evidence is unavailable. The target may be untested; no operation is replayed. Inspect current permissions and host configuration."})
}
