//! Fixed physical filesystem execution, separate from every peer's async router.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod listing;
#[cfg(target_os = "linux")]
mod reading;
#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, Weak, mpsc},
    time::{Duration, Instant},
};

use api_contracts::generated::constants::sandbox_channel as limits;
use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    Categories, Diagnostics, Error, Notice, Operation, Params, Peer, Service, ServiceFuture,
};

const QUEUED_JOBS: usize = 8;
// Eight live streams plus the one active/eight queued jobs of retired streams.
const RETAINED_OWNERS: usize = 8 + 1 + QUEUED_JOBS;
const MAINTENANCE_WAIT: Duration = Duration::from_millis(100);

/// One filesystem thread for the whole Guest. Construct only after fork.
/// Dropping the last sender lets it drain obsolete jobs and exit. A synchronous
/// kernel operation cannot be forcibly interrupted or synchronously joined.
#[derive(Clone)]
pub struct Filesystem {
    queue: mpsc::SyncSender<Job>,
    bytes: Arc<Semaphore>,
    owners: Arc<Semaphore>,
    root: PathBuf,
}

struct Owner {
    cancelled: CancellationToken,
    peer: Mutex<Option<CancellationToken>>,
    reads: Arc<Semaphore>,
    #[cfg(target_os = "linux")]
    state: Mutex<Option<listing::State>>,
    _permit: OwnedSemaphorePermit,
    #[cfg(test)]
    hooks: Mutex<Hooks>,
}

#[cfg(test)]
#[derive(Default)]
struct Hooks {
    before_job: Option<Box<dyn FnOnce() + Send>>,
    after_read: Option<Box<dyn FnOnce() + Send>>,
    after_file_pin: Option<Box<dyn FnOnce() + Send>>,
    after_job: Option<Box<dyn FnOnce() + Send>>,
    after_maintenance: Option<Box<dyn FnOnce() + Send>>,
}

impl Owner {
    fn closed(&self) -> bool {
        self.cancelled.is_cancelled()
            || self.peer.lock().map_or(true, |peer| {
                peer.as_ref().is_some_and(CancellationToken::is_cancelled)
            })
    }
}

struct GuestFiles {
    filesystem: Filesystem,
    owner: Option<Arc<Owner>>,
}

impl Drop for GuestFiles {
    fn drop(&mut self) {
        if let Some(owner) = &self.owner {
            owner.cancelled.cancel();
        }
    }
}

struct Job {
    owner: Arc<Owner>,
    root: PathBuf,
    params: Params,
    result: oneshot::Sender<Result<Value, Error>>,
    _bytes: OwnedSemaphorePermit,
    _read: Option<OwnedSemaphorePermit>,
}

pub(super) struct Scope<'a> {
    job: &'a Job,
    deadline: Instant,
    steps: usize,
}

impl Scope<'_> {
    #[cfg(test)]
    fn hook(&self, read: bool) {
        let action = {
            let mut hooks = self.job.owner.hooks.lock().unwrap();
            if read {
                hooks.after_read.take()
            } else {
                hooks.before_job.take()
            }
        };
        if let Some(action) = action {
            action();
        }
    }
    fn live(&self) -> Result<(), Error> {
        if self.job.owner.closed() || self.job.result.is_closed() {
            Err(Error::Unavailable)
        } else if Instant::now() >= self.deadline {
            Err(Error::TimedOut)
        } else {
            Ok(())
        }
    }

    pub(super) fn step(&mut self) -> Result<(), Error> {
        self.live()?;
        if self.steps >= limits::fs::MAX_ENUMERATION_STEPS as usize {
            return Err(Error::Unavailable);
        }
        self.steps += 1;
        Ok(())
    }

    pub(super) fn can_enumerate(&self, reserved: usize) -> bool {
        self.live().is_ok()
            && self.steps + reserved + 3 <= limits::fs::MAX_ENUMERATION_STEPS as usize
    }
}

