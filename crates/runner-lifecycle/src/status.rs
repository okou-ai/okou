use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sandbox::SandboxId;
use serde::Serialize;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tracing::warn;

use crate::error::{LifecycleError, LifecycleResult};
use crate::idle_pool::IdlePoolSnapshot;
use crate::lifecycle::RunnerMode;
use runner_types::ids::RunId;

const STATUS_PERSISTENCE_TIMEOUT: Duration = Duration::from_secs(5);

/// Failure to publish one whole runner status snapshot.
#[derive(Debug, thiserror::Error)]
pub enum StatusPersistenceError {
    #[error("serialize runner status for {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("write runner status {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: LifecycleError,
    },
    /// Publication of this snapshot was not confirmed within the foreground
    /// budget, or it was immediately deferred behind a retained in-flight write.
    ///
    /// A write can be retained after its caller is cancelled, even if no deadline
    /// elapsed. `timeout` is the configured foreground publication budget, not
    /// the measured elapsed time for this call.
    ///
    /// The write may not have started, may still finish after this error, or
    /// may be superseded by a newer coalesced snapshot. A started write is not
    /// cancelled by the timeout. Use
    /// [`StatusTracker::retry_unpublished_snapshot`] to request publication of
    /// the tracker's current state rather than assuming the file is unchanged.
    #[error(
        "runner status persistence for {path} is unconfirmed (configured publication budget: {timeout:?})"
    )]
    Timeout { path: PathBuf, timeout: Duration },
}

pub type StatusResult<T> = Result<T, StatusPersistenceError>;

/// Active run lifecycle phase serialized as `active_runs[*].phase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActiveRunPhase {
    /// The run is claimed and visible in `active_runs`, but sandbox activation
    /// has not committed. A fresh Firecracker process may not exist yet, while
    /// a reused process may still be parked.
    Preparing,
    /// The sandbox is prepared, and the run is expected to be associated with
    /// a Firecracker process.
    Running,
}

/// One active run entry serialized under `status.json` `active_runs`.
///
/// `run_id` is the user/control-plane visible run identity. `sandbox_id` is
/// the sandbox identity used by runner maintenance commands to correlate
/// Firecracker state. After sandbox reuse these can differ: the sandbox keeps its
/// original `sandbox_id`, while each successive job has a fresh `run_id`.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveRun {
    /// User/control-plane visible run id.
    pub run_id: RunId,
    /// Sandbox id assigned to this run.
    ///
    /// Runner doctor, kill, and exec use this as the join key when correlating
    /// status entries with Firecracker processes.
    pub sandbox_id: SandboxId,
    /// Current active-run phase serialized as `active_runs[*].phase`.
    pub phase: ActiveRunPhase,
    /// Timestamp when the current phase started.
    ///
    /// This is reset on `preparing -> running`; it is not the run creation
    /// timestamp.
    #[serde(serialize_with = "serialize_iso")]
    pub phase_started_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct ActiveRunState {
    sandbox_id: SandboxId,
    phase: ActiveRunPhase,
    phase_started_at: DateTime<Utc>,
}

/// One parked sandbox's reuse identity and Firecracker sandbox identity.
#[derive(Debug, Clone, Serialize)]
pub struct IdleSandbox {
    pub reuse_key: String,
    pub sandbox_id: SandboxId,
}

/// One ready blank, without a tenant reuse key or run identity.
#[derive(Debug, Clone, Serialize)]
pub struct BlankSandbox {
    pub sandbox_id: SandboxId,
}

#[derive(Debug, Serialize)]
struct RunnerStatus {
    mode: RunnerMode,
    max_concurrent: usize,
    active_runs: Vec<ActiveRun>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    idle_sandboxes: Vec<IdleSandbox>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    blank_sandboxes: Vec<BlankSandbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dns_port: Option<u16>,
    #[serde(serialize_with = "serialize_iso")]
    started_at: DateTime<Utc>,
    #[serde(serialize_with = "serialize_iso")]
    updated_at: DateTime<Utc>,
}

struct StatusSnapshot {
    generation: u64,
    status: RunnerStatus,
}

struct SerializedStatusSnapshot {
    generation: u64,
    json: String,
}

struct DelayedPersistenceState {
    active: bool,
    pending: Option<SerializedStatusSnapshot>,
}

struct PersistenceCoordinator {
    ordering: Arc<Mutex<()>>,
    published_generation: AtomicU64,
    delayed: std::sync::Mutex<DelayedPersistenceState>,
    #[cfg(any(test, feature = "test-support"))]
    settled: tokio::sync::Notify,
}

