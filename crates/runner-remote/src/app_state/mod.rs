//! Short-lived Mac uploads owned by the currently assigned sandbox.
mod receive;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use bytes::Bytes;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::HttpClient;
use runner_types::ids::RunId;
use sha2::{Digest, Sha256};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_BUNDLE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_LIFETIME: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct Runtime(Arc<Registry>);

struct Registry {
    http: HttpClient,
    token: Zeroizing<String>,
    identity: RunnerProcessIdentity,
    runs: Mutex<HashMap<RunId, Weak<Run>>>,
    uploads: Arc<Semaphore>,
}

impl Runtime {
    pub fn new(http: HttpClient, token: &str, identity: RunnerProcessIdentity) -> Self {
        Self(Arc::new(Registry {
            http,
            token: Zeroizing::new(token.to_owned()),
            identity,
            runs: Mutex::new(HashMap::new()),
            uploads: Arc::new(Semaphore::new(4)),
        }))
    }

    pub(crate) fn for_run(&self, id: RunId, cancel: CancellationToken) -> Arc<Run> {
        let run = Arc::new(Run {
            runtime: self.clone(),
            id,
            cancel,
            entries: Mutex::new(HashMap::new()),
            changed: watch::channel(()).0,
        });
        let mut runs = self.0.runs.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(old) = runs
            .insert(id, Arc::downgrade(&run))
            .and_then(|old| old.upgrade())
        {
            old.cancel.cancel();
        }
        run
    }

    pub fn run(&self, id: RunId) -> Option<Arc<Run>> {
        self.0
            .runs
            .lock()
            .ok()?
            .get(&id)?
            .upgrade()
            .filter(|r| !r.cancel.is_cancelled())
    }

    pub fn reserve_upload(&self) -> Option<OwnedSemaphorePermit> {
        self.0.uploads.clone().try_acquire_owned().ok()
    }

    pub fn expire(&self) {
        let mut runs = self.0.runs.lock().unwrap_or_else(|p| p.into_inner());
        runs.retain(|_, weak| {
            weak.upgrade().is_some_and(|run| {
                run.entries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .retain(|_, entry| entry.deadline > Instant::now());
                !run.cancel.is_cancelled()
            })
        });
    }
}

struct Upload {
    body: Bytes,
    _permit: OwnedSemaphorePermit,
}

struct Entry {
    host: Uuid,
    digest: [u8; 32],
    deadline: Instant,
    // After the guest acknowledges, keep only the receipt until the ticket expires.
    state: State,
}

enum State {
    Pending(Arc<Upload>),
    Received,
    Revoked,
}

pub struct Run {
    runtime: Runtime,
    id: RunId,
    cancel: CancellationToken,
    entries: Mutex<HashMap<Uuid, Entry>>,
    changed: watch::Sender<()>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    InvalidDigest,
    Expired,
    Busy,
    Conflict,
}

impl Run {
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await;
    }
    pub async fn deliver(
        &self,
        command: Uuid,
        host: Uuid,
        deadline: Instant,
        expected: [u8; 32],
        bytes: Bytes,
        permit: OwnedSemaphorePermit,
    ) -> Result<String, UploadError> {
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        if digest != expected {
            return Err(UploadError::InvalidDigest);
        }
        let mut changes = self.changed.subscribe();
        {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            if self.cancel.is_cancelled() || Instant::now() >= deadline {
                return Err(UploadError::Expired);
            }
            if let Some(existing) = entries.get(&command) {
                if existing.host != host || existing.digest != digest {
                    return Err(UploadError::Conflict);
                }
            } else {
                if entries.len() >= 128 {
                    return Err(UploadError::Busy);
                }
                entries.insert(
                    command,
                    Entry {
                        host,
                        digest,
                        deadline,
                        state: State::Pending(Arc::new(Upload {
                            body: bytes,
                            _permit: permit,
                        })),
                    },
                );
                self.changed.send_replace(());
            }
        }
        loop {
            if self.cancel.is_cancelled() || Instant::now() >= deadline {
                return Err(UploadError::Expired);
            }
            match self
                .entries
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&command)
                .map(|e| &e.state)
            {
                Some(State::Received) => return Ok(hex::encode(digest)),
                None | Some(State::Revoked) => return Err(UploadError::Expired),
                Some(State::Pending(_)) => {}
            }
            tokio::select! {
                biased;
                () = self.cancel.cancelled() => return Err(UploadError::Expired),
                () = tokio::time::sleep_until(deadline) => return Err(UploadError::Expired),
                _ = changes.changed() => {}
            }
        }
    }
}
