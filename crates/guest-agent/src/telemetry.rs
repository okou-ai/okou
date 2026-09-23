//! Telemetry uploader — single-writer ownership of position files.
//!
//! All reads of the log files and writes to the `*_pos.txt` files happen
//! on one tokio task (`run`). The periodic tick and any caller-driven
//! flushes both flow through the same `tokio::select!`, so uploads are
//! serialized — eliminating the tick-vs-final race that used to regress
//! the position file (#11008).
//!
//! Callers interact via [`Telemetry`]: spawn the task with
//! [`Telemetry::spawn_for_paths`] for explicit runtime paths, request uploads
//! with [`Telemetry::flush`], and release with [`Telemetry::shutdown`] or
//! [`Telemetry::final_flush_and_shutdown`].

mod delta;

use self::delta::{read_file_delta, read_jsonl_delta};
use crate::constants;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths::{self, GuestPaths};
use guest_telemetry::log_warn;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Buffer size for the command channel. Only one flush is in flight at a
/// time during cleanup, so a small bounded queue is plenty.
const COMMAND_CHANNEL_CAPACITY: usize = 8;

/// At most two two-second attempts for each changed incident set.
const INCIDENT_ATTEMPTS: u8 = 2;
const INCIDENT_UPLOAD_TIMEOUT: Duration = Duration::from_secs(2);

/// Latest-value handoff to the existing uploader; there is no diagnostic queue.
#[derive(Clone, Debug)]
pub struct IncidentReporter {
    tx: watch::Sender<Option<(guest_contracts::oom_evidence::OomEvidence, Option<String>)>>,
    sandbox_id: Option<String>,
}

impl IncidentReporter {
    /// Attach the Runner-owned sandbox identity from the launch configuration.
    pub fn with_sandbox_id(mut self, sandbox_id: String) -> Self {
        self.sandbox_id = Some(sandbox_id);
        self
    }

    /// Retain the newest bounded incident set without blocking a producer.
    pub fn record(&self, evidence: guest_contracts::oom_evidence::OomEvidence) {
        if !evidence.incidents.is_empty() {
            self.tx
                .send_replace(Some((evidence, self.sandbox_id.clone())));
        }
    }
}

struct IncidentUploads {
    rx: watch::Receiver<Option<(guest_contracts::oom_evidence::OomEvidence, Option<String>)>>,
    last: Option<Vec<guest_contracts::oom_evidence::OomIncident>>,
    path: String,
}

impl IncidentUploads {
    async fn flush(&mut self, http: &HttpClient, run_id: &str) {
        let Some((evidence, sandbox_id)) = self.rx.borrow_and_update().clone() else {
            return;
        };
        if self.last.as_ref() == Some(&evidence.incidents) {
            return;
        }
        self.last = Some(evidence.incidents.clone());
        let Ok(encoded) = serde_json::to_vec(&evidence) else {
            return;
        };
        if encoded.len() > guest_contracts::oom_evidence::MAX_EVIDENCE_BYTES {
            return;
        }
        // Keep the bounded payload even after successful delivery. The Runner
        // independently receives the same IDs from containment cleanup.
        if paths::write_private(&self.path, &encoded).is_err() {
            log_warn!(LOG_TAG, "OOM evidence local persistence unavailable");
        }
        let Ok(url) = http.telemetry_url() else {
            return;
        };
        let mut payload = serde_json::Map::from_iter([
            ("runId".into(), json!(run_id)),
            ("oomEvidence".into(), json!(evidence)),
        ]);
        if let Some(sandbox_id) = sandbox_id {
            payload.insert("sandboxId".into(), sandbox_id.into());
        }
        for _ in 0..INCIDENT_ATTEMPTS {
            let result =
                tokio::time::timeout(INCIDENT_UPLOAD_TIMEOUT, http.post_json(url, &payload, 1))
                    .await;
            // Old receivers strip unknown fields. A successful HTTP status alone
            // must never acknowledge evidence they did not ingest.
            if let Ok(Ok(Some(body))) = result
                && body
                    .get("oomEvidenceVersion")
                    .and_then(serde_json::Value::as_u64)
                    == Some(1)
            {
                return;
            }
        }
        log_warn!(
            LOG_TAG,
            "OOM evidence upload unacknowledged; bounded local evidence retained"
        );
    }
}

/// Log and position files owned by one telemetry uploader.
#[derive(Clone)]
pub struct TelemetryPaths {
    system_log_file: String,
    metrics_log_file: String,
    sandbox_ops_file: String,
    system_log_pos_file: String,
    metrics_pos_file: String,
    sandbox_ops_pos_file: String,
}