type StatusWriteFuture = Pin<Box<dyn Future<Output = StatusResult<()>> + Send + 'static>>;

enum InFlightStatusWriteState {
    Unpolled {
        write: StatusWriteFuture,
        ordering: OwnedMutexGuard<()>,
    },
    PollCommitted {
        write: StatusWriteFuture,
        ordering: OwnedMutexGuard<()>,
    },
    Complete,
}

struct InFlightStatusWrite {
    state: InFlightStatusWriteState,
    persistence: Arc<PersistenceCoordinator>,
    path: PathBuf,
    generation: u64,
}

impl PersistenceCoordinator {
    fn new() -> Self {
        Self {
            ordering: Arc::new(Mutex::new(())),
            published_generation: AtomicU64::new(0),
            delayed: std::sync::Mutex::new(DelayedPersistenceState {
                active: false,
                pending: None,
            }),
            #[cfg(any(test, feature = "test-support"))]
            settled: tokio::sync::Notify::new(),
        }
    }

    fn defer_if_delayed(
        &self,
        snapshot: SerializedStatusSnapshot,
    ) -> Option<SerializedStatusSnapshot> {
        let mut delayed = self
            .delayed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !delayed.active {
            return Some(snapshot);
        }
        let replace = delayed
            .pending
            .as_ref()
            .is_none_or(|pending| pending.generation < snapshot.generation);
        if replace {
            delayed.pending = Some(snapshot);
        }
        None
    }

    fn begin_delayed_write(&self) {
        let mut delayed = self
            .delayed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        delayed.active = true;
    }

    fn take_pending_or_finish(&self) -> Option<SerializedStatusSnapshot> {
        let mut delayed = self
            .delayed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match delayed.pending.take() {
            Some(snapshot) => Some(snapshot),
            None => {
                delayed.active = false;
                #[cfg(any(test, feature = "test-support"))]
                self.settled.notify_waiters();
                None
            }
        }
    }
}

impl InFlightStatusWrite {
    fn new(
        write: StatusWriteFuture,
        ordering: OwnedMutexGuard<()>,
        persistence: Arc<PersistenceCoordinator>,
        path: PathBuf,
        generation: u64,
    ) -> Self {
        Self {
            state: InFlightStatusWriteState::Unpolled { write, ordering },
            persistence,
            path,
            generation,
        }
    }

    async fn finish(&mut self) -> StatusResult<()> {
        // Commit custody before polling, without implying I/O or publication.
        self.state = match std::mem::replace(&mut self.state, InFlightStatusWriteState::Complete) {
            InFlightStatusWriteState::Unpolled { write, ordering }
            | InFlightStatusWriteState::PollCommitted { write, ordering } => {
                InFlightStatusWriteState::PollCommitted { write, ordering }
            }
            InFlightStatusWriteState::Complete => return Ok(()),
        };
        let result = match &mut self.state {
            InFlightStatusWriteState::Unpolled { write, .. }
            | InFlightStatusWriteState::PollCommitted { write, .. } => write.as_mut().await,
            InFlightStatusWriteState::Complete => return Ok(()),
        };
        if result.is_ok() {
            self.persistence
                .published_generation
                .store(self.generation, Ordering::Release);
        }
        self.state = InFlightStatusWriteState::Complete;
        result
    }
}

impl Drop for InFlightStatusWrite {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let InFlightStatusWriteState::PollCommitted { write, ordering } =
            std::mem::replace(&mut self.state, InFlightStatusWriteState::Complete)
        else {
            return;
        };
        let persistence = Arc::clone(&self.persistence);
        let path = self.path.clone();
        let generation = self.generation;
        // The caller can disappear independently of the five-second timeout.
        // Keep any polled atomic replacement and its ordering guard alive so
        // an older generation cannot finish after a recovery write.
        persistence.begin_delayed_write();
        drop(tokio::spawn(continue_in_flight_status_write(
            write,
            ordering,
            persistence,
            path,
            generation,
        )));
    }
}

