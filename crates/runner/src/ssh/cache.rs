//! Run-owned authority snapshots. Notifications evict; they never grant authority.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{OnceCell, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use super::{FailureReason, authority::PreparedCredential};
use crate::ids::RunId;

const CAPACITY: usize = 256;

#[derive(Clone)]
pub(super) struct Cache {
    state: Arc<Mutex<State>>,
    capacity: Arc<Semaphore>,
}

#[derive(Default)]
struct State {
    connected: bool,
    runs: HashMap<RunId, RunEntries>,
}

struct RunEntries {
    identity: Arc<()>,
    entries: HashMap<uuid::Uuid, Arc<Entry>>,
    sessions: Vec<(uuid::Uuid, Weak<Entry>)>,
}

struct Entry {
    value: OnceCell<Arc<PreparedCredential>>,
    cancelled: CancellationToken,
    // Retain the slot even when eviction leaves an in-flight reader owning the entry.
    _slot: Option<OwnedSemaphorePermit>,
}

impl RunEntries {
    fn invalidate(&mut self, connection: Option<uuid::Uuid>) {
        self.sessions.retain(|(id, weak)| {
            let Some(entry) = weak.upgrade() else {
                return false;
            };
            if connection.is_none_or(|connection| connection == *id) {
                entry.cancelled.cancel();
                false
            } else {
                true
            }
        });
        if let Some(connection) = connection {
            if let Some(entry) = self.entries.remove(&connection) {
                entry.cancelled.cancel();
            }
        } else {
            for (_, entry) in self.entries.drain() {
                entry.cancelled.cancel();
            }
        }
    }
}

impl Drop for RunEntries {
    fn drop(&mut self) {
        self.invalidate(None);
    }
}

pub(super) struct Registration {
    cache: Cache,
    run: RunId,
    identity: Arc<()>,
}

#[derive(Clone)]
pub(super) struct Access {
    registration: Arc<Registration>,
    connection: uuid::Uuid,
    entry: Arc<Entry>,
    cached: bool,
}

impl Cache {
    pub(super) fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            capacity: Arc::new(Semaphore::new(CAPACITY)),
        }
    }

    pub(super) fn register(&self, run: RunId) -> Arc<Registration> {
        let identity = Arc::new(());
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .runs
            .insert(
                run,
                RunEntries {
                    identity: Arc::clone(&identity),
                    entries: HashMap::new(),
                    sessions: Vec::new(),
                },
            );
        Arc::new(Registration {
            cache: self.clone(),
            run,
            identity,
        })
    }

    pub(super) fn connected(&self, connected: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.connected = connected;
        if !connected {
            for run in state.runs.values_mut() {
                run.invalidate(None);
            }
        }
    }

    pub(super) fn invalidate(&self, run: RunId, connection: Option<uuid::Uuid>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(run) = state.runs.get_mut(&run) else {
            return;
        };
        run.invalidate(connection);
    }
}

impl Registration {
    pub(super) fn lookup(
        self: &Arc<Self>,
        connection: uuid::Uuid,
    ) -> Result<Access, FailureReason> {
        let mut state = self
            .cache
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let connected = state.connected;
        let run = state
            .runs
            .get_mut(&self.run)
            .filter(|run| Arc::ptr_eq(&run.identity, &self.identity))
            .ok_or(FailureReason::Cancelled)?;
        let entry = if connected {
            if let Some(entry) = run.entries.get(&connection) {
                Some(Arc::clone(entry))
            } else if let Ok(slot) = Arc::clone(&self.cache.capacity).try_acquire_owned() {
                let entry = Arc::new(Entry {
                    value: OnceCell::new(),
                    cancelled: CancellationToken::new(),
                    _slot: Some(slot),
                });
                run.entries.insert(connection, Arc::clone(&entry));
                Some(entry)
            } else {
                None
            }
        } else {
            None
        };
        let cached = entry.is_some();
        Ok(Access {
            registration: Arc::clone(self),
            connection,
            entry: entry.unwrap_or_else(|| {
                Arc::new(Entry {
                    value: OnceCell::new(),
                    cancelled: CancellationToken::new(),
                    _slot: None,
                })
            }),
            cached,
        })
    }