impl TelemetryPaths {
    /// Build telemetry paths from explicit guest runtime paths.
    pub fn from_guest_paths(paths: &GuestPaths) -> Self {
        Self {
            system_log_file: paths.system_log_file().to_string(),
            metrics_log_file: paths.metrics_log_file().to_string(),
            sandbox_ops_file: paths.sandbox_ops_file().to_string(),
            system_log_pos_file: paths.telemetry_system_log_pos_file().to_string(),
            metrics_pos_file: paths.telemetry_metrics_pos_file().to_string(),
            sandbox_ops_pos_file: paths.telemetry_sandbox_ops_pos_file().to_string(),
        }
    }
}

/// Whether an upload pass should defer a trailing fragment to the next
/// pass, or consume it as-is because no next pass is coming.
///
/// `Live` is used while the producer is still actively writing the log
/// files — both periodic ticks and the pre-checkpoint flush. The trailing
/// bytes after the last newline are left in place so the next pass can
/// pick them up once the producer completes the line.
///
/// `Final` is the very last upload before agent exit. There is no next
/// pass, so the EOF tail is consumed verbatim when it fits in one bounded
/// read after any required line-boundary resync.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UploadMode {
    Live,
    Final,
}

/// Result of a completed telemetry flush.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlushReport {
    /// Whether the flush sent a non-empty payload to the telemetry endpoint.
    pub uploaded: bool,
    /// Whether all positions changed by the flush were persisted successfully.
    pub position_persisted: bool,
}

/// Persist the current read position for a file.
fn save_position(pos_path: impl AsRef<Path>, pos: u64) -> std::io::Result<()> {
    let pos_path = pos_path.as_ref();
    paths::write_private(pos_path, pos.to_string()).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("persist telemetry position {}: {error}", pos_path.display()),
        )
    })
}