async fn continue_in_flight_status_write(
    write: StatusWriteFuture,
    _ordering: OwnedMutexGuard<()>,
    persistence: Arc<PersistenceCoordinator>,
    path: PathBuf,
    generation: u64,
) {
    if let Err(error) = write.await {
        warn!(generation, %error, "in-flight status persistence later failed");
    } else {
        persistence
            .published_generation
            .store(generation, Ordering::Release);
    }
    while let Some(pending) = persistence.take_pending_or_finish() {
        let pending_generation = pending.generation;
        if persistence.published_generation.load(Ordering::Acquire) >= pending_generation {
            continue;
        }
        if let Err(source) =
            runner_host::private_fs::write_private_file(&path, pending.json.as_bytes()).await
        {
            let error = StatusPersistenceError::Write {
                path: path.clone(),
                source: source.into(),
            };
            warn!(
                generation = pending_generation,
                %error,
                "deferred status persistence failed"
            );
        } else {
            persistence
                .published_generation
                .store(pending_generation, Ordering::Release);
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone)]
struct StatusWriteGate {
    generation: u64,
    phase: StatusWriteGatePhase,
    started: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StatusWriteGatePhase {
    BeforeWrite,
    AtomicWrite,
}

/// Serialize as ISO 8601 with millisecond precision, matching JS `Date.toISOString()`.
fn serialize_iso<S: serde::Serializer>(dt: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Thread-safe status tracker that persists state to a JSON file atomically.
///
/// Share via `Arc<StatusTracker>` — immutable fields live outside the mutex.
/// When a mutator changes state, it updates in-memory state before attempting
/// publication. A [`StatusPersistenceError::Timeout`] does not roll back
/// that state or prove that the file is unchanged: an in-flight write may
/// publish later. Call [`Self::retry_unpublished_snapshot`] to request
/// publication of the current state when the outcome is uncertain.
pub struct StatusTracker {
    started_at: DateTime<Utc>,
    max_concurrent: usize,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    path: PathBuf,
    state: Mutex<MutableState>,
    persistence: Arc<PersistenceCoordinator>,
    #[cfg(any(test, feature = "test-support"))]
    write_gate: Option<StatusWriteGate>,
    #[cfg(any(test, feature = "test-support"))]
    idle_info_update_requests: AtomicU64,
    #[cfg(any(test, feature = "test-support"))]
    idle_snapshot_waits: tokio::sync::watch::Sender<u64>,
}

struct MutableState {
    /// Monotonic generation assigned to every requested whole-status write.
    generation: u64,
    mode: RunnerMode,
    /// Map of run_id → active run state for all active runs. Keyed by run_id so
    /// conditional active-run removal stays O(log n); the paired `sandbox_id`
    /// is the join key used by doctor and kill to find the FC process.
    ///
    /// BTreeMap (not HashMap) for deterministic iteration order — status.json
    /// output should be stable across runs for readability and diffing.
    active_runs: BTreeMap<RunId, ActiveRunState>,
    /// Both parked inventories paired with their last applied pool mutation revision.
    ///
    /// Idle pool callers snapshot under the pool lock, drop it, then write
    /// status asynchronously. The revision prevents an older delayed snapshot
    /// from overwriting a newer drain/evict state.
    idle_snapshot: IdlePoolSnapshot,
}

impl StatusTracker {
    /// Build a tracker that will persist status to `path`. The file is
    /// not touched until [`write_initial`](Self::write_initial) — or any
    /// mutator — is called.
    ///
    /// `max_concurrent` is the cap reported in the status file (not
    /// enforced here). `proxy_port` / `dns_port` are set-once
    /// initialization values captured from the MITM proxy and DNS
    /// resolver before the tracker is shared via `Arc`.
    pub fn new(
        path: PathBuf,
        max_concurrent: usize,
        proxy_port: Option<u16>,
        dns_port: Option<u16>,
    ) -> Self {
        Self {
            started_at: Utc::now(),
            max_concurrent,
            proxy_port,
            dns_port,
            path,
            state: Mutex::new(MutableState {
                generation: 0,
                mode: RunnerMode::Starting,
                active_runs: BTreeMap::new(),
                idle_snapshot: IdlePoolSnapshot::default(),
            }),
            persistence: Arc::new(PersistenceCoordinator::new()),
            #[cfg(any(test, feature = "test-support"))]
            write_gate: None,
            #[cfg(any(test, feature = "test-support"))]
            idle_info_update_requests: AtomicU64::new(0),
            #[cfg(any(test, feature = "test-support"))]
            idle_snapshot_waits: tokio::sync::watch::channel(0).0,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn new_with_write_gate(
        path: PathBuf,
        generation: u64,
        started: std::sync::Arc<tokio::sync::Notify>,
        release: std::sync::Arc<tokio::sync::Semaphore>,
    ) -> Self {
        let mut tracker = Self::new(path, 4, None, None);
        tracker.write_gate = Some(StatusWriteGate {
            generation,
            phase: StatusWriteGatePhase::BeforeWrite,
            started,
            release,
        });
        tracker
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn new_with_atomic_write_gate(
        path: PathBuf,
        generation: u64,
        started: std::sync::Arc<tokio::sync::Notify>,
        release: std::sync::Arc<tokio::sync::Semaphore>,
    ) -> Self {
        let mut tracker = Self::new(path, 4, None, None);
        tracker.write_gate = Some(StatusWriteGate {
            generation,
            phase: StatusWriteGatePhase::AtomicWrite,
            started,
            release,
        });
        tracker
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn idle_info_update_request_count(&self) -> u64 {
        self.idle_info_update_requests.load(Ordering::Relaxed)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn hold_state_for_test(&self) -> impl Drop + '_ {
        self.state.lock().await
    }

    /// Observe only a positively polled idle-snapshot state-lock wait.
    #[cfg(any(test, feature = "test-support"))]
    pub fn idle_snapshot_waits_for_test(&self) -> tokio::sync::watch::Receiver<u64> {
        self.idle_snapshot_waits.subscribe()
    }

    #[cfg(any(test, feature = "test-support"))]
    async fn lock_idle_snapshot_for_test(&self) -> tokio::sync::MutexGuard<'_, MutableState> {
        let lock = self.state.lock();
        tokio::pin!(lock);
        match futures_util::poll!(&mut lock) {
            std::task::Poll::Ready(state) => return state,
            std::task::Poll::Pending => self.idle_snapshot_waits.send_modify(|count| *count += 1),
        }
        lock.await
    }

    /// Transition the reported lifecycle mode and flush the status file.
    pub async fn set_mode(&self, mode: RunnerMode) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            state.mode = mode;
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    /// Register an active run as running and flush the status file.
    ///
    /// This preserves the old helper semantics for tests and cleanup fixtures.
    /// Freshly claimed new-sandbox jobs should use [`Self::add_preparing_run`].
    #[cfg(any(test, feature = "test-support"))]
    pub async fn add_run(&self, run_id: RunId, sandbox_id: SandboxId) -> StatusResult<()> {
        self.add_running_run(run_id, sandbox_id).await
    }

    /// Register an active run whose sandbox has not committed running ownership.
    /// Its Firecracker process may not exist yet or may still be parked.
    pub async fn add_preparing_run(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> StatusResult<()> {
        self.add_run_with_phase(run_id, sandbox_id, ActiveRunPhase::Preparing)
            .await
    }

    /// Register an active run whose Firecracker VM should already exist.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn add_running_run(&self, run_id: RunId, sandbox_id: SandboxId) -> StatusResult<()> {
        self.add_run_with_phase(run_id, sandbox_id, ActiveRunPhase::Running)
            .await
    }

    async fn add_run_with_phase(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        phase: ActiveRunPhase,
    ) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            state.active_runs.insert(
                run_id,
                ActiveRunState {
                    sandbox_id,
                    phase,
                    phase_started_at: Utc::now(),
                },
            );
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    /// Register a running active run and replace both parked inventories in the same
    /// status write if the idle snapshot is current.
    pub async fn add_running_run_with_idle_snapshot(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        idle_snapshot: IdlePoolSnapshot,
    ) -> StatusResult<bool> {
        self.add_run_with_idle_snapshot(run_id, sandbox_id, ActiveRunPhase::Running, idle_snapshot)
            .await
    }

    /// Register a preparing active run and replace both parked inventories in the
    /// same status write if the idle snapshot is current.
    pub async fn add_preparing_run_with_idle_snapshot(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        idle_snapshot: IdlePoolSnapshot,
    ) -> StatusResult<bool> {
        self.add_run_with_idle_snapshot(
            run_id,
            sandbox_id,
            ActiveRunPhase::Preparing,
            idle_snapshot,
        )
        .await
    }

    async fn add_run_with_idle_snapshot(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        phase: ActiveRunPhase,
        idle_snapshot: IdlePoolSnapshot,
    ) -> StatusResult<bool> {
        let (applied, snapshot) = {
            let mut state = self.state.lock().await;
            state.active_runs.insert(
                run_id,
                ActiveRunState {
                    sandbox_id,
                    phase,
                    phase_started_at: Utc::now(),
                },
            );
            let applied = apply_idle_snapshot(&mut state, idle_snapshot);
            let snapshot = self.capture_changed_snapshot(&mut state);
            (applied, snapshot)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(applied)
    }

    /// Transition a preparing active run to running only if it still points at
    /// the expected sandbox.
    pub async fn mark_run_running_if_matching(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> StatusResult<bool> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(current) = state.active_runs.get_mut(&run_id) else {
                return Ok(false);
            };
            if current.sandbox_id != sandbox_id {
                return Ok(false);
            }
            current.phase = ActiveRunPhase::Running;
            current.phase_started_at = Utc::now();
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Transfer a retired run resource to another physical sandbox while also
    /// publishing the inventory from which that replacement was reserved.
    pub async fn replace_run_sandbox_if_matching(
        &self,
        run_id: RunId,
        expected: SandboxId,
        replacement: SandboxId,
        idle_snapshot: IdlePoolSnapshot,
    ) -> StatusResult<bool> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(current) = state.active_runs.get_mut(&run_id) else {
                return Ok(false);
            };
            if current.sandbox_id != expected {
                return Ok(false);
            }
            current.sandbox_id = replacement;
            current.phase = ActiveRunPhase::Preparing;
            current.phase_started_at = Utc::now();
            apply_idle_snapshot(&mut state, idle_snapshot);
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Drop an active run only if it still points at the expected sandbox.
    ///
    /// Returns `false` if another task already removed the run or reused the
    /// `run_id` with a different sandbox.
    pub async fn remove_run_if_matching(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> StatusResult<bool> {
        let snapshot = {
            let mut state = self.state.lock().await;
            let removed = matches!(state.active_runs.get(&run_id), Some(current) if current.sandbox_id == sandbox_id);
            if !removed {
                None
            } else {
                state.active_runs.remove(&run_id);
                Some(self.capture_changed_snapshot(&mut state))
            }
        };
        let Some(snapshot) = snapshot else {
            self.retry_unpublished_snapshot().await?;
            return Ok(false);
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Request publication of the current whole status when requested state is
    /// newer than the latest successful publication.
    ///
    /// This retries the current in-memory snapshot, not necessarily the snapshot
    /// from an earlier unconfirmed publication attempt. It does not cancel a prior
    /// in-flight write, and this attempt can also return
    /// [`StatusPersistenceError::Timeout`] with an uncertain publication outcome.
    pub async fn retry_unpublished_snapshot(&self) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            if self
                .persistence
                .published_generation
                .load(Ordering::Acquire)
                >= state.generation
            {
                return Ok(());
            }
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    /// Replace both parked inventories only if the snapshot is at least as new as the
    /// last applied idle-pool mutation revision.
    ///
    /// Returns `false` when a stale async writer lost the race to a newer
    /// snapshot and was intentionally ignored.
    pub async fn set_idle_snapshot(&self, idle_snapshot: IdlePoolSnapshot) -> StatusResult<bool> {
        #[cfg(any(test, feature = "test-support"))]
        self.idle_info_update_requests
            .fetch_add(1, Ordering::Relaxed);
        let snapshot = {
            #[cfg(any(test, feature = "test-support"))]
            let mut state = self.lock_idle_snapshot_for_test().await;
            #[cfg(not(any(test, feature = "test-support")))]
            let mut state = self.state.lock().await;
            let applied = apply_idle_snapshot(&mut state, idle_snapshot);
            if !applied {
                return Ok(false);
            }
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await?;
        Ok(true)
    }

    /// Write the initial status file.
    pub async fn write_initial(&self) -> StatusResult<()> {
        let snapshot = {
            let mut state = self.state.lock().await;
            self.capture_changed_snapshot(&mut state)
        };
        self.persist_snapshot(snapshot).await
    }

    fn capture_changed_snapshot(&self, state: &mut MutableState) -> StatusSnapshot {
        state.generation += 1;
        let active_runs: Vec<ActiveRun> = state
            .active_runs
            .iter()
            .map(|(run_id, active)| ActiveRun {
                run_id: *run_id,
                sandbox_id: active.sandbox_id,
                phase: active.phase,
                phase_started_at: active.phase_started_at,
            })
            .collect();

        let status = RunnerStatus {
            mode: state.mode,
            max_concurrent: self.max_concurrent,
            active_runs,
            idle_sandboxes: state.idle_snapshot.idle_sandboxes.clone(),
            blank_sandboxes: state.idle_snapshot.blank_sandboxes.clone(),
            proxy_port: self.proxy_port,
            dns_port: self.dns_port,
            started_at: self.started_at,
            updated_at: Utc::now(),
        };

        StatusSnapshot {
            generation: state.generation,
            status,
        }
    }

    /// Publish an owned snapshot through same-directory atomic replacement.
    async fn persist_snapshot(&self, snapshot: StatusSnapshot) -> StatusResult<()> {
        let path = self.path.clone();
        let deadline = tokio::time::Instant::now() + STATUS_PERSISTENCE_TIMEOUT;
        let json = serde_json::to_string_pretty(&snapshot.status).map_err(|source| {
            StatusPersistenceError::Serialize {
                path: path.clone(),
                source,
            }
        })?;
        if tokio::time::Instant::now() >= deadline {
            return Err(StatusPersistenceError::Timeout {
                path,
                timeout: STATUS_PERSISTENCE_TIMEOUT,
            });
        }

        let persistence = Arc::clone(&self.persistence);
        let mut serialized = SerializedStatusSnapshot {
            generation: snapshot.generation,
            json,
        };
        let Some(ready) = persistence.defer_if_delayed(serialized) else {
            return Err(StatusPersistenceError::Timeout {
                path,
                timeout: STATUS_PERSISTENCE_TIMEOUT,
            });
        };
        serialized = ready;

        #[cfg(any(test, feature = "test-support"))]
        if let Some(gate) = &self.write_gate
            && gate.generation == serialized.generation
            && gate.phase == StatusWriteGatePhase::BeforeWrite
        {
            gate.started.notify_one();
            let wait_for_gate = async {
                let permit = gate
                    .release
                    .acquire()
                    .await
                    .expect("status write gate closed");
                permit.forget();
            };
            if tokio::time::timeout_at(deadline, wait_for_gate)
                .await
                .is_err()
            {
                return Err(StatusPersistenceError::Timeout {
                    path,
                    timeout: STATUS_PERSISTENCE_TIMEOUT,
                });
            }
        }

        let Some(ready) = persistence.defer_if_delayed(serialized) else {
            return Err(StatusPersistenceError::Timeout {
                path,
                timeout: STATUS_PERSISTENCE_TIMEOUT,
            });
        };
        serialized = ready;
        let ordering = Arc::clone(&persistence.ordering);
        let ordering = match tokio::time::timeout_at(deadline, ordering.lock_owned()).await {
            Ok(ordering) => ordering,
            Err(_) => {
                drop(persistence.defer_if_delayed(serialized));
                return Err(StatusPersistenceError::Timeout {
                    path,
                    timeout: STATUS_PERSISTENCE_TIMEOUT,
                });
            }
        };
        if persistence.published_generation.load(Ordering::Acquire) >= serialized.generation {
            return Ok(());
        }

        let generation = serialized.generation;
        let write_path = path.clone();
        #[cfg(any(test, feature = "test-support"))]
        let atomic_write_gate = self.write_gate.clone();
        let write: StatusWriteFuture = Box::pin(async move {
            #[cfg(any(test, feature = "test-support"))]
            if let Some(gate) = &atomic_write_gate
                && gate.generation == generation
                && gate.phase == StatusWriteGatePhase::AtomicWrite
            {
                gate.started.notify_one();
                let permit = gate
                    .release
                    .acquire()
                    .await
                    .expect("atomic status write gate closed");
                permit.forget();
            }
            runner_host::private_fs::write_private_file(&write_path, serialized.json.as_bytes())
                .await
                .map_err(|source| StatusPersistenceError::Write {
                    path: write_path,
                    source: source.into(),
                })
        });

        let mut in_flight =
            InFlightStatusWrite::new(write, ordering, persistence, path, generation);
        match tokio::time::timeout_at(deadline, in_flight.finish()).await {
            Ok(result) => result,
            Err(_) => Err(StatusPersistenceError::Timeout {
                path: self.path.clone(),
                timeout: STATUS_PERSISTENCE_TIMEOUT,
            }),
        }
    }
}

/// Remove a status file from a previous runner process, if present.
///
/// Called only after the new process owns the runner base-dir lock. This clears
/// stale live snapshots before startup has published this process's state.
pub async fn remove_stale_status_file(path: &Path) -> LifecycleResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(LifecycleError::Config(format!(
            "remove stale status file {}: {e}",
            path.display()
        ))),
    }
}

fn apply_idle_snapshot(state: &mut MutableState, snapshot: IdlePoolSnapshot) -> bool {
    if snapshot.revision < state.idle_snapshot.revision {
        return false;
    }
    state.idle_snapshot = snapshot;
    true
}

#[cfg(test)]
mod tests;
