//! Delivery-window deduplication. A lost response or expired history never
//! releases accepted execution. Senders retain the original immutable deadline.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::decode_execution_publication;
use runner_types::{ids::RunId, types::ExecutionContext};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};

pub(super) const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_VALIDITY_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Disposition {
    /// This HTTP attempt acquired no custody. Says nothing about an earlier attempt.
    Busy,
    Pending,
    Accepted,
    Rejected,
    Unknown,
    Conflict,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    runner_id: uuid::Uuid,
    heartbeat_generation: u64,
    profile: String,
    not_after: u64,
    execution_context: Box<serde_json::value::RawValue>,
}

struct Record {
    digest: [u8; 32],
    not_after: u64,
    verdict: watch::Sender<Disposition>,
}

pub(crate) struct DispatchIntake {
    records: Mutex<HashMap<RunId, Record>>,
    sender: mpsc::Sender<DispatchWork>,
    slots: Arc<Semaphore>,
    latest_time_ms: AtomicU64,
}

pub(crate) struct DispatchWork {
    pub context: Option<ExecutionContext>,
    pub profile: String,
    pub deadline: tokio::time::Instant,
    pub permit: Option<OwnedSemaphorePermit>,
    verdict: watch::Sender<Disposition>,
}

impl DispatchWork {
    pub fn settle(&self, verdict: Disposition) {
        self.verdict.send_if_modified(|current| {
            if *current != Disposition::Pending {
                return false;
            }
            *current = verdict;
            true
        });
    }
}

impl Drop for DispatchWork {
    fn drop(&mut self) {
        // Unexpected owner loss/panic is not evidence that no work executed.
        self.settle(Disposition::Unknown);
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

impl DispatchIntake {
    pub fn new(slots: Arc<Semaphore>) -> (Self, mpsc::Receiver<DispatchWork>) {
        // Constructed before intake is enabled, with the fresh shared transaction slots.
        let (sender, receiver) = mpsc::channel(slots.available_permits());
        (
            Self {
                records: Mutex::new(HashMap::new()),
                sender,
                slots,
                latest_time_ms: AtomicU64::new(0),
            },
            receiver,
        )
    }

    pub(super) fn try_reserve(&self) -> Option<OwnedSemaphorePermit> {
        self.slots.clone().try_acquire_owned().ok()
    }

    fn observe_time(&self, now: u64) -> u64 {
        // Once history expires, a stale timestamp or clock rollback must not
        // make that original request admissible again.
        self.latest_time_ms
            .fetch_max(now, Ordering::Relaxed)
            .max(now)
    }

    pub(super) fn expire(&self, now: u64) {
        if now == u64::MAX {
            // An invalid wall-clock sample must not erase or poison history.
            return;
        }
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let now = self.observe_time(now);
        records.retain(|_, record| record.not_after > now);
    }

    pub(super) async fn submit(
        &self,
        identity: RunnerProcessIdentity,
        run_id: RunId,
        bytes: &[u8],
        permit: OwnedSemaphorePermit,
        received_at_ms: u64,
    ) -> Disposition {
        if received_at_ms == u64::MAX {
            return Disposition::Unknown;
        }
        let received_at = tokio::time::Instant::now();
        let now = self.observe_time(received_at_ms);
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        let receiver = {
            let records = self.records.lock().unwrap_or_else(|e| e.into_inner());
            records.get(&run_id).map(|record| {
                if record.not_after <= now {
                    Err(Disposition::Unknown)
                } else if record.digest == digest {
                    Ok(record.verdict.subscribe())
                } else {
                    Err(Disposition::Conflict)
                }
            })
        };
        if let Some(receiver) = receiver {
            drop(permit);
            return match receiver {
                Ok(receiver) => observe(receiver).await,
                Err(verdict) => verdict,
            };
        }
        let envelope: Envelope = match serde_json::from_slice(bytes) {
            Ok(envelope) => envelope,
            Err(_) => return Disposition::Unknown,
        };
        if envelope.runner_id != identity.runner_id()
            || envelope.heartbeat_generation != identity.heartbeat_generation()
        {
            return Disposition::Unknown;
        }
        if envelope.not_after <= now || envelope.not_after > now.saturating_add(MAX_VALIDITY_MS) {
            return Disposition::Unknown;
        }
        // Freeze the remaining validity on a monotonic clock before decoding or
        // waiting for local resources. Wall-clock adjustment must not extend it.
        let deadline = received_at + std::time::Duration::from_millis(envelope.not_after - now);
        let context =
            match decode_execution_publication(envelope.execution_context.get().as_bytes()) {
                Ok(context) if context.run_id == run_id && !context.sandbox_token.is_empty() => {
                    context
                }
                _ => return Disposition::Unknown,
            };
        let mut context = Some(context);
        let mut permit = Some(permit);
        let mut to_submit = None;
        let receiver = {
            let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
            let now = self.observe_time(received_at_ms);
            if envelope.not_after <= now || tokio::time::Instant::now() >= deadline {
                return Disposition::Unknown;
            }
            // A concurrent request may have installed its record during decoding.
            if let Some(record) = records.get(&run_id) {
                if record.not_after <= now {
                    return Disposition::Unknown;
                }
                if record.digest != digest {
                    return Disposition::Conflict;
                }
                record.verdict.subscribe()
            } else {
                let (verdict, receiver) = watch::channel(Disposition::Pending);
                to_submit = Some(DispatchWork {
                    context: context.take(),
                    profile: envelope.profile,
                    deadline,
                    permit: permit.take(),
                    verdict: verdict.clone(),
                });
                records.insert(
                    run_id,
                    Record {
                        digest,
                        not_after: envelope.not_after,
                        verdict,
                    },
                );
                receiver
            }
        };
        // A raced duplicate decoded before seeing the installed record. Release
        // its unused context/slot before observing the original admission.
        drop((context, permit));
        // Queueing and failed-send payload destruction do not hold the custody lock.
        if let Some(work) = to_submit
            && let Err(error) = self.sender.try_send(work)
        {
            error.into_inner().settle(Disposition::Rejected);
        }
        observe(receiver).await
    }
}

async fn observe(mut receiver: watch::Receiver<Disposition>) -> Disposition {
    let wait = async {
        loop {
            let current = *receiver.borrow_and_update();
            if current != Disposition::Pending {
                return current;
            }
            if receiver.changed().await.is_err() {
                return Disposition::Unknown;
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), wait)
        .await
        .unwrap_or(Disposition::Pending)
}

#[cfg(test)]
mod tests;