/// Persist each advanced read position and return the first error after
/// attempting every required write.
fn save_positions(positions: [Option<(&str, u64)>; 3]) -> std::io::Result<()> {
    let mut first_error = None;
    for (path, pos) in positions.into_iter().flatten() {
        if let Err(error) = save_position(path, pos) {
            first_error = first_error.or(Some(error));
        }
    }

    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Persist positions while keeping the upload result successful if the local
/// replay cursor cannot be recorded.
fn save_positions_with_warning(positions: [Option<(&str, u64)>; 3], warning: &str) -> bool {
    match save_positions(positions) {
        Ok(()) => true,
        Err(error) => {
            log_warn!(
                LOG_TAG,
                "{warning}; processed data may be replayed: {error}"
            );
            false
        }
    }
}

/// Perform one telemetry upload cycle.
///
/// `UploadMode::Final` should be used only for the very last upload before
/// the agent exits. It consumes a trailing fragment as-is only when the
/// fragment fits inside this pass's bounded read. Every earlier upload
/// (periodic tick and the pre-checkpoint `flush(UploadMode::Live)`) must use
/// `UploadMode::Live` so a later pass can safely pick up the tail once the
/// producer completes the line.
async fn upload_telemetry(
    http: &HttpClient,
    masker: &SecretMasker,
    run_id: &str,
    telemetry_paths: &TelemetryPaths,
    mode: UploadMode,
) -> Result<FlushReport, AgentError> {
    // Read deltas
    let system_log = read_file_delta(
        &telemetry_paths.system_log_file,
        &telemetry_paths.system_log_pos_file,
        mode,
    );
    let metrics = read_jsonl_delta(
        &telemetry_paths.metrics_log_file,
        &telemetry_paths.metrics_pos_file,
        mode,
    );
    let sandbox_ops = read_jsonl_delta(
        &telemetry_paths.sandbox_ops_file,
        &telemetry_paths.sandbox_ops_pos_file,
        mode,
    );
    let log_pos = system_log.new_pos;
    let metrics_pos = metrics.new_pos;
    let sandbox_ops_pos = sandbox_ops.new_pos;
    let position_updates = [
        system_log
            .made_progress
            .then_some((telemetry_paths.system_log_pos_file.as_str(), log_pos)),
        metrics
            .made_progress
            .then_some((telemetry_paths.metrics_pos_file.as_str(), metrics_pos)),
        sandbox_ops.made_progress.then_some((
            telemetry_paths.sandbox_ops_pos_file.as_str(),
            sandbox_ops_pos,
        )),
    ];
    let made_progress = position_updates.iter().any(Option::is_some);

    // Nothing new
    if system_log.content.is_empty() && metrics.entries.is_empty() && sandbox_ops.entries.is_empty()
    {
        let position_persisted = if made_progress {
            save_positions_with_warning(
                position_updates,
                "Telemetry skip-only progress was processed but position persistence failed",
            )
        } else {
            true
        };
        return Ok(FlushReport {
            uploaded: false,
            position_persisted,
        });
    }

    // Mask secrets in text content
    let masked_log = if system_log.content.is_empty() {
        String::new()
    } else {
        masker.mask_diagnostic_string(system_log.content)
    };
    let metrics_entries = metrics.entries;
    let mut sandbox_ops_entries = sandbox_ops.entries;
    for entry in &mut sandbox_ops_entries {
        masker.mask_string_values(entry);
    }

    let payload = json!({
        "runId": run_id,
        "systemLog": masked_log,
        "metrics": metrics_entries,
        "sandboxOperations": sandbox_ops_entries,
    });

    // Use 1 attempt for telemetry (non-critical, best-effort)
    let url = http.telemetry_url()?;
    match http.post_json(url, &payload, 1).await {
        Ok(_) => {
            let position_persisted = save_positions_with_warning(
                position_updates,
                "Telemetry upload succeeded but position persistence failed",
            );
            Ok(FlushReport {
                uploaded: true,
                position_persisted,
            })
        }
        Err(e) => {
            log_warn!(LOG_TAG, "Telemetry upload failed (will retry): {e}");
            Err(e)
        }
    }
}

/// Commands accepted by the uploader task.
enum Cmd {
    /// Flush new telemetry now and report the result back via `reply`.
    /// `mode` is propagated to [`upload_telemetry`]; see [`UploadMode`].
    Flush {
        mode: UploadMode,
        reply: oneshot::Sender<Result<FlushReport, AgentError>>,
    },
    /// Perform the EOF-consuming final flush, then stop the loop.
    FinalFlushAndShutdown {
        reply: oneshot::Sender<Result<FlushReport, AgentError>>,
    },
    /// Stop the loop. Any in-flight upload completes first.
    Shutdown,
}

/// Owning handle to the uploader task.
///
/// Holds both the command channel and the spawned task's [`JoinHandle`],
/// so callers see one lifecycle object rather than juggling two.
/// Construct with [`Self::spawn_for_paths`]; release with [`Self::shutdown`].
///
/// Dropping this handle, including by cancelling a consuming shutdown, closes
/// the command channel. The worker finishes queued and in-flight uploads under
/// the existing HTTP timeouts before exiting. Cancelling a borrowed
/// [`Self::flush`] future alone leaves the worker running.
pub struct Telemetry {
    tx: mpsc::Sender<Cmd>,
    handle: JoinHandle<()>,
    incident_reporter: IncidentReporter,
}

impl Telemetry {
    /// Spawn the uploader task using explicit run id and paths.
    pub fn spawn_for_run(
        run_id: String,
        telemetry_paths: TelemetryPaths,
        masker: Arc<SecretMasker>,
        http: HttpClient,
    ) -> Self {
        let (tx, rx) = mpsc::channel(COMMAND_CHANNEL_CAPACITY);
        let (incident_tx, incident_rx) = watch::channel(None);
        let incidents = IncidentUploads {
            rx: incident_rx,
            last: None,
            path: format!("{}.oom-evidence.json", telemetry_paths.metrics_log_file),
        };
        let handle = tokio::spawn(run(rx, run_id, telemetry_paths, masker, http, incidents));
        Self {
            tx,
            handle,
            incident_reporter: IncidentReporter {
                tx: incident_tx,
                sandbox_id: None,
            },
        }
    }

    /// Nonblocking producer handle for prioritized incident payloads.
    pub fn incident_reporter(&self) -> IncidentReporter {
        self.incident_reporter.clone()
    }

    /// Spawn the uploader task using explicit guest runtime paths.
    pub fn spawn_for_paths(
        run_id: String,
        guest_paths: &GuestPaths,
        masker: Arc<SecretMasker>,
        http: HttpClient,
    ) -> Self {
        Self::spawn_for_run(
            run_id,
            TelemetryPaths::from_guest_paths(guest_paths),
            masker,
            http,
        )
    }

    /// Trigger a telemetry upload and await completion.
    ///
    /// Use [`UploadMode::Live`] for any flush while the agent is still
    /// running (the producer continues writing). Use [`UploadMode::Final`]
    /// for the very last flush before exit, which consumes the EOF tail when
    /// it fits in one bounded read. A completed upload with a position
    /// persistence failure is reported in [`FlushReport`] rather than as an
    /// upload error.
    pub async fn flush(&self, mode: UploadMode) -> Result<FlushReport, AgentError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Cmd::Flush {
                mode,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AgentError::TelemetryUnavailable)?;
        reply_rx
            .await
            .map_err(|_| AgentError::TelemetryUnavailable)?
    }

    /// Stop the uploader and await graceful task termination.
    ///
    /// Consumes `self`, so no further commands can be sent after this
    /// call. Any commands queued before `shutdown` are processed first
    /// (the loop is FIFO); the task exits when it dequeues the
    /// `Shutdown` command.
    pub async fn shutdown(self) {
        let _ = self.tx.send(Cmd::Shutdown).await;
        let _ = self.handle.await;
    }

    /// Perform the final telemetry upload and stop the uploader task.
    ///
    /// Consumes `self`, so no later periodic `Live` tick or caller-driven
    /// flush can run after the EOF-consuming final pass. A completed upload
    /// with a position persistence failure is reported in [`FlushReport`].
    pub async fn final_flush_and_shutdown(self) -> Result<FlushReport, AgentError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .tx
            .send(Cmd::FinalFlushAndShutdown { reply: reply_tx })
            .await
            .is_err()
        {
            let _ = self.handle.await;
            return Err(AgentError::TelemetryUnavailable);
        }
        let result = reply_rx.await.map_err(|_| AgentError::TelemetryUnavailable);
        let _ = self.handle.await;
        result?
    }
}

