//! Read availability is separate from Guest acceptance and delivery receipts.

use std::time::Duration;

use api_contracts::generated::types::runners::runs::active_inputs::reserve::{
    Response, ResponseRejectedReason,
};
use tokio::time::Instant;
use tracing::{Level, info};

use crate::active_input::ActiveInputBatch;
use crate::error::{ApiTransportCause, RunnerError};
use runner_types::ids::RunId;

// An operational threshold on the same scale as the normal safety recheck,
// not an input-delivery deadline. Evaluated when a failed request completes.
const READ_DEGRADED_AFTER: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct ReadFailures {
    episode: Option<ReadFailureEpisode>,
}

struct ReadFailureEpisode {
    started_at: Instant,
    consecutive_failures: u64,
    warned: bool,
}

impl ReadFailures {
    pub(super) fn record(&mut self, run_id: RunId, error: &RunnerError) {
        let episode = self.episode.get_or_insert_with(|| ReadFailureEpisode {
            started_at: Instant::now(),
            consecutive_failures: 0,
            warned: false,
        });
        episode.consecutive_failures = episode.consecutive_failures.saturating_add(1);
        let elapsed = episode.started_at.elapsed();
        let transient = matches!(
            error,
            RunnerError::ApiTransport(error)
                if matches!(error.failure_cause,
                    ApiTransportCause::Timeout | ApiTransportCause::ConnectionReset)
        );
        let warn = !episode.warned && (!transient || elapsed >= READ_DEGRADED_AFTER);
        if episode.consecutive_failures > 1 && !warn {
            return;
        }
        episode.warned |= warn;

        macro_rules! emit {
            ($level:expr, $message:literal) => {
                match error {
                    RunnerError::ApiTransport(api_error) => tracing::event!(
                        target: "runner::executor::active_input",
                        $level,
                        run_id = %run_id,
                        error = %error,
                        endpoint = api_error.request.endpoint_label,
                        method = %api_error.request.method,
                        host = %api_error.request.host,
                        path = %api_error.request.path,
                        client_request_id = %api_error.request.client_request_id,
                        client_session_id = %api_error.request.client_session_id,
                        client_version = %api_error.request.client_version,
                        failure_kind = api_error.failure_kind.as_str(),
                        failure_cause = api_error.failure_cause.as_str(),
                        error_summary = %api_error.summary,
                        consecutive_failures = episode.consecutive_failures,
                        failure_elapsed_ms = elapsed.as_millis() as u64,
                        $message
                    ),
                    _ => tracing::event!(
                        target: "runner::executor::active_input",
                        $level,
                        run_id = %run_id,
                        error = %error,
                        consecutive_failures = episode.consecutive_failures,
                        failure_elapsed_ms = elapsed.as_millis() as u64,
                        $message
                    ),
                }
            };
        }

        if warn && transient {
            emit!(Level::WARN, "active-input source reads degraded; retrying");
        } else if warn {
            emit!(Level::WARN, "active-input source read failed; retrying");
        } else {
            emit!(Level::INFO, "active-input source read failed; retrying");
        }
    }

    pub(super) fn recover(&mut self, run_id: RunId, batch: &ActiveInputBatch) {
        let Some(episode) = self.episode.take() else {
            return;
        };
        let ActiveInputBatch::Api(response) = batch else {
            return;
        };
        let reserve_outcome = match response {
            Response::Reserved { .. } => "reserved",
            Response::Empty => "empty",
            Response::Terminal => "terminal",
            Response::Held { .. } => "held",
            Response::Rejected { reason } => match reason {
                ResponseRejectedReason::PayloadTooLarge => "rejected_payload_too_large",
                ResponseRejectedReason::RunNotRunning => "rejected_run_not_running",
            },
        };
        info!(
            target: "runner::executor::active_input",
            run_id = %run_id,
            reserve_outcome,
            recovered_after_failures = episode.consecutive_failures,
            failure_elapsed_ms = episode.started_at.elapsed().as_millis() as u64,
            was_degraded = episode.warned,
            "active-input source read recovered"
        );
    }
}
