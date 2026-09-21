use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::Notify;
use tracing::warn;

#[derive(Default)]
pub(super) struct NetworkLogState {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    source_paths: HashMap<String, SourceState>,
    pending_paths: HashMap<Arc<Path>, PathState>,
    next_generation: u64,
}

enum SourceState {
    Active {
        path: Arc<Path>,
        generation: u64,
        writer_backpressure_observed: bool,
        writer_failed: Arc<AtomicBool>,
    },
    Draining {
        path: Arc<Path>,
        generation: u64,
        writer_backpressure_observed: bool,
        writer_failed: Arc<AtomicBool>,
    },
}

impl SourceState {
    fn writer_failed(&self) -> &Arc<AtomicBool> {
        match self {
            Self::Active { writer_failed, .. } | Self::Draining { writer_failed, .. } => {
                writer_failed
            }
        }
    }

    fn path(&self) -> &Arc<Path> {
        match self {
            Self::Active { path, .. } | Self::Draining { path, .. } => path,
        }
    }

    fn generation(&self) -> u64 {
        match self {
            Self::Active { generation, .. } | Self::Draining { generation, .. } => *generation,
        }
    }

    fn matches(&self, path: &Path, generation: u64) -> bool {
        self.generation() == generation && self.path().as_ref() == path
    }

    fn writer_backpressure_observed(&self) -> bool {
        match self {
            Self::Active {
                writer_backpressure_observed,
                ..
            }
            | Self::Draining {
                writer_backpressure_observed,
                ..
            } => *writer_backpressure_observed,
        }
    }
}

struct PathState {
    pending: usize,
    notify: Arc<Notify>,
}

impl PathState {
    fn new() -> Self {
        Self {
            pending: 0,
            notify: Arc::new(Notify::new()),
        }
    }
}

pub(super) struct SourceRegistration {
    pub(super) source_ip: String,
    pub(super) path: Arc<Path>,
    pub(super) generation: u64,
    pub(super) writer_failed: Arc<AtomicBool>,
}

pub(super) struct SourceSnapshot {
    pub(super) path: Arc<Path>,
    generation: u64,
    writer_failed: Arc<AtomicBool>,
}

pub(super) struct AcceptedAppend {
    path: Arc<Path>,
    line: String,
    completion: PendingWriteCompletion,
}

impl AcceptedAppend {
    pub(super) fn line_len(&self) -> usize {
        self.line.len()
    }

    pub(super) fn into_parts(self) -> (Arc<Path>, String, PendingWriteCompletion) {
        (self.path, self.line, self.completion)
    }
}

/// Follows an accepted row through the queue and into the blocking append.
/// Drop records failure, never successful persistence.
pub(super) struct PendingWriteCompletion {
    state: Weak<NetworkLogState>,
    path: Arc<Path>,
    writer_failed: Arc<AtomicBool>,
    settled: bool,
}

impl PendingWriteCompletion {
    /// Preserve one accounting lock per normal path batch.
    pub(super) fn complete_batch(mut completions: Vec<Self>, success: bool) {
        let Some(first) = completions.first() else {
            return;
        };
        let state = first.state.upgrade();
        let path = Arc::clone(&first.path);
        let count = completions.len();
        for completion in &mut completions {
            if !success {
                completion.writer_failed.store(true, Ordering::Release);
            }
            completion.settled = true;
        }
        if let Some(state) = state {
            state.complete_path(path, count);
        }
    }
}

impl Drop for PendingWriteCompletion {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        if !self.writer_failed.swap(true, Ordering::AcqRel) {
            warn!(path = %self.path.display(), "accepted network log write abandoned by its owner");
        }
        if let Some(state) = self.state.upgrade() {
            state.complete_path(Arc::clone(&self.path), 1);
        }
    }
}