/// Single-writer task. Owns all pos-file mutations.
///
/// `biased` select ensures a queued Flush wins over a ready tick at any
/// select boundary, so a caller-driven flush is never blocked behind a
/// tick that hasn't started yet. (A tick already in its `await` cannot
/// be preempted; the worst-case wait for a flush is one in-flight tick.)
async fn run(
    mut rx: mpsc::Receiver<Cmd>,
    run_id: String,
    telemetry_paths: TelemetryPaths,
    masker: Arc<SecretMasker>,
    http: HttpClient,
    mut incidents: IncidentUploads,
) {
    let mut interval =
        tokio::time::interval(Duration::from_secs(constants::TELEMETRY_INTERVAL_SECS));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval`'s first tick is immediately ready. Consume it so periodic
    // uploads start after the first full interval instead of racing explicit
    // startup/final flushes.
    interval.tick().await;

    loop {
        tokio::select! {
            biased;
            cmd = rx.recv() => match cmd {
                Some(Cmd::Flush { mode, reply }) => {
                    let result = upload_with_incidents(&http, &masker, &run_id, &telemetry_paths, mode, &mut incidents).await;
                    let _ = reply.send(result);
                }
                Some(Cmd::FinalFlushAndShutdown { reply }) => {
                    let result = upload_with_incidents(
                        &http,
                        &masker,
                        &run_id,
                        &telemetry_paths,
                        UploadMode::Final,
                        &mut incidents,
                    )
                    .await;
                    let _ = reply.send(result);
                    break;
                }
                Some(Cmd::Shutdown) | None => { incidents.flush(&http, &run_id).await; break; },
            },
            Ok(()) = incidents.rx.changed() => {
                incidents.flush(&http, &run_id).await;
            }
            _ = interval.tick() => {
                let _ = upload_with_incidents(&http, &masker, &run_id, &telemetry_paths, UploadMode::Live, &mut incidents).await;
            }
        }
    }
}

async fn upload_with_incidents(
    http: &HttpClient,
    masker: &SecretMasker,
    run_id: &str,
    paths: &TelemetryPaths,
    mode: UploadMode,
    incidents: &mut IncidentUploads,
) -> Result<FlushReport, AgentError> {
    incidents.flush(http, run_id).await;
    if !http.has_api() {
        return Ok(FlushReport {
            uploaded: false,
            position_persisted: true,
        });
    }
    let upload = upload_telemetry(http, masker, run_id, paths, mode);
    tokio::pin!(upload);
    loop {
        tokio::select! {
            biased;
            // Disable this branch on closure. Looping on its ready error can
            // starve the upload and its HTTP timeout of cooperative budget.
            Ok(()) = incidents.rx.changed() => {
                incidents.flush(http, run_id).await;
            }
            result = &mut upload => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn save_position_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let pos = dir.path().join("test.pos");
        save_position(&pos, 42).unwrap();
        let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
        assert_eq!(val, 42);
    }

    #[test]
    fn save_position_overwrites_existing() {
        let dir = tempfile::tempdir().unwrap();
        let pos = dir.path().join("overwrite.pos");
        save_position(&pos, 10).unwrap();
        save_position(&pos, 20).unwrap();
        let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
        assert_eq!(val, 20);
    }
}