impl Filesystem {
    /// fs v3 captures Guest /; neither process HOME nor cwd is used.
    pub fn new() -> std::io::Result<Self> {
        Self::start(PathBuf::from("/"))
    }

    fn start(root: PathBuf) -> std::io::Result<Self> {
        let (queue, receiver) = mpsc::sync_channel(QUEUED_JOBS);
        std::thread::Builder::new()
            .name("gdup-filesystem".into())
            .spawn(move || worker(receiver))?;
        Ok(Self {
            queue,
            bytes: Arc::new(Semaphore::new(limits::MAX_QUEUED_BYTES as usize)),
            owners: Arc::new(Semaphore::new(RETAINED_OWNERS)),
            root,
        })
    }

    /// A new complete role instance for exactly one connection, never shared
    /// across epochs. Finite owner pressure rejects fs calls while diagnostics
    /// remains available; it cannot create an unbounded retired-owner registry.
    pub fn service(&self) -> Arc<dyn Service> {
        let owner = Arc::clone(&self.owners)
            .try_acquire_owned()
            .ok()
            .map(|permit| {
                Arc::new(Owner {
                    cancelled: CancellationToken::new(),
                    peer: Mutex::new(None),
                    reads: Arc::new(Semaphore::new(limits::fs::MAX_IN_FLIGHT_READS as usize)),
                    #[cfg(target_os = "linux")]
                    state: Mutex::new(None),
                    _permit: permit,
                    #[cfg(test)]
                    hooks: Mutex::new(Hooks::default()),
                })
            });
        Arc::new(GuestFiles {
            filesystem: self.clone(),
            owner,
        })
    }

    fn enqueue(
        &self,
        owner: Arc<Owner>,
        params: Params,
    ) -> Result<oneshot::Receiver<Result<Value, Error>>, Error> {
        if owner.closed() {
            return Err(Error::Unavailable);
        }
        let encoded = match &params {
            Params::FsList(value) => serde_json::to_vec(value),
            Params::FsListClose(value) => serde_json::to_vec(value),
            Params::FsOpen(value) => serde_json::to_vec(value),
            Params::FsRead(value) => serde_json::to_vec(value),
            Params::FsFinish(value) | Params::FsClose(value) => serde_json::to_vec(value),
            _ => return Err(Error::Unavailable),
        }
        .map_err(|_| Error::Unavailable)?;
        let count = u32::try_from(encoded.len()).map_err(|_| Error::Busy)?;
        let bytes = Arc::clone(&self.bytes)
            .try_acquire_many_owned(count)
            .map_err(|_| Error::Busy)?;
        let (result, receiver) = oneshot::channel();
        let read = if matches!(params, Params::FsRead(_)) {
            Some(
                Arc::clone(&owner.reads)
                    .try_acquire_owned()
                    .map_err(|_| Error::Busy)?,
            )
        } else {
            None
        };
        self.queue
            .try_send(Job {
                owner,
                root: self.root.clone(),
                params,
                result,
                _bytes: bytes,
                _read: read,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Unavailable,
            })?;
        Ok(receiver)
    }
}

impl Service for GuestFiles {
    fn categories(&self) -> Categories {
        let mut categories = Diagnostics.categories();
        categories.insert("fs".into(), u64::from(limits::fs::VERSION));
        categories
    }