impl NetworkLogState {
    // Registry/accounting only: no I/O, await or nested work under this lock.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn register_source_ip(
        &self,
        source_ip: String,
        path: PathBuf,
    ) -> SourceRegistration {
        let mut state = self.lock();
        state.next_generation += 1;
        let generation = state.next_generation;
        let path: Arc<Path> = path.into();
        let writer_failed = Arc::new(AtomicBool::new(false));
        state.source_paths.insert(
            source_ip.clone(),
            SourceState::Active {
                path: Arc::clone(&path),
                generation,
                writer_backpressure_observed: false,
                writer_failed: Arc::clone(&writer_failed),
            },
        );
        SourceRegistration {
            source_ip,
            path,
            generation,
            writer_failed,
        }
    }

    runner_test_support!(network; #[cfg(test)]
    pub(super) fn unregister_source_ip(&self, source_ip: &str) {
        let mut state = self.lock();
        state.source_paths.remove(source_ip);
    });

    runner_test_support!(network; #[cfg(test)]
    pub(super) fn source_ip_registered(&self, source_ip: &str) -> bool {
        self.lock().source_paths.contains_key(source_ip)
    });

    runner_test_support!(network; #[cfg(test)]
    pub(super) fn source_and_pending_path_share_identity(
        &self,
        source_ip: &str,
        path: &Path,
    ) -> bool {
        let state = self.lock();
        let Some(source) = state.source_paths.get(source_ip) else {
            return false;
        };
        let Some((pending_path, _)) = state.pending_paths.get_key_value(path) else {
            return false;
        };
        Arc::ptr_eq(source.path(), pending_path)
    });

    pub(super) fn source_snapshot(&self, source_ip: &str) -> Option<SourceSnapshot> {
        let state = self.lock();
        state
            .source_paths
            .get(source_ip)
            .map(|source| SourceSnapshot {
                path: Arc::clone(source.path()),
                generation: source.generation(),
                writer_failed: Arc::clone(source.writer_failed()),
            })
    }

    pub(super) fn try_accept_snapshot(
        self: &Arc<Self>,
        source_ip: &str,
        snapshot: &SourceSnapshot,
        line: String,
    ) -> Option<AcceptedAppend> {
        let mut state = self.lock();
        let source_state = state.source_paths.get(source_ip)?;
        if !source_state.matches(snapshot.path.as_ref(), snapshot.generation) {
            return None;
        }
        let path_state = state
            .pending_paths
            .entry(Arc::clone(&snapshot.path))
            .or_insert_with(PathState::new);
        path_state.pending += 1;
        Some(AcceptedAppend {
            path: Arc::clone(&snapshot.path),
            line,
            completion: PendingWriteCompletion {
                state: Arc::downgrade(self),
                path: Arc::clone(&snapshot.path),
                writer_failed: Arc::clone(&snapshot.writer_failed),
                settled: false,
            },
        })
    }

    pub(super) fn mark_writer_backpressure(&self, source_ip: &str, snapshot: &SourceSnapshot) {
        let mut state = self.lock();
        let Some(source_state) = state.source_paths.get_mut(source_ip) else {
            return;
        };
        if !source_state.matches(snapshot.path.as_ref(), snapshot.generation) {
            return;
        }
        match source_state {
            SourceState::Active {
                writer_backpressure_observed,
                ..
            }
            | SourceState::Draining {
                writer_backpressure_observed,
                ..
            } => *writer_backpressure_observed = true,
        }
    }

    pub(super) fn begin_session_drain(
        &self,
        source_ip: &str,
        path: &Path,
        generation: u64,
    ) -> bool {
        let mut state = self.lock();
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return false;
        };
        if !source_state.matches(path, generation) {
            return false;
        }
        let path = Arc::clone(source_state.path());
        let writer_backpressure_observed = source_state.writer_backpressure_observed();
        let writer_failed = Arc::clone(source_state.writer_failed());
        state.source_paths.insert(
            source_ip.to_string(),
            SourceState::Draining {
                path,
                generation,
                writer_backpressure_observed,
                writer_failed,
            },
        );
        true
    }

    pub(super) fn finalize_session(&self, source_ip: &str, path: &Path, generation: u64) -> bool {
        let mut state = self.lock();
        let Some(source_state) = state.source_paths.get(source_ip) else {
            return false;
        };
        if !source_state.matches(path, generation) {
            return false;
        }
        let writer_backpressure_observed = source_state.writer_backpressure_observed();
        state.source_paths.remove(source_ip);
        writer_backpressure_observed
    }

    pub(super) async fn flush_path(&self, path: &Path) {
        loop {
            let notified = {
                let state = self.lock();
                let Some(path_state) = state.pending_paths.get(path) else {
                    return;
                };
                path_state.notify.clone().notified_owned()
            };

            tokio::pin!(notified);
            // Register before rechecking pending state so a concurrent final
            // completion cannot notify between the check and the await.
            notified.as_mut().enable();

            {
                let state = self.lock();
                if !state.pending_paths.contains_key(path) {
                    return;
                }
            }

            notified.as_mut().await;
        }
    }

    fn complete_path(&self, path: Arc<Path>, count: usize) {
        if count == 0 {
            return;
        }
        let notify = {
            let mut state = self.lock();
            let Some(path_state) = state.pending_paths.get_mut(path.as_ref()) else {
                warn!(path = %path.display(), "network log write completed for unknown path");
                return;
            };

            if path_state.pending < count {
                warn!(
                    path = %path.display(),
                    pending = path_state.pending,
                    completed = count,
                    "network log pending count below completed count"
                );
                path_state.pending = 0;
            } else {
                path_state.pending -= count;
            }

            if path_state.pending == 0 {
                state
                    .pending_paths
                    .remove(path.as_ref())
                    .map(|state| state.notify)
            } else {
                None
            }
        };

        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }
}
