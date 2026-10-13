use std::num::NonZeroUsize;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use futures_util::{FutureExt, future::BoxFuture};
use runner_host::host_memory::HostMemoryObservation;
use tokio::sync::Notify;

use crate::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPolicy,
};
use crate::host_memory_policy::HostMemoryBounds;
use crate::host_memory_pressure::{HostPressureCoordinator, HostPressurePolicy};

use super::*;

mod ownership;
mod pressure;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);

struct FileSource(PathBuf);

impl MemoryObservationSource for FileSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

fn policy() -> MemoryOperationPolicy {
    MemoryOperationPolicy {
        bounds: HostMemoryBounds {
            host_total_bytes: 64 * MIB,
            operating_floor_bytes: 4 * MIB,
            cleanup_reserve_bytes: 4 * MIB,
            critical_available_bytes: 16 * MIB,
            recovery_available_bytes: 24 * MIB,
        },
        max_sample_age: Duration::from_secs(5),
        max_operations: 16,
        max_cleanup_inflight: 4,
    }
}

fn pressure_policy() -> HostPressurePolicy {
    HostPressurePolicy {
        bounds: policy().bounds,
        max_sample_age: policy().max_sample_age,
        // Explicit synthetic timing, not production measurements. Distinct real
        // file reads satisfy this policy without delaying physical IO tests.
        recovery_sustain: Duration::from_nanos(1),
        wave_cooldown: Duration::from_millis(1),
        optional_start_interval: Duration::from_millis(1),
        max_wave_entries: NonZeroUsize::MIN,
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    meminfo: PathBuf,
    operations: HostMemoryOperations,
    control: OptionalPressureControl,
    sampler: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new(available: u64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let meminfo = dir.path().join("meminfo");
        tokio::fs::write(&meminfo, format!("MemAvailable: {} kB\n", available * 1024))
            .await
            .unwrap();
        let operations =
            HostMemoryOperations::new(policy(), Arc::new(FileSource(meminfo.clone()))).unwrap();
        let mut driver =
            HostPressureCoordinator::new(pressure_policy(), operations.clone()).unwrap();
        let control = driver.optional_control();
        let stop = driver.cancellation_token();
        let source = operations.clone();
        let sampler = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_millis(2));
            loop {
                tokio::select! {
                    () = stop.cancelled() => break,
                    _ = ticks.tick() => {},
                }
                driver.observe(source.observe_pressure().await);
            }
        });
        let fixture = Self {
            dir,
            meminfo,
            operations,
            control,
            sampler,
        };
        fixture
            .state(if available > 24 {
                HostPressureState::Ready
            } else {
                HostPressureState::Critical
            })
            .await;
        fixture
    }

    async fn available(&self, mib: u64) {
        let next = self.meminfo.with_extension("next");
        tokio::fs::write(&next, format!("MemAvailable: {} kB\n", mib * 1024))
            .await
            .unwrap();
        tokio::fs::rename(next, &self.meminfo).await.unwrap();
    }

    async fn state(&self, state: HostPressureState) {
        tokio::time::timeout(WAIT, async {
            loop {
                let changed = self.control.changed();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.control.decision().state == state {
                    break;
                }
                changed.await;
            }
        })
        .await
        .unwrap();
    }

    async fn file(&self, name: &str, bytes: &[u8], memory_mb: u32) -> MemoryPrefetchCandidate {
        let path = self.dir.path().join(name);
        tokio::fs::write(&path, bytes).await.unwrap();
        MemoryPrefetchCandidate { path, memory_mb }
    }

    fn config(&self) -> GuardedPrefetchConfig {
        GuardedPrefetchConfig {
            pressure: self.control.clone(),
            overhead_bytes: MIB,
        }
    }

    async fn stop(self) {
        self.control.stopped().cancel();
        self.sampler.await.unwrap();
    }
}

async fn report(
    latest: &mut watch::Receiver<GuardedPrefetchSnapshot>,
    predicate: impl Fn(&GuardedPrefetchSnapshot) -> bool,
) -> GuardedPrefetchSnapshot {
    tokio::time::timeout(WAIT, async {
        loop {
            let value = latest.borrow_and_update().clone();
            if predicate(&value) {
                return value;
            }
            latest.changed().await.unwrap();
        }
    })
    .await
    .unwrap()
}

#[derive(Default)]
struct Gate {
    entered: Notify,
    state: Mutex<bool>,
    release: Condvar,
}

impl Gate {
    fn hold(&self) {
        let mut released = self.state.lock().unwrap();
        self.entered.notify_one();
        while !*released {
            released = self.release.wait(released).unwrap();
        }
    }

    async fn entered(&self) {
        tokio::time::timeout(WAIT, self.entered.notified())
            .await
            .unwrap();
    }

    fn release(&self) {
        *self.state.lock().unwrap() = true;
        self.release.notify_all();
    }
}

fn gated_read(
    gate: Arc<Gate>,
    panic_after: bool,
) -> impl Fn(&Path, u64, &CancellationToken, &OptionalPressureControl) -> PrefetchOutcome
+ Send
+ Sync
+ 'static {
    move |path, _, cancel, pressure| {
        let mut file = std::fs::File::open(path).unwrap();
        let mut prefix = [0_u8; 128];
        let first = file.read(&mut prefix).unwrap();
        assert_eq!(&prefix[..first], vec![7_u8; first]);
        gate.hold();
        assert!(!panic_after, "physical prefetch reader producer lost");
        if cancel.is_cancelled() || suppressed(pressure) {
            return PrefetchOutcome::Cancelled {
                bytes: first as u64,
            };
        }
        let mut remaining = Vec::new();
        file.read_to_end(&mut remaining).unwrap();
        assert!(remaining.iter().all(|byte| *byte == 7));
        PrefetchOutcome::Complete {
            bytes: first as u64 + remaining.len() as u64,
        }
    }
}
