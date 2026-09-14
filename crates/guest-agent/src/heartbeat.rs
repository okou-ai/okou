//! Heartbeat loop — periodic POST to the heartbeat endpoint.
//!
//! The first heartbeat is critical: if it fails, the returned future
//! resolves with an error, which the caller races against CLI execution
//! via `tokio::select!`.

use crate::constants;
use crate::error::AgentError;
use crate::http::{HttpAttemptFinished, HttpAttemptObserver, HttpAttemptStarted, HttpClient};
use guest_contracts::diagnostics::{
    HeartbeatFailedCycleDiagnostic, HeartbeatFailureDiagnostic, HttpCompletedAttemptDiagnostic,
};
use guest_telemetry::{log_error, log_info, log_warn};
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Terminal heartbeat control-path failure and its bounded HTTP evidence.
#[derive(Debug)]
pub struct HeartbeatFailure {
    pub error: AgentError,
    pub diagnostic: HeartbeatFailureDiagnostic,
}

impl std::fmt::Display for HeartbeatFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for HeartbeatFailure {}

#[derive(Default)]
struct HeartbeatAttemptCollector {
    attempts: Mutex<Vec<HttpCompletedAttemptDiagnostic>>,
}

impl HeartbeatAttemptCollector {
    fn into_attempts(self) -> Vec<HttpCompletedAttemptDiagnostic> {
        self.attempts
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl HttpAttemptObserver for HeartbeatAttemptCollector {
    fn attempt_started(&self, _attempt: HttpAttemptStarted) -> Result<(), AgentError> {
        Ok(())
    }

    fn attempt_finished(&self, attempt: HttpAttemptFinished) -> Result<(), AgentError> {
        let Some(diagnostic) = attempt.into_failure_diagnostic() else {
            return Ok(());
        };
        self.attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(diagnostic);
        Ok(())
    }
}

fn elapsed_ms_since(scheduled_at: Instant) -> u64 {
    u64::try_from(
        Instant::now()
            .saturating_duration_since(scheduled_at)
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

/// Run the heartbeat loop. Returns when:
/// - The first heartbeat fails (returns `Err`)
/// - Consecutive heartbeat failures reach `MAX_CONSECUTIVE_HEARTBEAT_FAILURES` (returns `Err`)
/// - The shutdown token is cancelled (returns `Ok(())`)
///
/// The caller should race this against CLI execution so that a network
/// failure terminates the run early.
/// Run the heartbeat loop for an explicitly supplied run id.
pub async fn heartbeat_loop_for_run(
    run_id: String,
    http: HttpClient,
    shutdown: CancellationToken,
) -> Result<(), HeartbeatFailure> {
    heartbeat_loop_for_run_with_interval(
        run_id,
        http,
        shutdown,
        Duration::from_secs(constants::HEARTBEAT_INTERVAL_SECS),
    )
    .await
}

/// Like [`heartbeat_loop_for_run`] but with a configurable interval.
///
/// When `http` has API configuration, `interval` must be non-zero. Tokio's
/// first interval tick is immediately ready, so the first heartbeat is
/// attempted when the loop starts rather than after one full interval.
///
/// The timer uses [`MissedTickBehavior::Delay`]. If an HTTP cycle takes longer
/// than `interval`, one overdue heartbeat may run after the cycle completes,
/// but accumulated overdue ticks are not replayed as a burst. The next
/// heartbeat then waits one full interval after that overdue tick completes.
///
/// # Panics
///
/// Panics if `http` has API configuration and `interval` is zero, because the
/// underlying Tokio interval requires a non-zero duration. When no API is
/// configured, the function returns after shutdown without constructing a
/// timer.
pub async fn heartbeat_loop_for_run_with_interval(
    run_id: String,
    http: HttpClient,
    shutdown: CancellationToken,
    interval: Duration,
) -> Result<(), HeartbeatFailure> {
    // No API token → local/test mode; heartbeat has no server to reach.
    if !http.has_api() {
        shutdown.cancelled().await;
        return Ok(());
    }

    let heartbeat_url = http.heartbeat_url().map_err(|error| HeartbeatFailure {
        error,
        diagnostic: HeartbeatFailureDiagnostic {
            failed_cycles: Vec::new(),
        },
    })?;

    let mut interval = tokio::time::interval(interval);
    // Drop timer debt after slow HTTP cycles and restore a full-period cadence.
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut is_first = true;
    let mut consecutive_failures: u32 = 0;
    let mut failed_cycles = Vec::new();

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            scheduled_at = interval.tick() => {
                let scheduled_lag_ms = elapsed_ms_since(scheduled_at);
                let payload = json!({ "runId": run_id.as_str() });
                let collector = HeartbeatAttemptCollector::default();
                let heartbeat_result = http
                    .post_json_observed(
                        heartbeat_url,
                        &payload,
                        constants::HTTP_MAX_ATTEMPTS,
                        &collector,
                    )
                    .await;
                let attempts = collector.into_attempts();
                match heartbeat_result {
                    Ok(_) => {
                        if is_first {
                            log_info!(LOG_TAG, "Heartbeat sent (initial)");
                        } else if consecutive_failures > 0 {
                            log_info!(LOG_TAG, "Heartbeat recovered after {consecutive_failures} failure(s)");
                        } else {
                            log_info!(LOG_TAG, "Heartbeat sent");
                        }
                        is_first = false;
                        consecutive_failures = 0;
                        failed_cycles.clear();
                    }
                    Err(e) if is_first => {
                        failed_cycles.push(HeartbeatFailedCycleDiagnostic {
                            scheduled_lag_ms,
                            attempts,
                        });
                        log_error!(LOG_TAG, "Network connectivity check failed: {e}");
                        return Err(HeartbeatFailure {
                            error: AgentError::Execution(format!(
                                "Network connectivity check failed - cannot reach API at {}",
                                heartbeat_url
                            )),
                            diagnostic: HeartbeatFailureDiagnostic { failed_cycles },
                        });
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        failed_cycles.push(HeartbeatFailedCycleDiagnostic {
                            scheduled_lag_ms,
                            attempts,
                        });
                        log_warn!(
                            LOG_TAG,
                            "Heartbeat failed ({consecutive_failures}/{}): {e}",
                            constants::MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
                        );
                        if consecutive_failures >= constants::MAX_CONSECUTIVE_HEARTBEAT_FAILURES {
                            return Err(HeartbeatFailure {
                                error: AgentError::Execution(format!(
                                    "Heartbeat failed {consecutive_failures} consecutive times, terminating",
                                )),
                                diagnostic: HeartbeatFailureDiagnostic { failed_cycles },
                            });
                        }
                    }
                }
            }
        }
    }
}
