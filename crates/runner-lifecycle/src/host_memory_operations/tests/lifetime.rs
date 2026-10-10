use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

use super::*;

/// Observe a byte accepted by a real blocking kernel writer, then stop draining.
/// The block owns the real memory guard; the tracked task owns and joins it.
async fn accepted_write(env: &Env) -> (super::super::MemoryOperationTask<()>, UnixStream) {
    let permit = grant(
        &env.operations,
        Plan::HostIo {
            growth_bytes: 8 * MIB,
        },
    )
    .await;
    let path = env.dir.path().join("required.txt");
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    writer
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let task = permit
        .spawn(move |operation| async move {
            let mut operation = tokio::task::spawn_blocking(move || {
                writer.write_all(&vec![0x5a; MIB as usize]).unwrap();
                writer.shutdown(std::net::Shutdown::Write).unwrap();
                std::fs::write(path, b"required private bytes preserved").unwrap();
                operation
            })
            .await
            .unwrap();
            complete(&mut operation).await;
        })
        .unwrap();
    let reader = tokio::task::spawn_blocking(move || {
        let mut first = [0];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, [0x5a]);
        reader
    })
    .await
    .unwrap();
    (task, reader)
}

async fn drain(mut reader: UnixStream) {
    tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len(), MIB as usize - 1);
        assert!(bytes.iter().all(|byte| *byte == 0x5a));
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn caller_cancellation_keeps_accepted_io_and_shutdown_joins_saving() {
    let env = Env::new(14).await;
    let (task, reader) = accepted_write(&env).await;
    let (armed, seen) = oneshot::channel();
    let caller = tokio::spawn(async move {
        let join = task.join();
        tokio::pin!(join);
        assert!(futures_util::poll!(join.as_mut()).is_pending());
        armed.send(()).unwrap();
        join.await
    });
    seen.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let mut additional = env.operations.request(fresh(1)).unwrap();
    assert_eq!(
        additional.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 14 * MIB,
            required: 15 * MIB
        }
    );
    drop(additional);
    let shutdown = pending_shutdown(env.operations.clone()).await;
    assert!(matches!(
        env.operations.request(fresh(1)),
        Err(Error::Closed)
    ));
    drain(reader).await;
    let report = shutdown.await.unwrap().unwrap();
    assert_eq!(
        tokio::fs::read(env.dir.path().join("required.txt"))
            .await
            .unwrap(),
        b"required private bytes preserved"
    );
    assert_eq!(report.registered_operations, 0);
    assert_eq!(report.tracked_tasks, 0);
}

#[tokio::test]
async fn outer_panic_drops_only_receiver_not_the_real_io_owner() {
    let env = Env::new(14).await;
    let (task, reader) = accepted_write(&env).await;
    let observer = tokio::spawn(async move {
        let _receiver = task;
        panic!("external observer panic");
    });
    assert!(observer.await.unwrap_err().is_panic());
    let shutdown = pending_shutdown(env.operations.clone()).await;
    drain(reader).await;
    let report = shutdown.await.unwrap().unwrap();
    assert_eq!(
        tokio::fs::read(env.dir.path().join("required.txt"))
            .await
            .unwrap(),
        b"required private bytes preserved"
    );
    assert_eq!(report.registered_operations, 0);
}

#[tokio::test]
async fn producer_panic_keeps_transferred_blocking_io_owned_and_shutdown_joined() {
    let env = Env::new(14).await;
    let permit = grant(
        &env.operations,
        Plan::HostIo {
            growth_bytes: 8 * MIB,
        },
    )
    .await;
    let path = env.dir.path().join("required-after-producer-panic");
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
    let task: super::super::MemoryOperationTask<()> = permit
        .spawn(move |operation| async move {
            let _io = tokio::task::spawn_blocking(move || {
                writer.write_all(&vec![0x5a; MIB as usize]).unwrap();
                writer.shutdown(std::net::Shutdown::Write).unwrap();
                std::fs::write(saved, b"accepted I/O survives its producer").unwrap();
                // The physical owner finishes independently after its async
                // waiter panics. No phase completion or capacity is fabricated.
                drop(operation);
                finished.send(()).unwrap();
            });
            panicking.await.unwrap();
            panic!("producer panics while accepted blocking I/O is unfinished");
        })
        .unwrap();
    let reader = tokio::task::spawn_blocking(move || {
        let mut first = [0];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, [0x5a]);
        reader
    })
    .await
    .unwrap();
    assert!(!path.exists());
    panic_now.send(()).unwrap();
    assert_eq!(task.join().await.err().unwrap(), Error::ProducerLost);
    let shutdown = env.operations.close_and_wait();
    tokio::pin!(shutdown);
    let early = futures_util::poll!(shutdown.as_mut());
    let premature = early.is_ready();
    // Always finish and join the real fixture I/O before a regression assertion,
    // including on the broken implementation whose shutdown returned early.
    drain(reader).await;
    io_finished.await.unwrap();
    let report = match early {
        std::task::Poll::Ready(report) => report.unwrap(),
        std::task::Poll::Pending => shutdown.await.unwrap(),
    };
    assert!(
        !premature,
        "shutdown must join the physical guard after its async producer panics"
    );
    assert_eq!(report.tracked_tasks, 0);
    assert_eq!(report.uncertain, 1);
    assert_eq!(report.ordinary_growth_bytes, 8 * MIB);
    assert_eq!(
        tokio::fs::read(path).await.unwrap(),
        b"accepted I/O survives its producer"
    );
}

