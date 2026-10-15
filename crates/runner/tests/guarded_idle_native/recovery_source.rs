//! Owned delays before real /proc reads; no sample fabrication or replay.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use runner_lifecycle::host_memory_operations::{
    MemoryObservationSource, ProcMemoryObservationSource,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore, watch};

use super::*;

pub struct Source {
    epoch: tokio::time::Instant,
    open: watch::Sender<bool>,
    passes: Semaphore,
    waiting: AtomicUsize,
    entered: Notify,
    samples: Mutex<Vec<Value>>,
    failure: Mutex<Option<String>>,
}

impl Source {
    pub fn new() -> Self {
        Self {
            epoch: tokio::time::Instant::now(),
            open: watch::channel(true).0,
            passes: Semaphore::new(0),
            waiting: AtomicUsize::new(0),
            entered: Notify::new(),
            samples: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
        }
    }

    pub fn pause(&self) {
        self.open.send_replace(false);
    }

    pub fn resume(&self) {
        self.open.send_replace(true);
    }

    pub fn one_read(&self) {
        self.passes.add_permits(1);
    }

    pub async fn wait_for_readers(&self, count: usize) {
        loop {
            let entered = self.entered.notified();
            tokio::pin!(entered);
            entered.as_mut().enable();
            if self.waiting.load(Ordering::SeqCst) >= count {
                return;
            }
            entered.await;
        }
    }

    pub fn samples(&self) -> TestResult<Vec<Value>> {
        if let Some(error) = self
            .failure
            .lock()
            .map_err(|_| io::Error::other("native source failure state poisoned"))?
            .as_ref()
        {
            return Err(io::Error::other(error.clone()).into());
        }
        let mut samples = self
            .samples
            .lock()
            .map_err(|_| io::Error::other("native source samples poisoned"))?
            .clone();
        samples.sort_by_key(|sample| sample["read_start_offset_ns"].as_u64());
        Ok(samples)
    }

    async fn wait(&self) {
        let mut opened = self.open.subscribe();
        if *opened.borrow_and_update() {
            return;
        }
        self.waiting.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_waiters();
        loop {
            if *opened.borrow_and_update() {
                break;
            }
            tokio::select! {
                changed = opened.changed() => if changed.is_err() { break; },
                permit = self.passes.acquire() => {
                    if let Ok(permit) = permit { permit.forget(); }
                    break;
                }
            }
        }
        self.waiting.fetch_sub(1, Ordering::SeqCst);
    }
}

impl MemoryObservationSource for Source {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            self.wait().await;
            // Timestamp and read are both after release. A delayed waiter cannot
            // return a cached pre-gate sample with a manufactured fresh age.
            let captured: TestResult<HostMemoryObservation> = async {
                let started = evidence::clocks()?.0;
                let observation = ProcMemoryObservationSource.observe().await;
                let now = tokio::time::Instant::now();
                let finished = evidence::clocks()?.0;
                let age = observation
                    .age_at(now)
                    .ok_or_else(|| io::Error::other("native proc read clock invalid"))?;
                let read_start = now
                    .checked_sub(age)
                    .ok_or_else(|| io::Error::other("native read start invalid"))?;
                let offset = read_start
                    .checked_duration_since(self.epoch)
                    .ok_or_else(|| io::Error::other("native source epoch invalid"))?;
                let available = observation.available_bytes_at(now, Duration::from_secs(60));
                self.samples
                    .lock()
                    .map_err(|_| io::Error::other("native source samples poisoned"))?
                    .push(json!({
                        "started_ns": started, "finished_ns": finished,
                        "read_start_offset_ns": u64::try_from(offset.as_nanos())?,
                        "available_bytes": available.ok(), "age_ns": u64::try_from(age.as_nanos())?,
                        "read_duration_ns": u64::try_from(observation.read_duration().as_nanos())?,
                    }));
                Ok(observation)
            }
            .await;
            match captured {
                Ok(observation) => observation,
                Err(error) => {
                    if let Ok(mut failure) = self.failure.lock() {
                        *failure = Some(error.to_string());
                    }
                    HostMemoryObservation::unknown(HostMemoryUnknown::InvalidTiming)
                }
            }
        })
    }
}
