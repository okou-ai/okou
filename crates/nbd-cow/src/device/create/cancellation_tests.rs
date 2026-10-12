use std::io::Read;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::ThreadId;

use tokio::runtime::{Builder, Runtime};

use super::*;
use crate::device::connection::DeviceOwnership;
use crate::device_lock::try_acquire_device_claim_in;

const DEADLINE: Duration = Duration::from_secs(5);
const DEVICE_SIZE: u64 = 4096;
const DEVICE_INDEX: u32 = 0;

fn connection_id() -> Uuid {
    Uuid::from_u128(42)
}

#[derive(Clone, Copy)]
enum Cleanup {
    Owned,
    Foreign,
    Unknown,
    DisconnectError,
}

#[derive(Debug)]
enum Event {
    Connect(u32, Uuid),
    Verify(u32, ThreadId),
    Ownership(u32, Uuid, ThreadId),
    Disconnect(u32, ThreadId),
}

#[derive(Clone)]
struct GatedKernel {
    cleanup: Cleanup,
    events: mpsc::Sender<Event>,
    ownership_gate: Arc<Mutex<mpsc::Receiver<()>>>,
    disconnect_gate: Arc<Mutex<mpsc::Receiver<()>>>,
    peers: Arc<Mutex<Vec<UnixStream>>>,
}

impl CreateKernel for GatedKernel {
    fn connect(
        &self,
        index: u32,
        client_fds: &[OwnedFd],
        size: u64,
        block_size: u64,
    ) -> (
        std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        NbdNetlinkConnectTiming,
    ) {
        assert_eq!(size, DEVICE_SIZE);
        assert_eq!(block_size, BLOCK_SIZE as u64);
        let peers = client_fds
            .iter()
            .map(|fd| {
                let peer = UnixStream::from(fd.try_clone().unwrap());
                peer.set_nonblocking(true).unwrap();
                peer
            })
            .collect();
        *self.peers.lock().unwrap() = peers;
        self.events
            .send(Event::Connect(index, connection_id()))
            .unwrap();
        (
            Ok(netlink::ConnectDeviceSuccess {
                connection_id: connection_id(),
            }),
            NbdNetlinkConnectTiming::default(),
        )
    }

    async fn verify_size(&self, index: u32, size: u64) -> bool {
        assert_eq!(size, DEVICE_SIZE);
        self.events
            .send(Event::Verify(index, std::thread::current().id()))
            .unwrap();
        std::future::pending().await
    }

    fn ownership(&self, index: u32, id: Uuid) -> DeviceOwnership {
        self.events
            .send(Event::Ownership(index, id, std::thread::current().id()))
            .unwrap();
        // Sender drop releases the gate during unwinding, before runtime join.
        let _ = self.ownership_gate.lock().unwrap().recv();
        match self.cleanup {
            Cleanup::Owned | Cleanup::DisconnectError => DeviceOwnership::Ours,
            Cleanup::Foreign => DeviceOwnership::Foreign,
            Cleanup::Unknown => {
                DeviceOwnership::Unknown(std::io::Error::other("sysfs unavailable"))
            }
        }
    }

    fn disconnect(&self, index: u32) -> Result<()> {
        self.events
            .send(Event::Disconnect(index, std::thread::current().id()))
            .unwrap();
        let _ = self.disconnect_gate.lock().unwrap().recv();
        match self.cleanup {
            Cleanup::DisconnectError => Err(error::NbdCowError::Io(std::io::Error::other(
                "disconnect failed",
            ))),
            _ => Ok(()),
        }
    }
}

struct Harness {
    // Field order releases synchronous gates before the runtime joins workers;
    // the event receiver and files remain alive until that join completes.
    ownership_gate: Option<mpsc::Sender<()>>,
    disconnect_gate: Option<mpsc::Sender<()>>,
    runtime: Runtime,
    pool: pool::DevicePoolHandle,
    events: mpsc::Receiver<Event>,
    kernel: GatedKernel,
    dir: tempfile::TempDir,
}

