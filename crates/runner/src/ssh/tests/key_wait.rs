use super::{
    harness::{Harness, Reply, frames, params},
    terminal, wait_for,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering, mpsc},
    time::Duration,
};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
}

async fn hold_blocking_worker() -> (mpsc::Sender<()>, tokio::task::JoinHandle<()>) {
    let (release, held) = mpsc::channel();
    let entered = Arc::new(tokio::sync::Notify::new());
    let worker_entered = Arc::clone(&entered);
    let worker = tokio::task::spawn_blocking(move || {
        worker_entered.notify_one();
        // Dropping the sender also releases the worker if the test unwinds.
        let _ = held.recv();
    });
    entered.notified().await;
    (release, worker)
}

fn command(value: &str) -> Value {
    let mut request = params();
    request["command"] = json!(value);
    request
}

async fn expire_queued_request(h: &Harness) {
    wait_for(|| h.runtime.cpu.available_permits() == 0).await;
    let result = h
        .raw(
            json!({"version":1,"method":"ssh.exec","remaining_ms":2000,"params":command("expired")})
                .to_string(),
        )
        .await;
    // A real request deadline proves CPU contention waits rather than rejecting
    // immediately. The blocking worker remains held until after this response.
    assert_eq!(terminal(&result)["failure_reason"], "timed_out");
    assert_eq!(terminal(&result)["effects"], "not_started");
    assert!(h.observed.queries.lock().unwrap().is_empty());
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert!(h.observed.commands.lock().unwrap().is_empty());
}

#[test]
fn cpu_waiters_resume_after_capacity_returns_without_running_expired_requests() {
    runtime().block_on(async {
        let mut h = Harness::new(Reply::default()).await;
        // This authority mode performs a fresh preparation for each request.
        h.runtime.ably_connected(false);
        let _resolve = h.resolve(h.credential(true)).await;
        let (release, occupied) = hold_blocking_worker().await;
        let (first, second, queued, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                h.request(command("first")),
                h.request(command("second")),
                h.request(command("queued")),
                async {
                    expire_queued_request(&h).await;
                    release.send(()).unwrap();
                    occupied.await.unwrap();
                }
            )
        })
        .await
        .unwrap();
        for result in [first, second, queued] {
            assert_eq!(terminal(&result)["type"], "finished");
            assert_eq!(terminal(&result)["effects"], "completed");
        }
        let mut commands = h.observed.commands.lock().unwrap().clone();
        commands.sort();
        assert_eq!(
            commands,
            vec![b"first".to_vec(), b"queued".to_vec(), b"second".to_vec()]
        );
        assert_eq!(h.runtime.cpu.available_permits(), 2);
        h.shutdown().await;
        drop(h.control.try_fence_normal_operations().unwrap());
    });
}

#[derive(Clone, Copy, Debug)]
enum Cancel {
    Run,
    Sandbox,
}

#[test]
fn cancelled_cpu_waiters_release_run_slots_and_guest_park_before_host_jobs_finish() {
    for cancel in [Cancel::Run, Cancel::Sandbox] {
        runtime().block_on(async {
            let mut h = Harness::new(Reply::default()).await;
            h.runtime.ably_connected(false);
            let _resolve = h.resolve(h.credential(true)).await;
            let (release, occupied) = hold_blocking_worker().await;
            let (first, second, queued, pending) =
                tokio::time::timeout(Duration::from_secs(10), async {
                    tokio::join!(
                        h.request(command("first")),
                        h.request(command("second")),
                        h.request(command("queued")),
                        async {
                            expire_queued_request(&h).await;
                            let mut pending = Vec::new();
                            // Three live requests plus five partial requests fill
                            // the Run. The expired waiter's request slot is free.
                            for _ in 0..5 {
                                pending.push(h.open().await);
                            }
                            assert_eq!(
                                frames(h.open().await).await[0]["code"],
                                "resource_exhausted"
                            );
                            assert!(h.control.try_fence_normal_operations().is_err());
                            match cancel {
                                Cancel::Run => h.cancel.cancel(),
                                Cancel::Sandbox => h.lifecycle.cancel(),
                            }
                            pending
                        }
                    )
                })
                .await
                .unwrap();
            for result in [first, second, queued] {
                match cancel {
                    Cancel::Run => {
                        assert_eq!(terminal(&result)["failure_reason"], "cancelled");
                        assert_eq!(terminal(&result)["effects"], "not_started");
                    }
                    // Lifecycle cancellation closes guest I/O too, so no
                    // terminal can be sent on that cancelled stream.
                    Cancel::Sandbox => assert!(result.is_empty()),
                }
            }
            h.shutdown().await;
            for guest in pending {
                assert!(frames(guest).await.is_empty());
            }
            // Two submitted key jobs still own CPU permits; the third request
            // was only waiting, and guest RPC shutdown needs neither to finish.
            assert_eq!(h.runtime.cpu.available_permits(), 0);
            let fence = h.control.try_fence_normal_operations().unwrap();
            release.send(()).unwrap();
            occupied.await.unwrap();
            wait_for(|| h.runtime.cpu.available_permits() == 2).await;
            assert!(h.observed.queries.lock().unwrap().is_empty());
            assert!(h.observed.attempts.lock().unwrap().is_empty());
            assert!(h.observed.commands.lock().unwrap().is_empty());
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
            drop(fence);
        });
    }
}
