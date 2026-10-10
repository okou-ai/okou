//! Current WSS access only. These leases never own or cancel ordinary Runs.
//! One listener-owned, bounded writer read renews current Run/owner authority
//! for already-admitted sessions; notifications cannot renew access.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio::time::Instant;

use super::{MAX_CONNECTIONS, RunId, TicketConsumer, Uuid};

pub(super) const LEASE_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);
const REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
pub(super) const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::reactor) struct Key {
    pub run_id: RunId,
    pub digest: String,
    pub org_id: String,
    pub user_id: String,
}

struct Entry {
    key: Key,
    deadline: watch::Sender<Option<Instant>>,
}

type Entries = Arc<Mutex<HashMap<Uuid, Entry>>>;

#[derive(Clone, Default)]
pub(super) struct Authorizations {
    entries: Entries,
}

impl Authorizations {
    pub fn track(&self, key: Key, deadline: Instant) -> Option<Lease> {
        if key.org_id.is_empty()
            || key.user_id.is_empty()
            || key.digest.len() != 64
            || !key
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || deadline <= Instant::now()
        {
            return None;
        }
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= MAX_CONNECTIONS {
            return None;
        }
        let id = Uuid::new_v4();
        let (sender, receiver) = watch::channel(Some(deadline));
        entries.insert(
            id,
            Entry {
                key,
                deadline: sender,
            },
        );
        Some(Lease {
            id,
            entries: Arc::clone(&self.entries),
            receiver,
        })
    }

    fn requested(&self) -> Vec<Key> {
        let now = Instant::now();
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|entry| {
                entry
                    .deadline
                    .borrow()
                    .is_some_and(|deadline| deadline > now)
            })
            .map(|entry| entry.key.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect()
    }

    fn apply(&self, requested: &[Key], authorized: &[Key], deadline: Instant) {
        let allowed: HashSet<_> = authorized.iter().cloned().collect();
        if allowed.len() != authorized.len()
            || authorized.iter().any(|key| !requested.contains(key))
        {
            return;
        }
        let now = Instant::now();
        if deadline <= now {
            return;
        }
        for entry in self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if !requested.contains(&entry.key) {
                continue;
            }
            entry.deadline.send_if_modified(|current| {
                // Expired/denied grants cannot be resurrected by a late response.
                let Some(old) = *current else { return false };
                if old <= now {
                    return false;
                }
                let next = allowed.contains(&entry.key).then_some(old.max(deadline));
                if *current == next {
                    return false;
                }
                *current = next;
                true
            });
        }
    }

    pub fn start(
        &self,
        runner: Uuid,
        origin: Option<String>,
        consumer: Arc<dyn TicketConsumer>,
    ) -> RefreshTask {
        let authorities = self.clone();
        let task = tokio::spawn(async move {
            let Some(origin) = origin else { return };
            let mut interval = tokio::time::interval(REFRESH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let requested = authorities.requested();
                if requested.is_empty() {
                    continue;
                }
                let started = Instant::now();
                if let Ok(Some(authorized)) = tokio::time::timeout(
                    REQUEST_TIMEOUT,
                    consumer.authorized(runner, &origin, &requested),
                )
                .await
                {
                    authorities.apply(&requested, &authorized, started + LEASE_WINDOW);
                }
                // Errors cannot extend the last good deadline. No ordinary Run
                // cancellation/heartbeat/claim or unbounded retry is involved.
            }
        });
        RefreshTask { task }
    }
}

pub(super) struct Lease {
    id: Uuid,
    entries: Entries,
    receiver: watch::Receiver<Option<Instant>>,
}

impl Lease {
    pub async fn closed(&self) {
        let mut receiver = self.receiver.clone();
        loop {
            let Some(deadline) = *receiver.borrow_and_update() else {
                return;
            };
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline) => return,
                changed = receiver.changed() => {
                    if changed.is_err() { return; }
                }
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// The listener owns this control task even on unexpected Admission drop.
pub(super) struct RefreshTask {
    task: tokio::task::JoinHandle<()>,
}

impl RefreshTask {
    pub async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for RefreshTask {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests;
