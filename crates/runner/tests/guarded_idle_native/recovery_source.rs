//! Owned gates around real /proc reads; no fabrication or timestamp renewal.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use runner_lifecycle::host_memory_operations::{
    MemoryObservationSource, ProcMemoryObservationSource,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use super::*;

pub struct Source {
    epoch: tokio::time::Instant,
    open: watch::Sender<bool>,
    waiting: AtomicUsize,
    entered: Notify,
    samples: Mutex<Vec<Value>>,
    failure: Mutex<Option<String>>,
    next_read: Mutex<Option<Arc<ReadGate>>>,
}

/// An owned one-shot pre-read hold; all subsequent real readers remain free.
pub struct ReadGate {
    entered: watch::Sender<bool>,
    released: watch::Sender<bool>,
}

impl ReadGate {
    pub async fn wait_entered(&self) -> TestResult<()> {
        let mut entered = self.entered.subscribe();
        while !*entered.borrow_and_update() {
            entered.changed().await?;
        }
        Ok(())
    }

    pub fn release(&self) {
        self.released.send_replace(true);
    }

    async fn wait(&self) {
        let mut released = self.released.subscribe();
        self.entered.send_replace(true);
        while !*released.borrow_and_update() {
            if released.changed().await.is_err() {
                break;
            }
        }
    }
}

impl Source {
    pub fn new() -> Self {
        Self {
            epoch: tokio::time::Instant::now(),
            open: watch::channel(true).0,
            waiting: AtomicUsize::new(0),
            entered: Notify::new(),
            samples: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            next_read: Mutex::new(None),
        }
    }

    pub fn hold_next_read(&self) -> TestResult<Arc<ReadGate>> {
        let mut next = self
            .next_read
            .lock()
            .map_err(|_| io::Error::other("native next-read gate poisoned"))?;
        if next.is_some() {
            return Err(io::Error::other("native next-read gate already armed").into());
        }
        let gate = Arc::new(ReadGate {
            entered: watch::channel(false).0,
            released: watch::channel(false).0,
        });
        *next = Some(gate.clone());
        Ok(gate)
    }

    pub fn pause(&self) {
        self.open.send_replace(false);
    }

    pub fn resume(&self) {
        self.open.send_replace(true);
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
            if opened.changed().await.is_err() {
                break;
            }
        }
        self.waiting.fetch_sub(1, Ordering::SeqCst);
    }
}

impl MemoryObservationSource for Source {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            let gate = match self.next_read.lock() {
                Ok(mut next) => next.take(),
                Err(_) => {
                    if let Ok(mut failure) = self.failure.lock() {
                        *failure = Some("native next-read gate poisoned".into());
                    }
                    return HostMemoryObservation::unknown(HostMemoryUnknown::InvalidTiming);
                }
            };
            if let Some(gate) = gate {
                gate.wait().await;
            }
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

#[tokio::test]
async fn one_held_proc_reader_does_not_block_subsequent_fresh_readers() -> TestResult<()> {
    let source = Arc::new(Source::new());
    let gate = source.hold_next_read()?;
    let reader = source.clone();
    let held = tokio::spawn(async move { reader.observe().await });
    let result: TestResult<()> = async {
        tokio::time::timeout(Duration::from_secs(5), gate.wait_entered()).await??;
        let observation = tokio::time::timeout(Duration::from_secs(5), source.observe()).await?;
        observation.available_bytes_at(tokio::time::Instant::now(), Duration::from_secs(5))?;
        if held.is_finished() || source.samples()?.len() != 1 {
            return Err(
                io::Error::other("one-shot gate blocked or consumed the wrong reader").into(),
            );
        }
        Ok(())
    }
    .await;
    gate.release();
    let observation = held.await?;
    observation.available_bytes_at(tokio::time::Instant::now(), Duration::from_secs(5))?;
    result?;
    assert_eq!(source.samples()?.len(), 2);
    Ok(())
}