#[tokio::test]
async fn failed_or_panicked_started_producer_never_returns_unused_capacity() {
    let env = Env::new(14).await;
    let permit = grant(&env.operations, fresh(8)).await;
    let task = permit
        .spawn(|mut operation| async move { operation.complete_phase().await })
        .unwrap();
    assert_eq!(
        task.join().await.unwrap().err().unwrap(),
        Error::MissingBacking
    );
    let mut other = env.operations.request(fresh(1)).unwrap();
    assert!(matches!(
        other.try_grant().await,
        Err(Error::InsufficientHeadroom { .. })
    ));
    drop(other);
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(report.uncertain, 1);
    assert_eq!(report.ordinary_growth_bytes, 8 * MIB);

    let env = Env::new(14).await;
    let permit = grant(
        &env.operations,
        Plan::HostIo {
            growth_bytes: 8 * MIB,
        },
    )
    .await;
    let path = env.dir.path().join("required.txt");
    let task = permit
        .spawn(move |operation| async move {
            let _operation = operation;
            tokio::fs::write(path, b"finished I/O before producer panic")
                .await
                .unwrap();
            panic!("owned producer failed after its accepted I/O finished");
        })
        .unwrap();
    assert_eq!(task.join().await.err().unwrap(), Error::ProducerLost);
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(report.uncertain, 1);
    assert_eq!(report.ordinary_growth_bytes, 8 * MIB);
    assert_eq!(
        tokio::fs::read(env.dir.path().join("required.txt"))
            .await
            .unwrap(),
        b"finished I/O before producer panic"
    );
}

#[tokio::test]
async fn finished_io_keeps_its_guard_when_settlement_sample_is_unknown() {
    let env = Env::new(14).await;
    let permit = grant(
        &env.operations,
        Plan::HostIo {
            growth_bytes: 8 * MIB,
        },
    )
    .await;
    let path = env.dir.path().join("required.txt");
    let source = env.source.clone();
    let (unknown, observed) = oneshot::channel();
    let (retry, ready) = oneshot::channel();
    let task = permit
        .spawn(move |mut operation| async move {
            tokio::fs::write(path, b"positive I/O completion")
                .await
                .unwrap();
            tokio::fs::write(&source.path, "malformed input\n")
                .await
                .unwrap();
            assert!(matches!(
                operation.complete_phase().await,
                Err(Error::UnknownObservation(_))
            ));
            unknown.send(()).unwrap();
            ready.await.unwrap();
            complete(&mut operation).await;
        })
        .unwrap();
    observed.await.unwrap();
    assert_eq!(
        env.operations.snapshot().unwrap().ordinary_growth_bytes,
        8 * MIB
    );
    env.source.available(0).await;
    retry.send(()).unwrap();
    task.join().await.unwrap();
    // A valid zero sample settles completed work, but never grants new growth.
    let mut next = env.operations.request(fresh(1)).unwrap();
    assert!(matches!(
        next.try_grant().await,
        Err(Error::InsufficientHeadroom { available: 0, .. })
    ));
    drop(next);
    assert_eq!(
        env.operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn no_runtime_or_closed_admission_cannot_start_an_unused_permit() {
    let env = Env::new(14).await;
    let permit = grant(&env.operations, fresh(8)).await;
    let error = std::thread::spawn(move || permit.spawn(|_operation| async {}).err().unwrap())
        .join()
        .unwrap();
    assert_eq!(error, Error::NoRuntime);
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
    let permit = grant(&env.operations, fresh(8)).await;
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(report.granted, 1);
    assert_eq!(
        permit.spawn(|_operation| async {}).err().unwrap(),
        Error::Closed
    );
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}
