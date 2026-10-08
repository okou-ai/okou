//! Steered declarations for active inputs the CLI backend accepted.
//!
//! One serial worker declares each accepted chat event steered with a single
//! HTTP attempt. A `409` means the input was already consumed or the run is no
//! longer running; both are final. A failed declaration is not retried: the
//! prompt stays queued for a later pick; a run-targeted budget expires when its
//! run ends. Both carry the same source event identity through this worker.

use std::sync::Mutex;
use std::time::Duration;

use guest_telemetry::{log_info, log_warn};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::constants;
use crate::error::AgentError;
use crate::http::HttpClient;

const LOG_TAG: &str = "sandbox:guest-agent";
const HTTP_CONFLICT: u16 = 409;

/// Run-scoped steered declarations and their single serial HTTP worker.
pub(crate) struct SteeredInputDeclarations {
    declare_tx: mpsc::UnboundedSender<String>,
    finalize_tx: watch::Sender<bool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for SteeredInputDeclarations {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SteeredInputDeclarations")
            .finish_non_exhaustive()
    }
}

impl SteeredInputDeclarations {
    /// Start the worker on the current Tokio runtime.
    pub(crate) fn start(run_id: &str, http: HttpClient) -> Self {
        let (declare_tx, declare_rx) = mpsc::unbounded_channel();
        let (finalize_tx, finalize_rx) = watch::channel(false);
        let worker = tokio::spawn(declaration_worker(
            run_id.to_owned(),
            http,
            declare_rx,
            finalize_rx,
        ));
        Self {
            declare_tx,
            finalize_tx,
            worker: Mutex::new(Some(worker)),
        }
    }

    #[cfg(test)]
    pub(crate) fn start_for_test() -> Self {
        let (declare_tx, declare_rx) = mpsc::unbounded_channel();
        drop(declare_rx);
        let (finalize_tx, _) = watch::channel(false);
        Self {
            declare_tx,
            finalize_tx,
            worker: Mutex::new(None),
        }
    }

    /// Queue one declaration for an input the CLI backend accepted.
    pub(crate) fn declare(&self, event_id: &str) {
        let _ = self.declare_tx.send(event_id.to_owned());
    }

    /// Send the declarations queued before finalization, then stop the worker.
    pub(crate) async fn finalize(&self) {
        let _ = self.finalize_tx.send(true);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(mut worker) = worker else {
            return;
        };
        let timeout = Duration::from_secs(
            constants::ACTIVE_INPUT_STEERED_TIMEOUT_SECS
                + constants::ACTIVE_INPUT_STEERED_FINALIZE_TIMEOUT_SECS
                + 1,
        );
        if tokio::time::timeout(timeout, &mut worker).await.is_err() {
            worker.abort();
            let _ = worker.await;
            log_warn!(
                LOG_TAG,
                "Steered declaration worker exceeded its finalization budget"
            );
        }
    }
}

async fn declare_steered(run_id: &str, event_id: &str, http: &HttpClient) {
    if !http.has_api() {
        return;
    }
    match http.post_steered_input(run_id, event_id).await {
        Ok(()) => log_info!(LOG_TAG, "Active input steered: event_id={event_id}"),
        Err(AgentError::HttpStatus {
            status: HTTP_CONFLICT,
            ..
        }) => log_info!(
            LOG_TAG,
            "Active input was already consumed or the run stopped: event_id={event_id}"
        ),
        Err(error) => log_warn!(
            LOG_TAG,
            "Steered declaration failed: event_id={event_id} error={error}"
        ),
    }
}

async fn declaration_worker(
    run_id: String,
    http: HttpClient,
    mut declare_rx: mpsc::UnboundedReceiver<String>,
    mut finalize_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            biased;
            changed = finalize_rx.changed() => {
                if changed.is_err() || *finalize_rx.borrow() {
                    break;
                }
            }
            event_id = declare_rx.recv() => {
                let Some(event_id) = event_id else {
                    return;
                };
                declare_steered(&run_id, &event_id, &http).await;
            }
        }
    }
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(constants::ACTIVE_INPUT_STEERED_FINALIZE_TIMEOUT_SECS);
    while let Ok(event_id) = declare_rx.try_recv() {
        if tokio::time::timeout_at(deadline, declare_steered(&run_id, &event_id, &http))
            .await
            .is_err()
        {
            log_warn!(LOG_TAG, "Steered declaration finalization deadline reached");
            return;
        }
    }
}