impl Harness {
    fn new(cleanup: Cleanup) -> Self {
        let runtime = Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("base.img"),
            vec![0x5a; DEVICE_SIZE as usize],
        )
        .unwrap();
        let pool = runtime.block_on(async {
            pool::DevicePoolHandle::new_one_device_for_test(
                pool::DevicePoolConfig {
                    cooldown: Duration::MAX,
                },
                dir.path(),
            )
        });
        let (ownership_tx, ownership_gate) = mpsc::channel();
        let (disconnect_tx, disconnect_gate) = mpsc::channel();
        let (events_tx, events) = mpsc::channel();
        Self {
            ownership_gate: Some(ownership_tx),
            disconnect_gate: Some(disconnect_tx),
            runtime,
            pool,
            events,
            kernel: GatedKernel {
                cleanup,
                events: events_tx,
                ownership_gate: Arc::new(Mutex::new(ownership_gate)),
                disconnect_gate: Arc::new(Mutex::new(disconnect_gate)),
                peers: Arc::default(),
            },
            dir,
        }
    }

    fn next_event(&self) -> Event {
        self.events.recv_timeout(DEADLINE).unwrap()
    }

    fn block_on<T>(&self, future: impl std::future::Future<Output = T>) -> T {
        self.runtime.block_on(async {
            tokio::time::timeout(DEADLINE, future)
                .await
                .expect("operation must complete")
        })
    }

    fn start_create(&self) -> (JoinHandle<()>, ThreadId) {
        let base = self.dir.path().join("base.img");
        let cow = self.dir.path().join("cow.img");
        let pool = self.pool.clone();
        let kernel = self.kernel.clone();
        let create = self.runtime.spawn(async move {
            let result =
                NbdCowDevice::create_with_kernel(&base, &cow, DEVICE_SIZE, &pool, None, kernel)
                    .await;
            // Never let an unexpected successful fake device reach native Drop.
            if let Ok((mut device, lease)) = result {
                device.abandon();
                pool.retire_uncertain(lease).await;
            }
            panic!("size verification must remain pending");
        });
        let Event::Connect(index, id) = self.next_event() else {
            panic!("expected connect")
        };
        assert_eq!((index, id), (DEVICE_INDEX, connection_id()));
        // Verification can start only after connect success/lease consumption.
        let Event::Verify(index, worker) = self.next_event() else {
            panic!("expected verification")
        };
        assert_eq!(index, DEVICE_INDEX);
        (create, worker)
    }

    fn connected_guard(&self, origin: &Runtime) -> CreateAttemptGuard<GatedKernel> {
        let (lease, _, _) = self.block_on(self.pool.acquire()).unwrap().into_parts();
        origin.block_on(async {
            let mut guard =
                CreateAttemptGuard::with_kernel(self.pool.clone(), lease, self.kernel.clone());
            guard.mark_connected(connection_id());
            guard
        })
    }

    fn assert_progress_and_claim_held(&self) {
        let pool = self.pool.clone();
        let (progress, observed) = mpsc::channel();
        self.runtime.spawn(async move {
            let _ = progress.send(pool.snapshot().await);
        });
        let snapshot = observed
            .recv_timeout(DEADLINE)
            .expect("async worker must progress while cleanup is blocked");
        assert_eq!(snapshot.in_flight, [DEVICE_INDEX].into_iter().collect());
        assert!(snapshot.cooldown.is_empty());
        assert!(
            try_acquire_device_claim_in(DEVICE_INDEX, self.dir.path())
                .unwrap()
                .is_none()
        );
    }

    fn assert_dispatch_closed(&self) {
        self.block_on(async {
            loop {
                let closed = {
                    let mut peers = self.kernel.peers.lock().unwrap();
                    assert_eq!(peers.len(), NUM_CONNECTIONS);
                    peers
                        .iter_mut()
                        .all(|peer| matches!(peer.read(&mut [0]), Ok(0)))
                };
                if closed {
                    break;
                }
                tokio::task::yield_now().await;
            }
        });
    }

    fn finish(&self) {
        self.block_on(async {
            loop {
                let snapshot = self.pool.snapshot().await;
                if snapshot.in_flight.is_empty() {
                    assert_eq!(snapshot.cooldown, vec![DEVICE_INDEX]);
                    break;
                }
                tokio::task::yield_now().await;
            }
            assert!(
                try_acquire_device_claim_in(DEVICE_INDEX, self.dir.path())
                    .unwrap()
                    .is_none()
            );
            self.pool.cleanup().await;
        });
        assert!(
            self.events.try_recv().is_err(),
            "unexpected extra kernel call"
        );
        assert!(
            try_acquire_device_claim_in(DEVICE_INDEX, self.dir.path())
                .unwrap()
                .is_some()
        );
    }

    fn finish_kernel_cleanup(&mut self, async_worker: ThreadId) {
        let Event::Ownership(index, id, thread) = self.next_event() else {
            panic!("expected ownership")
        };
        assert_eq!((index, id), (DEVICE_INDEX, connection_id()));
        assert_ne!(thread, async_worker);
        self.assert_progress_and_claim_held();
        self.ownership_gate.take().unwrap().send(()).unwrap();
        if matches!(
            self.kernel.cleanup,
            Cleanup::Owned | Cleanup::DisconnectError
        ) {
            let Event::Disconnect(index, thread) = self.next_event() else {
                panic!("expected disconnect")
            };
            assert_eq!(index, DEVICE_INDEX);
            assert_ne!(thread, async_worker);
            self.assert_progress_and_claim_held();
            self.disconnect_gate.take().unwrap().send(()).unwrap();
        }
    }
}

