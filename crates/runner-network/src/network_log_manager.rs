use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

#[cfg(test)]
use tokio::sync::Barrier;
use tokio::sync::mpsc::error::TrySendError;
#[cfg(any(test, feature = "test-support"))]
use tokio::sync::{Notify, Semaphore};
use tracing::warn;

use crate::network_log_drain::{NetworkLogDrainContext, NetworkLogDrainCoordinator};
use runner_types::ids::RunId;

mod file_append;
mod state;
mod writer;

use state::NetworkLogState;
use writer::{WriterConfig, WriterPool};

#[cfg(test)]
use writer::DEFAULT_MAX_BATCH_BYTES;

/// Coordinates Rust-side DNS/kmsg network log attribution and file writes.
///
/// Source-IP acceptance and pending-write registration happen under the same
/// lock, so `flush_path` cannot miss a row that was already accepted for that
/// path.
/// `NetworkLogSession::close_for_upload` first closes the source mapping, then
/// flushes the path so upload cannot miss a newly accepted row.
#[derive(Clone, Default)]
pub struct NetworkLogManager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: Arc<NetworkLogState>,
    writers: OnceLock<WriterPool>,
    writer_config: WriterConfig,
    #[cfg(any(test, feature = "test-support"))]
    write_gate: Option<WriteGate>,
    #[cfg(any(test, feature = "test-support"))]
    close_gate: Option<CloseGate>,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone)]
struct WriteGate {
    started: Arc<Notify>,
    release: Arc<Semaphore>,
    blocking: bool,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone)]
struct CloseGate {
    before_flush: Arc<Notify>,
    release: Arc<Semaphore>,
}

/// Owns a source-IP network-log attribution for one runner job.
///
/// Keep this value alive until the sandbox is parked or stopped, then call
/// [`NetworkLogSession::close_for_upload`] before reading/uploading the job's
/// network log. Dropping it is only a best-effort cleanup fallback.
#[must_use = "dropping a NetworkLogSession immediately closes network-log attribution"]
pub struct NetworkLogSession {
    manager: NetworkLogManager,
    source_ip: String,
    path: Arc<Path>,
    generation: u64,
    closed: bool,
    writer_failed: Arc<AtomicBool>,
}

/// Failure-scoped state observed while closing one network-log session.
pub struct NetworkLogCloseObservation {
    drain: crate::network_log_drain::NetworkLogDrainReport,
    writer_backpressure_observed: bool,
    writer_failed: bool,
}

impl NetworkLogCloseObservation {
    pub fn drain_status(&self, producer: &str) -> &'static str {
        self.drain.status(producer)
    }

    pub fn writer_backpressure_observed(&self) -> bool {
        self.writer_backpressure_observed
    }

    pub fn writer_failed(&self) -> bool {
        self.writer_failed
    }
}

impl NetworkLogSession {
    /// Close local Rust-side network logs for this run before upload reads the file.
    ///
    /// The barrier only covers rows observable to the runner reader tasks. It
    /// cannot prove delivery for data still buffered inside dnsmasq, `dmesg`,
    /// or the kernel before those producers emit to their monitored streams.
    ///
    /// Once the producer barrier completes, this closes the source mapping
    /// before the final path flush. Rows accepted before finalization remain
    /// tracked by the path pending count; rows racing after finalization are
    /// rejected instead of being missed by upload.
    pub async fn close_for_upload(
        mut self,
        run_id: RunId,
        drain: &NetworkLogDrainCoordinator,
    ) -> NetworkLogCloseObservation {
        let current = self
            .manager
            .is_current_session(&self.source_ip, &self.path, self.generation);
        let drain = if current {
            drain
                .drain(NetworkLogDrainContext {
                    run_id,
                    source_ip: &self.source_ip,
                    path: &self.path,
                    generation: self.generation,
                })
                .await
        } else {
            Default::default()
        };
        let writer_backpressure_observed =
            self.manager
                .finalize_session(&self.source_ip, &self.path, self.generation);
        #[cfg(any(test, feature = "test-support"))]
        self.manager.before_close_upload_flush_for_test().await;
        {
            use tracing::Instrument;
            async {
                let _progress = runner_host::cleanup_progress::CleanupProgress::start(
                    "network_log",
                    "accepted_write_flush",
                    runner_host::cleanup_progress::CleanupIdentity::Run(run_id),
                );
                self.manager.flush_path(&self.path).await;
            }
            .instrument(tracing::info_span!(
                "network_log_flush", %run_id, source_ip = %self.source_ip,
                path = %self.path.display(), generation = self.generation
            ))
            .await;
        }
        self.closed = true;
        let writer_failed = self.writer_failed.load(Ordering::Acquire);
        if writer_failed {
            warn!(%run_id, path = %self.path.display(), "network log session closed with write failures");
        }
        NetworkLogCloseObservation {
            drain,
            writer_backpressure_observed,
            writer_failed,
        }
    }
}