    /// Retained sessions require notification-backed authority, unlike one-shot exec.
    pub(super) fn session_access(
        self: &Arc<Self>,
        connection: uuid::Uuid,
    ) -> Result<Access, FailureReason> {
        let access = self.lookup(connection)?;
        if !access.retain()? {
            return Err(FailureReason::Unavailable);
        }
        Ok(access)
    }

    pub(super) fn close(&self) {
        let mut state = self
            .cache
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state
            .runs
            .get(&self.run)
            .is_some_and(|run| Arc::ptr_eq(&run.identity, &self.identity))
        {
            state.runs.remove(&self.run);
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.close();
    }
}

impl Access {
    /// Register retained authority before resolving credentials, including cache misses.
    /// Disconnected one-shot requests still resolve afresh and retain no transport.
    pub(super) fn retain(&self) -> Result<bool, FailureReason> {
        let mut state = self
            .registration
            .cache
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if !state.connected {
            return Ok(false);
        }
        let run = state
            .runs
            .get_mut(&self.registration.run)
            .filter(|run| Arc::ptr_eq(&run.identity, &self.registration.identity))
            .ok_or(FailureReason::Cancelled)?;
        if self.entry.cancelled.is_cancelled()
            || (self.cached
                && !run
                    .entries
                    .get(&self.connection)
                    .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry)))
        {
            return Err(FailureReason::ConfigurationChanged);
        }
        if !self.cached {
            // Weak watchers own no credentials; live operations and idle transports bound them.
            run.sessions.retain(|(_, entry)| entry.strong_count() > 0);
            if !run
                .sessions
                .iter()
                .any(|(_, entry)| entry.ptr_eq(&Arc::downgrade(&self.entry)))
            {
                run.sessions
                    .push((self.connection, Arc::downgrade(&self.entry)));
            }
        }
        Ok(true)
    }

    pub(super) fn cancelled(&self) -> CancellationToken {
        self.entry.cancelled.clone()
    }

    /// A failed asynchronous start must remain inspectable through its record.
    /// Do not retire its notification entry solely because this fill failed;
    /// no failed value is cached, and every fill still checks current authority.
    pub(super) async fn prepare_session(
        &self,
        prepare: impl Future<Output = Result<PreparedCredential, FailureReason>>,
    ) -> Result<Arc<PreparedCredential>, FailureReason> {
        let value = self
            .entry
            .value
            .get_or_try_init(|| async {
                self.check()?;
                prepare.await.map(Arc::new)
            })
            .await?;
        self.check()?;
        Ok(Arc::clone(value))
    }

    pub(super) async fn prepare(
        &self,
        prepare: impl Future<Output = Result<PreparedCredential, FailureReason>>,
    ) -> Result<Arc<PreparedCredential>, FailureReason> {
        let value = self
            .entry
            .value
            .get_or_try_init(|| async {
                self.check()?;
                match prepare.await {
                    Ok(value) => Ok(Arc::new(value)),
                    Err(failure) => {
                        // Retire this failed fill before waking another initializer.
                        self.invalidate();
                        Err(failure)
                    }
                }
            })
            .await?;
        self.check()?;
        Ok(Arc::clone(value))
    }

    pub(super) fn check(&self) -> Result<(), FailureReason> {
        let state = self
            .registration
            .cache
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let run = state
            .runs
            .get(&self.registration.run)
            .filter(|run| Arc::ptr_eq(&run.identity, &self.registration.identity))
            .ok_or(FailureReason::Cancelled)?;
        if self.entry.cancelled.is_cancelled() {
            return Err(FailureReason::ConfigurationChanged);
        }
        if self.cached
            && !run
                .entries
                .get(&self.connection)
                .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
        {
            return Err(FailureReason::ConfigurationChanged);
        }
        Ok(())
    }

    pub(super) fn invalidate(&self) {
        if !self.cached {
            return;
        }
        let mut state = self
            .registration
            .cache
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(run) = state
            .runs
            .get_mut(&self.registration.run)
            .filter(|run| Arc::ptr_eq(&run.identity, &self.registration.identity))
        else {
            return;
        };
        if run
            .entries
            .get(&self.connection)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
        {
            run.invalidate(Some(self.connection));
        }
    }
}