#[test]
fn cancelled_size_verification_keeps_async_worker_responsive_and_claim_held() {
    for cleanup in [
        Cleanup::Owned,
        Cleanup::Foreign,
        Cleanup::Unknown,
        Cleanup::DisconnectError,
    ] {
        let mut harness = Harness::new(cleanup);
        let (create, worker) = harness.start_create();
        harness.assert_progress_and_claim_held();
        create.abort();
        harness.finish_kernel_cleanup(worker);
        assert!(harness.block_on(create).unwrap_err().is_cancelled());
        harness.assert_dispatch_closed();
        harness.finish();
    }
}

#[test]
fn cancelled_size_verification_retains_claim_while_cleanup_is_queued() {
    let mut harness = Harness::new(Cleanup::Owned);
    let (create, worker) = harness.start_create();
    let (release, released) = mpsc::channel();
    let (started, observed) = mpsc::channel();
    let blocker = harness.runtime.spawn_blocking(move || {
        started.send(()).unwrap();
        let _ = released.recv();
    });
    observed.recv_timeout(DEADLINE).unwrap();
    create.abort();
    assert!(harness.block_on(create).unwrap_err().is_cancelled());
    harness.assert_progress_and_claim_held();
    harness.assert_dispatch_closed();
    assert!(harness.events.try_recv().is_err());
    release.send(()).unwrap();
    harness.block_on(blocker).unwrap();
    harness.finish_kernel_cleanup(worker);
    harness.finish();
}

#[test]
fn connected_guard_dropped_outside_runtime_defers_cleanup_to_origin() {
    let mut harness = Harness::new(Cleanup::Owned);
    let guard = harness.connected_guard(&harness.runtime);
    let (dropped, observed) = mpsc::channel();
    let dropper = std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let thread = std::thread::current().id();
        drop(guard);
        let _ = dropped.send(thread);
    });
    let dropper_thread = observed
        .recv_timeout(DEADLINE)
        .expect("guard Drop must not block");
    harness.finish_kernel_cleanup(dropper_thread);
    dropper.join().unwrap();
    harness.finish();
}

#[test]
fn connected_guard_dropped_during_origin_shutdown_retires_without_kernel_io() {
    let harness = Harness::new(Cleanup::Owned);
    let origin = Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let guard = harness.connected_guard(&origin);
    let (release, released) = mpsc::channel();
    let (started, observed) = mpsc::channel();
    let blocker = origin.spawn_blocking(move || {
        started.send(()).unwrap();
        let _ = released.recv();
    });
    observed.recv_timeout(DEADLINE).unwrap();
    origin.shutdown_background();
    harness.assert_progress_and_claim_held();

    // Blocking work is still running, but shutdown rejects newly dispatched
    // cleanup. Discard must retire uncertain without synchronous kernel I/O.
    let (dropped, observed) = mpsc::channel();
    let dropper = std::thread::spawn(move || {
        drop(guard);
        let _ = dropped.send(());
    });
    observed
        .recv_timeout(DEADLINE)
        .expect("shutdown discard must not run kernel cleanup");
    dropper.join().unwrap();
    harness.finish();
    release.send(()).unwrap();
    harness.block_on(blocker).unwrap();
}

#[test]
fn connected_guard_dropped_after_origin_shutdown_retires_without_kernel_io() {
    let harness = Harness::new(Cleanup::Owned);
    let origin = Builder::new_current_thread().build().unwrap();
    let guard = harness.connected_guard(&origin);
    drop(origin);
    harness.assert_progress_and_claim_held();
    let (dropped, observed) = mpsc::channel();
    let dropper = std::thread::spawn(move || {
        drop(guard);
        let _ = dropped.send(());
    });
    observed
        .recv_timeout(DEADLINE)
        .expect("shutdown discard must not run kernel cleanup");
    dropper.join().unwrap();
    harness.finish();
}