    fn request(&self, operation: Operation, params: Params, peer: Peer) -> ServiceFuture<Value> {
        if !matches!(
            operation,
            Operation::FsList
                | Operation::FsListClose
                | Operation::FsOpen
                | Operation::FsRead
                | Operation::FsFinish
                | Operation::FsClose
        ) {
            return Diagnostics.request(operation, params, peer);
        }
        let filesystem = self.filesystem.clone();
        let owner = self.owner.clone();
        Box::pin(async move {
            let owner = owner.ok_or(Error::Busy)?;
            let value = match params {
                Params::FsList(value) => serde_json::to_value(value),
                Params::FsListClose(value) => serde_json::to_value(value),
                Params::FsOpen(value) => serde_json::to_value(value),
                Params::FsRead(value) => serde_json::to_value(value),
                Params::FsFinish(value) | Params::FsClose(value) => serde_json::to_value(value),
                _ => return Err(Error::Unavailable),
            }
            .map_err(|_| Error::Unavailable)?;
            let params = guest_contracts::sandbox_channel::decode_params(operation, value)?;
            {
                let mut bound = owner.peer.lock().map_err(|_| Error::Unavailable)?;
                if bound.is_none() {
                    *bound = Some(peer.cancellation());
                }
            }
            let result = filesystem.enqueue(owner, params)?;
            tokio::select! {
                _ = peer.cancellation().cancelled_owned() => Err(Error::Unavailable),
                result = result => result.unwrap_or(Err(Error::Unavailable)),
            }
        })
    }

    fn notice(&self, notice: Notice, peer: Peer) -> ServiceFuture<()> {
        Diagnostics.notice(notice, peer)
    }
}

fn worker(receiver: mpsc::Receiver<Job>) {
    let mut owners: Vec<Weak<Owner>> = Vec::with_capacity(RETAINED_OWNERS);
    loop {
        owners.retain(|weak| {
            let Some(owner) = weak.upgrade() else {
                return false;
            };
            // Cleanup and registry removal must use the same cancellation snapshot.
            let closed = owner.closed();
            #[cfg(target_os = "linux")]
            if let Ok(mut state) = owner.state.lock() {
                if closed {
                    *state = None;
                } else if let Some(state) = state.as_mut() {
                    state.expire(Instant::now());
                }
            }
            #[cfg(test)]
            {
                let action = owner.hooks.lock().unwrap().after_maintenance.take();
                if let Some(action) = action {
                    action();
                }
            }
            !closed
        });
        let job = match receiver.recv_timeout(MAINTENANCE_WAIT) {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        if job.owner.closed() || job.result.is_closed() {
            continue;
        }
        let weak = Arc::downgrade(&job.owner);
        if !owners.iter().any(|owner| owner.ptr_eq(&weak)) {
            owners.push(weak);
        }
        let outcome = execute(&job);
        #[cfg(test)]
        {
            let hook = job.owner.hooks.lock().unwrap().after_job.take();
            if let Some(hook) = hook {
                hook();
            }
        }
        #[cfg(target_os = "linux")]
        let abandoned = if matches!(job.params, Params::FsOpen(_)) {
            outcome
                .as_ref()
                .ok()
                .and_then(|value| value.get("handle"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        };
        if job.result.send(outcome).is_err() {
            #[cfg(target_os = "linux")]
            if let Some(handle) = abandoned
                && let Ok(mut state) = job.owner.state.lock()
                && let Some(state) = state.as_mut()
            {
                state.readers.handles.remove(&handle);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn execute(job: &Job) -> Result<Value, Error> {
    // The worker is the only physical reader. No syscall occurs under this lock.
    let mut state = job
        .owner
        .state
        .lock()
        .map_err(|_| Error::Unavailable)?
        .take();
    let mut scope = Scope {
        job,
        deadline: Instant::now()
            + Duration::from_millis(u64::from(limits::fs::PROCESSING_BUDGET_MS)),
        steps: 0,
    };
    let outcome = (|| {
        #[cfg(test)]
        scope.hook(false);
        scope.live()?;
        if state.is_none() {
            state = Some(listing::State::capture(&job.root, &mut scope)?);
        }
        state
            .as_mut()
            .ok_or(Error::Unavailable)?
            .execute(&job.params, &mut scope)
    })();
    if !job.owner.closed() {
        *job.owner.state.lock().map_err(|_| Error::Unavailable)? = state;
    }
    outcome
}

#[cfg(not(target_os = "linux"))]
fn execute(_job: &Job) -> Result<Value, Error> {
    Err(Error::Unavailable)
}
