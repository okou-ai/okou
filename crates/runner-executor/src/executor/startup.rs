//! Report the authenticated Agent-ready resource independently of observability uploads.

use std::time::Duration;

use api_contracts::generated::{routes, types::runners::runs::startup::Request};
use runner_provider::{ProviderError, http::HttpClient};
use runner_types::{ids::RunId, types::SandboxStartupPath};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};
use tracing::{Instrument, error, info};

const STARTUP_REPORT_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_REPORT_MAX_ATTEMPTS: usize = 3;
const STARTUP_REPORT_RETRY_DELAY: Duration = Duration::from_secs(2);

/// Owned delivery of the authenticated Agent-ready fact, independent of Run finalization.
///
/// The supervisor joins this task after releasing the Run's resources. Dropping
/// the owner aborts delivery, including an in-flight HTTP request.
#[must_use = "finish the startup report after resource settlement, or drop it to abort delivery"]
pub struct StartupReport {
    run_id: RunId,
    task: AbortOnDropHandle<()>,
}

impl StartupReport {
    pub(super) fn spawn(
        http: HttpClient,
        run_id: RunId,
        sandbox_token: String,
        sandbox_startup_path: SandboxStartupPath,
        cancel: CancellationToken,
    ) -> Self {
        let task = tokio::spawn(
            async move {
                report_startup_path(&http, run_id, &sandbox_token, sandbox_startup_path, &cancel)
                    .await;
            }
            .in_current_span(),
        );
        Self {
            run_id,
            task: AbortOnDropHandle::new(task),
        }
    }

    /// Drain bounded delivery without changing the Run's execution outcome.
    pub async fn finish(self) {
        if let Err(error) = self.task.await {
            error!(run_id = %self.run_id, %error, "sandbox startup report task failed");
        }
    }
}

pub(super) async fn report_startup_path(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    sandbox_startup_path: SandboxStartupPath,
    cancel: &CancellationToken,
) {
    let run_id_string = run_id.to_string();
    let body = Request {
        sandbox_startup_path,
    };
    // This ancillary fact cannot prevent guest execution. Old/rolled-back APIs
    // may lack the additive route; exhausted delivery leaves the Run path NULL.
    for attempt in 1..=STARTUP_REPORT_MAX_ATTEMPTS {
        let result = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            result = http.request_resolved_route(
                routes::runners::runs::by_run_id::startup::route(
                    routes::runners::runs::by_run_id::startup::Params {
                        run_id: &run_id_string,
                    },
                ),
                sandbox_token,
            ).json(&body).timeout(STARTUP_REPORT_TIMEOUT).send("run startup") => result,
        };
        let will_retry = match result {
            Ok(response) => {
                let status = response.status();
                if status == reqwest::StatusCode::NO_CONTENT {
                    return;
                }
                let retryable = matches!(
                    status,
                    reqwest::StatusCode::REQUEST_TIMEOUT
                        | reqwest::StatusCode::MISDIRECTED_REQUEST
                        | reqwest::StatusCode::TOO_EARLY
                        | reqwest::StatusCode::TOO_MANY_REQUESTS
                ) || status.is_server_error();
                let will_retry = retryable && attempt < STARTUP_REPORT_MAX_ATTEMPTS;
                if will_retry {
                    info!(%run_id, %status, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed, retrying");
                } else {
                    error!(%run_id, %status, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed");
                }
                will_retry
            }
            Err(error) => {
                let will_retry = matches!(&error, ProviderError::ApiTransport(_))
                    && attempt < STARTUP_REPORT_MAX_ATTEMPTS;
                if will_retry {
                    info!(%run_id, %error, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed, retrying");
                } else {
                    error!(%run_id, %error, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed");
                }
                will_retry
            }
        };
        if !will_retry {
            return;
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(STARTUP_REPORT_RETRY_DELAY) => {},
        }
    }
}

#[cfg(test)]
mod tests;
