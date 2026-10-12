use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

use sandbox_mock::MockBackingProcess;

use super::*;

async fn pair(env: &Env) -> (MemoryGrowthPermit, MemoryGrowthPermit) {
    let (exit, backing) = MockBackingProcess::channel();
    exit.confirm_exit();
    let live = grant(
        &env.operations,
        Plan::Retire {
            growth_bytes: 8 * MIB,
            backing,
        },
    )
    .await;
    let tail = grant(&env.operations, Plan::CleanupIo { growth_bytes: MIB }).await;
    (live, tail)
}

#[tokio::test]
async fn foreign_or_wrong_purpose_pair_never_partially_starts_or_consumes_payload() {
    let env = Env::new(64).await;
    let foreign = Env::new(64).await;
    let (live, unused) = pair(&env).await;
    drop(unused);
    let tail = grant(&foreign.operations, Plan::CleanupIo { growth_bytes: MIB }).await;
    let failure = live
        .spawn_retirement(tail, b"original private bytes".to_vec(), |_, _, _| async {
            panic!("foreign pair must not execute")
        })
        .err()
        .unwrap();
    assert_eq!(failure.error, Error::OwnershipInvariant);
    assert_eq!(failure.payload, b"original private bytes");
    assert_eq!(env.operations.snapshot().unwrap().granted, 1);
    assert_eq!(foreign.operations.snapshot().unwrap().granted, 1);
    drop(failure);
    let (live, unused) = pair(&env).await;
    drop(unused);
    let ordinary = grant(&env.operations, Plan::HostIo { growth_bytes: MIB }).await;
    let failure = live
        .spawn_retirement(ordinary, vec![0x5a; 1024], |_, _, _| async {
            panic!("wrong purpose must not execute")
        })
        .err()
        .unwrap();
    assert_eq!(failure.error, Error::PurposeChanged);
    assert_eq!(failure.payload, vec![0x5a; 1024]);
    let snapshot = env.operations.snapshot().unwrap();
    assert_eq!(
        (snapshot.granted, snapshot.started, snapshot.tracked_tasks),
        (2, 0, 0)
    );
    drop(failure);
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn absent_runtime_returns_both_unused_guards_and_original_payload() {
    let env = Env::new(64).await;
    let (live, tail) = pair(&env).await;
    let failure = std::thread::spawn(move || {
        live.spawn_retirement(tail, vec![0x5a; 1024], |_, _, _| async {
            panic!("runtime rejection must not execute")
        })
        .err()
        .unwrap()
    })
    .join()
    .unwrap();
    assert_eq!(failure.error, Error::NoRuntime);
    assert_eq!(failure.payload, vec![0x5a; 1024]);
    assert_eq!(env.operations.snapshot().unwrap().granted, 2);
    drop(failure);
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn bounded_owner_rejection_preserves_pair_for_one_owner_retry() {
    let mut limits = policy();
    limits.max_operations = 2;
    let env = Env::with_policy(64, limits).await;
    let mut retained = Vec::new();
    for _ in 0..2 {
        let permit = grant(&env.operations, Plan::HostIo { growth_bytes: MIB }).await;
        let (settled, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let task = permit
            .spawn(move |mut operation| async move {
                complete(&mut operation).await;
                settled.send(()).unwrap();
                wait.await.unwrap();
            })
            .unwrap();
        observed.await.unwrap();
        retained.push((release, task));
    }
    let (live, tail) = pair(&env).await;
    let failure = live
        .spawn_retirement(tail, vec![0x5a; 1024], |_, _, _| async {
            panic!("full work-owner registry must not execute")
        })
        .err()
        .unwrap();
    assert_eq!(failure.error, Error::TaskLimit);
    let snapshot = env.operations.snapshot().unwrap();
    assert_eq!(
        (snapshot.granted, snapshot.started, snapshot.tracked_tasks),
        (2, 0, 2)
    );
    for (release, task) in retained {
        release.send(()).unwrap();
        task.join().await.unwrap();
    }
    // `join` observes the result before the task's final token drop.
    tokio::time::timeout(Duration::from_secs(5), async {
        while env.operations.snapshot().unwrap().tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let path = env.dir.path().join("retired-private-bytes");
    let saved = path.clone();
    let task = failure
        .live
        .spawn_retirement(
            failure.tail,
            failure.payload,
            move |mut live, mut tail, bytes| async move {
                tokio::fs::write(saved, bytes).await.unwrap();
                complete(&mut live).await;
                complete(&mut tail).await;
            },
        )
        .ok()
        .unwrap();
    task.join().await.unwrap();
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    assert_eq!(tokio::fs::read(path).await.unwrap(), vec![0x5a; 1024]);
}

#[tokio::test]
async fn paired_producer_panic_keeps_real_blocking_tail_owned_until_kernel_io_finishes() {
    let env = Env::new(64).await;
    let (live, tail) = pair(&env).await;
    let path = env.dir.path().join("required-after-paired-producer-panic");
    let saved = path.clone();
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    writer
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let (panic_now, panicking) = oneshot::channel();
    let (finished, io_finished) = oneshot::channel();
    let task: super::super::MemoryOperationTask<()> = live
        .spawn_retirement(tail, saved, move |live, tail, saved| async move {
            let _io = tokio::task::spawn_blocking(move || {
                writer.write_all(&vec![0x5a; MIB as usize]).unwrap();
                writer.shutdown(std::net::Shutdown::Write).unwrap();
                std::fs::write(saved, b"paired physical owner preserved private bytes").unwrap();
                drop((live, tail));
                finished.send(()).unwrap();
            });
            panicking.await.unwrap();
            panic!("paired async producer loses its physical I/O waiter");
        })
        .ok()
        .unwrap();
    let mut reader = tokio::task::spawn_blocking(move || {
        let mut first = [0];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, [0x5a]);
        reader
    })
    .await
    .unwrap();
    assert!(!path.exists());
    assert_eq!(env.operations.snapshot().unwrap().tracked_tasks, 1);
    panic_now.send(()).unwrap();
    assert_eq!(task.join().await.err().unwrap(), Error::ProducerLost);
    let shutdown = env.operations.close_and_wait();
    tokio::pin!(shutdown);
    let early = futures_util::poll!(shutdown.as_mut());
    let premature = early.is_ready();
    // Join fixture I/O even if a broken implementation unregisters it early.
    tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len(), MIB as usize - 1);
        assert!(bytes.iter().all(|byte| *byte == 0x5a));
    })
    .await
    .unwrap();
    io_finished.await.unwrap();
    let report = match early {
        std::task::Poll::Ready(report) => report.unwrap(),
        std::task::Poll::Pending => shutdown.await.unwrap(),
    };
    assert!(
        !premature,
        "both physical phase guards must survive producer loss"
    );
    assert_eq!(
        (
            report.tracked_tasks,
            report.uncertain,
            report.cleanup_growth_bytes
        ),
        (0, 2, 9 * MIB)
    );
    assert_eq!(
        tokio::fs::read(path).await.unwrap(),
        b"paired physical owner preserved private bytes"
    );
}