impl Drop for NetworkLogSession {
    fn drop(&mut self) {
        if self.closed {
            return;
        }

        self.manager
            .finalize_session(&self.source_ip, &self.path, self.generation);
    }
}

impl NetworkLogManager {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn new_with_write_gate(started: Arc<Notify>, release: Arc<Semaphore>) -> Self {
        Self::new_for_test(
            Some(WriteGate {
                started,
                release,
                blocking: false,
            }),
            None,
            WriterConfig::default(),
        )
    }

    #[cfg(test)]
    fn new_with_write_gate_and_config(
        started: Arc<Notify>,
        release: Arc<Semaphore>,
        writer_config: WriterConfig,
    ) -> Self {
        Self::new_for_test(
            Some(WriteGate {
                started,
                release,
                blocking: false,
            }),
            None,
            writer_config,
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    fn new_for_test(
        write_gate: Option<WriteGate>,
        close_gate: Option<CloseGate>,
        writer_config: WriterConfig,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Arc::new(NetworkLogState::default()),
                writers: OnceLock::new(),
                writer_config,
                write_gate,
                close_gate,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_close_gate(
        before_flush: Arc<Notify>,
        close_release: Arc<Semaphore>,
    ) -> Self {
        Self::new_for_test(
            None,
            Some(CloseGate {
                before_flush,
                release: close_release,
            }),
            WriterConfig::default(),
        )
    }

    pub async fn register_source_ip(
        &self,
        source_ip: impl Into<String>,
        path: PathBuf,
    ) -> NetworkLogSession {
        let registration = self.inner.state.register_source_ip(source_ip.into(), path);
        NetworkLogSession {
            manager: self.clone(),
            source_ip: registration.source_ip,
            path: registration.path,
            generation: registration.generation,
            closed: false,
            writer_failed: registration.writer_failed,
        }
    }

    /// Remove a source mapping immediately.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn unregister_source_ip(&self, source_ip: &str) {
        self.inner.state.unregister_source_ip(source_ip);
    }

    /// Accept a JSON network-log row for a source IP.
    ///
    /// Returns `true` when the source IP was mapped and the write was accepted.
    /// The actual append is asynchronous; call `flush_path` before reading the
    /// file when a complete snapshot of already accepted writes is required.
    /// `flush_path` does not close source acceptance; use `NetworkLogSession`
    /// when preparing a per-run file for upload.
    pub async fn append_for_ip(&self, source_ip: &str, row: serde_json::Value) -> bool {
        let line = match serde_json::to_string(&row) {
            Ok(mut line) => {
                line.push('\n');
                line
            }
            Err(e) => {
                warn!(source_ip, error = %e, "failed to serialize network log row");
                return false;
            }
        };

        let Some(snapshot) = self.inner.state.source_snapshot(source_ip) else {
            return false;
        };
        let writer_pool = self.writer_pool();
        let Some(sender) = writer_pool.sender_for_path(&snapshot.path) else {
            warn!("network log writer pool has no shards");
            return false;
        };
        let permit = match sender.try_reserve_owned() {
            Ok(permit) => permit,
            Err(TrySendError::Full(sender)) => {
                self.inner
                    .state
                    .mark_writer_backpressure(source_ip, &snapshot);
                match sender.reserve_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        warn!(
                            path = %snapshot.path.display(),
                            "network log writer shard closed before append was accepted"
                        );
                        return false;
                    }
                }
            }
            Err(TrySendError::Closed(_)) => {
                warn!(
                    path = %snapshot.path.display(),
                    "network log writer shard closed before append was accepted"
                );
                return false;
            }
        };

        let Some(accepted_append) = self
            .inner
            .state
            .try_accept_snapshot(source_ip, &snapshot, line)
        else {
            return false;
        };
        permit.send(accepted_append);
        true
    }

    fn writer_pool(&self) -> &WriterPool {
        self.inner.writers.get_or_init(|| {
            WriterPool::start(
                self.inner.writer_config,
                #[cfg(any(test, feature = "test-support"))]
                self.inner.write_gate.clone(),
            )
        })
    }

    fn is_current_session(&self, source_ip: &str, path: &Path, generation: u64) -> bool {
        self.inner
            .state
            .is_current_session(source_ip, path, generation)
    }

    fn finalize_session(&self, source_ip: &str, path: &Path, generation: u64) -> bool {
        self.inner
            .state
            .finalize_session(source_ip, path, generation)
    }

    /// Wait until all currently accepted Rust-side writes for `path` finish.
    pub async fn flush_path(&self, path: &Path) {
        self.inner.state.flush_path(path).await;
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::expect_used)]
    async fn before_close_upload_flush_for_test(&self) {
        if let Some(gate) = self.inner.close_gate.as_ref() {
            gate.before_flush.notify_one();
            let permit = gate.release.acquire().await.expect("close gate closed");
            permit.forget();
        }
    }
}

#[cfg(test)]
mod tests;
