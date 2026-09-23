use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tokio::sync::mpsc::error::TrySendError;
#[cfg(test)]
use tokio::sync::{Barrier, Notify, Semaphore};
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
    #[cfg(test)]
    write_gate: Option<WriteGate>,
    #[cfg(test)]
    close_gate: Option<CloseGate>,
}

#[cfg(test)]
#[derive(Clone)]
struct WriteGate {
    started: Arc<Notify>,
    release: Arc<Semaphore>,
    blocking: bool,
}

#[cfg(test)]
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
    pub(crate) fn drain_status(&self, producer: &str) -> &'static str {
        self.drain.status(producer)
    }

    pub(crate) fn writer_backpressure_observed(&self) -> bool {
        self.writer_backpressure_observed
    }

    pub(crate) fn writer_failed(&self) -> bool {
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
        let current =
            self.manager
                .begin_session_drain(&self.source_ip, &self.path, self.generation);
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
        #[cfg(test)]
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

    #[cfg(test)]
    pub(crate) fn new_with_write_gate(started: Arc<Notify>, release: Arc<Semaphore>) -> Self {
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

    #[cfg(test)]
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
    #[cfg(test)]
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
                self.inner.writer_config.normalized(),
                #[cfg(test)]
                self.inner.write_gate.clone(),
            )
        })
    }

    fn begin_session_drain(&self, source_ip: &str, path: &Path, generation: u64) -> bool {
        self.inner
            .state
            .begin_session_drain(source_ip, path, generation)
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

    #[cfg(test)]
    async fn before_close_upload_flush_for_test(&self) {
        if let Some(gate) = self.inner.close_gate.as_ref() {
            gate.before_flush.notify_one();
            let permit = gate.release.acquire().await.expect("close gate closed");
            permit.forget();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::poll_fn;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::Path;
    use std::task::Poll;
    use std::time::Duration;

    use serde_json::json;

    use crate::network_log_drain::{NetworkLogDrainCoordinator, NetworkLogDrainProducer};
    use runner_types::ids::RunId;

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn read_json_lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn source_ip_registered(manager: &NetworkLogManager, source_ip: &str) -> bool {
        manager.inner.state.source_ip_registered(source_ip)
    }

    async fn wait_source_ip_unregistered(manager: &NetworkLogManager, source_ip: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if !source_ip_registered(manager, source_ip).await {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "source IP {source_ip} stayed registered after session drop",
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn writer_panic_does_not_strand_accepted_sessions_or_flush_waiters() {
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.jsonl");
        let second_path = dir.path().join("second.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            Arc::clone(&started),
            Arc::clone(&release),
            WriterConfig {
                shards: 1,
                ..Default::default()
            },
        );
        let first = manager
            .register_source_ip("10.0.0.1", first_path.clone())
            .await;
        let second = manager
            .register_source_ip("10.0.0.2", second_path.clone())
            .await;
        assert!(manager.append_for_ip("10.0.0.1", json!({"row": 1})).await);
        started.notified().await;
        // The first batch is owned by the writer; these rows remain queued.
        assert!(manager.append_for_ip("10.0.0.1", json!({"row": 2})).await);
        assert!(manager.append_for_ip("10.0.0.2", json!({"row": 3})).await);
        release.close(); // Fail at the append boundary, unwinding the outer writer.
        let drain = NetworkLogDrainCoordinator::default();
        let (first_observation, second_observation, (), ()) =
            tokio::time::timeout(Duration::from_secs(2), async {
                tokio::join!(
                    first.close_for_upload(RunId::new_v4(), &drain),
                    second.close_for_upload(RunId::new_v4(), &drain),
                    manager.flush_path(&first_path),
                    manager.flush_path(&first_path),
                )
            })
            .await
            .expect("terminated writer must not strand accepted rows or concurrent flush waiters");
        assert!(first_observation.writer_failed());
        assert!(second_observation.writer_failed());
        assert!(!first_path.exists());
        assert!(!second_path.exists());
    }

    // Prevent a failing assertion from leaving a real blocking task held while
    // the test runtime tries to shut down.
    struct CloseWriteGateOnDrop(Arc<Semaphore>);

    impl Drop for CloseWriteGateOnDrop {
        fn drop(&mut self) {
            self.0.close();
        }
    }

    #[tokio::test]
    async fn cancelled_writer_keeps_blocking_append_owned_until_real_file_completion() {
        use tracing_subscriber::prelude::*;
        use tracing_test_support::CapturedEvents;

        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        tracing::callsite::rebuild_interest_cache();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let _release_on_drop = CloseWriteGateOnDrop(Arc::clone(&release));
        let manager = NetworkLogManager::new_for_test(
            Some(WriteGate {
                started: Arc::clone(&started),
                release: Arc::clone(&release),
                blocking: true,
            }),
            None,
            WriterConfig {
                shards: 1,
                ..Default::default()
            },
        );
        let session = manager.register_source_ip("10.0.0.1", path.clone()).await;
        assert!(manager.append_for_ip("10.0.0.1", json!({"row": 1})).await);
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        assert!(manager.append_for_ip("10.0.0.1", json!({"row": 2})).await);
        let writer = &manager.writer_pool().tasks[0];
        writer.abort();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !writer.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let drain = NetworkLogDrainCoordinator::noop();
        let run_id = RunId::new_v4();
        let close = session.close_for_upload(run_id, &drain);
        tokio::pin!(close);
        tokio::select! {
            biased;
            _ = &mut close => panic!("outer writer cancellation discharged an active blocking append"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(!path.exists());
        tokio::time::pause();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(31)).await;
        tokio::task::yield_now().await;
        assert!(
            captured.entries().iter().any(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("required cleanup still pending")
                    && event.fields.get("phase").map(String::as_str) == Some("accepted_write_flush")
                    && event.fields.get("run_id") == Some(&run_id.to_string())
            }),
            "delayed flush must identify its run without claiming completion"
        );
        tokio::time::resume();
        release.add_permits(1);
        let observation = tokio::time::timeout(Duration::from_secs(2), close)
            .await
            .unwrap();
        assert!(
            observation.writer_failed(),
            "the queued row was abandoned, not persisted"
        );
        assert_eq!(read_json_lines(&path), vec![json!({"row": 1})]);
    }

    #[tokio::test]
    async fn blocking_append_failure_is_observed_after_source_mapping_is_removed() {
        for panic in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("network.jsonl");
            // A directory is rejected by the actual append boundary.
            std::fs::create_dir(&path).unwrap();
            let started = Arc::new(Notify::new());
            let release = Arc::new(Semaphore::new(0));
            let _release_on_drop = CloseWriteGateOnDrop(Arc::clone(&release));
            let manager = NetworkLogManager::new_for_test(
                Some(WriteGate {
                    started: Arc::clone(&started),
                    release: Arc::clone(&release),
                    blocking: true,
                }),
                None,
                WriterConfig::default(),
            );
            let session = manager.register_source_ip("10.0.0.1", path.clone()).await;
            assert!(manager.append_for_ip("10.0.0.1", json!({"row": 1})).await);
            tokio::time::timeout(Duration::from_secs(2), started.notified())
                .await
                .unwrap();
            let drain = NetworkLogDrainCoordinator::noop();
            let close = session.close_for_upload(RunId::new_v4(), &drain);
            tokio::pin!(close);
            tokio::select! {
                biased;
                _ = &mut close => panic!("close completed before append result"),
                _ = tokio::task::yield_now() => {}
            }
            assert!(!source_ip_registered(&manager, "10.0.0.1").await);
            if panic {
                release.close();
            } else {
                release.add_permits(1);
            }
            let observation = tokio::time::timeout(Duration::from_secs(2), close)
                .await
                .unwrap();
            assert!(observation.writer_failed());
            assert!(path.is_dir());
        }
    }

    #[tokio::test]
    async fn append_for_ip_writes_json_line_to_registered_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"example.com","port":53}),
                )
                .await
        );

        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], "dns");
        assert_eq!(lines[0]["host"], "example.com");
        assert_eq!(lines[0]["port"], 53);
        assert_eq!(mode(&path), 0o600);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_use_accepts_every_row() {
        const APPEND_COUNT: usize = 32;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let barrier = Arc::new(Barrier::new(APPEND_COUNT));
        let mut sessions = Vec::with_capacity(APPEND_COUNT);
        let mut append_tasks = Vec::with_capacity(APPEND_COUNT);

        for index in 0..APPEND_COUNT {
            let source_ip = format!("10.200.0.{}", index + 1);
            sessions.push(
                manager
                    .register_source_ip(source_ip.clone(), path.clone())
                    .await,
            );

            let manager = manager.clone();
            let barrier = barrier.clone();
            append_tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                manager
                    .append_for_ip(&source_ip, json!({"type":"dns","index":index}))
                    .await
            }));
        }

        for task in append_tasks {
            assert!(task.await.unwrap());
        }
        manager.flush_path(&path).await;

        let mut indices: Vec<u64> = read_json_lines(&path)
            .iter()
            .map(|line| line["index"].as_u64().unwrap())
            .collect();
        indices.sort_unstable();
        assert_eq!(indices, (0..APPEND_COUNT as u64).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn append_for_ip_flushes_after_rejecting_unsafe_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.jsonl");
        let path = dir.path().join("network.jsonl");
        symlink(&target, &path).unwrap();
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"example.com","port":53}),
                )
                .await
        );

        manager.flush_path(&path).await;

        assert!(!target.exists());
    }

    #[tokio::test]
    async fn flush_path_waits_for_accepted_pending_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"held.test"}))
                .await
        );
        started.notified().await;

        let mut flush = std::pin::pin!(manager.flush_path(&path));
        let pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await;
        assert!(
            pending,
            "flush should wait while the accepted write is pending"
        );

        release.add_permits(1);
        flush.await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "held.test");
    }

    #[tokio::test]
    async fn flush_path_waits_for_all_pending_writes_for_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _session_a = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let _session_b = manager.register_source_ip("10.200.0.3", path.clone()).await;

        let first_started = started.notified();
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
                .await
        );
        first_started.await;

        assert!(
            manager
                .append_for_ip("10.200.0.3", json!({"type":"dns","host":"second.test"}))
                .await
        );

        let mut flush = std::pin::pin!(manager.flush_path(&path));
        let pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await;
        assert!(
            pending,
            "flush should wait while both accepted writes are pending"
        );

        let second_started = started.notified();
        release.add_permits(1);
        second_started.await;
        let still_pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await;
        assert!(
            still_pending,
            "flush should still wait after only one pending write is released"
        );

        release.add_permits(1);
        flush.await;

        let lines = read_json_lines(&path);
        let hosts: std::collections::HashSet<String> = lines
            .iter()
            .map(|line| line["host"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            hosts,
            ["first.test", "second.test"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
    }

    #[tokio::test]
    async fn append_failure_decrements_pending_and_flush_completes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"bad-path.test"}))
                .await
        );

        manager.flush_path(&path).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn append_for_ip_preserves_same_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        for index in 0..20 {
            assert!(
                manager
                    .append_for_ip("10.200.0.2", json!({"type":"dns","index":index}))
                    .await
            );
        }

        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        let indices: Vec<u64> = lines
            .iter()
            .map(|line| line["index"].as_u64().unwrap())
            .collect();
        assert_eq!(indices, (0_u64..20).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn append_after_unregister_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        manager.unregister_source_ip("10.200.0.2").await;

        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old.test"}))
                .await
        );
        manager.flush_path(&path).await;

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn accepted_write_lands_after_unregister() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"accepted.test"}))
                .await
        );
        started.notified().await;

        manager.unregister_source_ip("10.200.0.2").await;
        release.add_permits(1);
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "accepted.test");
    }

    #[tokio::test]
    async fn repeated_appends_share_path_and_stay_on_old_path_after_reregister() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = dir.path().join("new.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            started.clone(),
            release.clone(),
            WriterConfig {
                shards: 1,
                queue_capacity: 4,
                max_batch_rows: 1,
                max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            },
        );

        let _old_session = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;
        let old_started = started.notified();
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old-1.test"}))
                .await
        );
        old_started.await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old-2.test"}))
                .await
        );
        assert!(
            manager
                .inner
                .state
                .source_and_pending_path_share_identity("10.200.0.2", &old_path),
            "repeated appends should reuse the registered path allocation"
        );

        manager.unregister_source_ip("10.200.0.2").await;
        let _new_session = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );
        assert!(
            manager
                .inner
                .state
                .source_and_pending_path_share_identity("10.200.0.2", &new_path),
            "re-registered source should share its new path allocation"
        );

        release.add_permits(3);
        manager.flush_path(&old_path).await;
        manager.flush_path(&new_path).await;

        let old_lines = read_json_lines(&old_path);
        let old_hosts: Vec<&str> = old_lines
            .iter()
            .map(|line| line["host"].as_str().unwrap())
            .collect();
        assert_eq!(old_hosts, ["old-1.test", "old-2.test"]);

        let new_lines = read_json_lines(&new_path);
        assert_eq!(new_lines.len(), 1);
        assert_eq!(new_lines[0]["host"], "new.test");
    }

    #[tokio::test]
    async fn queue_full_waits_without_accepting_row_before_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            started.clone(),
            release.clone(),
            WriterConfig {
                shards: 1,
                queue_capacity: 1,
                max_batch_rows: 1,
                max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            },
        );

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
                .await
        );
        started.notified().await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"second.test"}))
                .await
        );

        let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","host":"third.test"}));
        let mut third = std::pin::pin!(third);
        let pending = poll_fn(|cx| match third.as_mut().poll(cx) {
            Poll::Ready(accepted) => Poll::Ready(Some(accepted)),
            Poll::Pending => Poll::Ready(None),
        })
        .await;
        assert_eq!(
            pending, None,
            "third append should wait for bounded queue capacity"
        );

        manager.unregister_source_ip("10.200.0.2").await;
        release.add_permits(2);
        assert!(
            !third.await,
            "append waiting for capacity must re-check source mapping before acceptance"
        );
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        let hosts: Vec<&str> = lines
            .iter()
            .map(|line| line["host"].as_str().unwrap())
            .collect();
        assert_eq!(hosts, ["first.test", "second.test"]);
    }

    #[tokio::test]
    async fn queue_full_is_reported_without_losing_or_reordering_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            started.clone(),
            release.clone(),
            WriterConfig {
                shards: 1,
                queue_capacity: 1,
                max_batch_rows: 1,
                max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            },
        );
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","index":1}))
                .await
        );
        started.notified().await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","index":2}))
                .await
        );

        let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","index":3}));
        let mut third = std::pin::pin!(third);
        assert!(
            poll_fn(|cx| match third.as_mut().poll(cx) {
                Poll::Ready(_) => Poll::Ready(false),
                Poll::Pending => Poll::Ready(true),
            })
            .await
        );

        release.add_permits(3);
        assert!(third.await);
        let observation = session
            .close_for_upload(
                RunId::from(uuid::Uuid::nil()),
                &NetworkLogDrainCoordinator::noop(),
            )
            .await;

        assert!(observation.writer_backpressure_observed());
        let indices: Vec<u64> = read_json_lines(&path)
            .iter()
            .map(|line| line["index"].as_u64().unwrap())
            .collect();
        assert_eq!(indices, [1, 2, 3]);
    }

    #[tokio::test]
    async fn immediately_reserved_session_reports_no_writer_backpressure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"ready.test"}))
                .await
        );

        let observation = session
            .close_for_upload(
                RunId::from(uuid::Uuid::nil()),
                &NetworkLogDrainCoordinator::noop(),
            )
            .await;

        assert!(!observation.writer_backpressure_observed());
        assert_eq!(observation.drain_status("dns"), "not_configured");
    }

    #[tokio::test]
    async fn queue_full_rejects_row_after_source_reregister_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate_and_config(
            started.clone(),
            release.clone(),
            WriterConfig {
                shards: 1,
                queue_capacity: 1,
                max_batch_rows: 1,
                max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            },
        );

        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
                .await
        );
        started.notified().await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"second.test"}))
                .await
        );

        let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","host":"third.test"}));
        let mut third = std::pin::pin!(third);
        let pending = poll_fn(|cx| match third.as_mut().poll(cx) {
            Poll::Ready(accepted) => Poll::Ready(Some(accepted)),
            Poll::Pending => Poll::Ready(None),
        })
        .await;
        assert_eq!(
            pending, None,
            "third append should wait for bounded queue capacity"
        );

        manager.unregister_source_ip("10.200.0.2").await;
        let new_session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        release.add_permits(2);
        assert!(
            !third.await,
            "append waiting for capacity must not cross source generations"
        );
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        let hosts: Vec<&str> = lines
            .iter()
            .map(|line| line["host"].as_str().unwrap())
            .collect();
        assert_eq!(hosts, ["first.test", "second.test"]);
        let observation = new_session
            .close_for_upload(
                RunId::from(uuid::Uuid::nil()),
                &NetworkLogDrainCoordinator::noop(),
            )
            .await;
        assert!(
            !observation.writer_backpressure_observed(),
            "an old source generation must not mark its replacement"
        );
    }

    #[tokio::test]
    async fn reregistered_source_ip_routes_to_new_path_only() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = dir.path().join("new.jsonl");
        let manager = NetworkLogManager::new();

        let _old_session = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;
        manager.unregister_source_ip("10.200.0.2").await;
        let _new_session = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;

        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );
        manager.flush_path(&new_path).await;

        assert!(!old_path.exists());
        let lines = read_json_lines(&new_path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "new.test");
    }

    #[tokio::test]
    async fn draining_session_accepts_late_rows_until_finalized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;

        manager.begin_session_drain(&session.source_ip, &session.path, session.generation);
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"late.test"}))
                .await
        );
        manager.flush_path(&path).await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "late.test");

        manager.finalize_session(&session.source_ip, &session.path, session.generation);
        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"closed.test"}))
                .await
        );
    }

    #[tokio::test]
    async fn old_session_finalize_does_not_remove_new_registration() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = dir.path().join("new.jsonl");
        let manager = NetworkLogManager::new();
        let old = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;

        manager.begin_session_drain(&old.source_ip, &old.path, old.generation);
        let _new_session = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;
        manager.finalize_session(&old.source_ip, &old.path, old.generation);

        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
                .await
        );
        manager.flush_path(&new_path).await;

        assert!(!old_path.exists());
        let lines = read_json_lines(&new_path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "new.test");
    }

    #[tokio::test]
    async fn dropped_unclosed_session_finalizes_mapping() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(source_ip_registered(&manager, "10.200.0.2").await);

        drop(session);
        wait_source_ip_unregistered(&manager, "10.200.0.2").await;

        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"after-drop.test"}))
                .await
        );
        manager.flush_path(&path).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn close_for_upload_waits_for_barrier_and_flushes_late_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("test");
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);

        let manager_for_barrier = manager.clone();
        let barrier = tokio::spawn(async move {
            let request = drain_rx.recv().await.expect("drain request");
            assert!(
                manager_for_barrier
                    .append_for_ip(
                        "10.200.0.2",
                        json!({"type":"dns","host":"during-drain.test"}),
                    )
                    .await
            );
            request.ack();
        });

        session
            .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
            .await;
        barrier.await.unwrap();

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "during-drain.test");
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-close.test"})
                )
                .await
        );
    }

    #[tokio::test]
    async fn close_for_upload_closes_source_before_final_flush() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let before_flush = Arc::new(Notify::new());
        let close_release = Arc::new(Semaphore::new(0));
        let manager =
            NetworkLogManager::new_with_close_gate(before_flush.clone(), close_release.clone());
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let drain = NetworkLogDrainCoordinator::noop();

        let close = tokio::spawn(async move {
            session
                .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
                .await;
        });
        // Pause at the upload-flush boundary and verify the mapping is already
        // closed, so no row can be accepted after the final flush begins.
        before_flush.notified().await;

        let registered_before_flush = source_ip_registered(&manager, "10.200.0.2").await;
        let accepted_after_close = manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"after-close-before-flush.test"}),
            )
            .await;

        close_release.add_permits(1);
        close.await.unwrap();

        assert!(
            !registered_before_flush,
            "source mapping must be closed before the upload flush begins"
        );
        assert!(
            !accepted_after_close,
            "append_for_ip must reject rows once close_for_upload reaches the final flush"
        );
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn close_for_upload_with_unavailable_producer_finalizes_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let (producer, drain_rx) = NetworkLogDrainProducer::channel("closed");
        drop(drain_rx);
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);

        let observation = session
            .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
            .await;

        assert!(!source_ip_registered(&manager, "10.200.0.2").await);
        assert_eq!(observation.drain_status("closed"), "producer_unavailable");
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-close.test"})
                )
                .await
        );
    }

    #[tokio::test]
    async fn close_for_upload_with_dropped_ack_finalizes_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("dropped-ack");
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);
        let receiver = tokio::spawn(async move {
            let request = drain_rx.recv().await.expect("drain request");
            drop(request);
        });

        let observation = session
            .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
            .await;
        receiver.await.unwrap();

        assert!(!source_ip_registered(&manager, "10.200.0.2").await);
        assert_eq!(observation.drain_status("dropped-ack"), "ack_dropped");
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-close.test"})
                )
                .await
        );
    }

    #[tokio::test]
    async fn close_for_upload_timeout_still_flushes_accepted_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        let manager = NetworkLogManager::new();
        let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","host":"accepted.test"}),)
                .await
        );
        let (producer, _drain_rx) = NetworkLogDrainProducer::channel("held");
        let drain = NetworkLogDrainCoordinator::new_with_timeout_for_test(
            vec![producer],
            Duration::from_millis(1),
        );

        let observation = session
            .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
            .await;

        let lines = read_json_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["host"], "accepted.test");
        assert_eq!(observation.drain_status("held"), "ack_timeout");
        assert!(
            !manager
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"after-timeout.test"})
                )
                .await
        );
    }
}
