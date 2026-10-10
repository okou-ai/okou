use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::Stdio;

use sandbox::SandboxBackingProcess;
use sandbox_mock::MockBackingProcess;
use tokio::io::AsyncWriteExt;

use super::*;

#[tokio::test]
async fn started_binding_is_once_only_and_unresolved_replacement_needs_coverage() {
    let env = Env::new(18).await;
    let (old_wait, old) = MockBackingProcess::channel();
    let old_id = old.identity();
    let retiring = grant(
        &env.operations,
        Plan::Retire {
            growth_bytes: 8 * MIB,
            backing: old,
        },
    )
    .await;
    old_wait.fail_wait();
    let old_task = retiring
        .spawn(move |mut operation| async move {
            assert_eq!(operation.backing_identity().unwrap(), Some(old_id));
            operation.complete_phase().await
        })
        .unwrap();
    assert_eq!(
        old_task.join().await.unwrap().err().unwrap(),
        Error::UnconfirmedBacking
    );

    let replacement = grant(&env.operations, fresh(8)).await;
    let (new_wait, new_backing) = MockBackingProcess::channel();
    let (_, alien) = MockBackingProcess::channel();
    let new_id = new_backing.identity();
    let path = env.dir.path().join("replacement-private-input");
    let (bound, observed) = oneshot::channel();
    let (ready, finish) = oneshot::channel();
    let task = replacement
        .spawn(move |mut operation| async move {
            operation.bind_backing(new_backing).unwrap();
            assert_eq!(
                operation.bind_backing(alien).err().unwrap(),
                Error::BackingAlreadyCaptured
            );
            assert_eq!(operation.backing_identity().unwrap(), Some(new_id));
            tokio::fs::write(path, b"replacement preparation complete")
                .await
                .unwrap();
            bound.send(()).unwrap();
            finish.await.unwrap();
            complete(&mut operation).await;
        })
        .unwrap();
    observed.await.unwrap();
    let mut extra = env.operations.request(fresh(1)).unwrap();
    assert_eq!(
        extra.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 18 * MIB,
            required: 19 * MIB
        }
    );
    drop(extra);
    ready.send(()).unwrap();
    task.join().await.unwrap();
    drop(new_wait);
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(report.uncertain, 1);
    assert_eq!(report.cleanup_growth_bytes, 8 * MIB);
    assert_eq!(report.ordinary_growth_bytes, 0);
    assert_eq!(
        tokio::fs::read(env.dir.path().join("replacement-private-input"))
            .await
            .unwrap(),
        b"replacement preparation complete"
    );
}

#[tokio::test]
async fn independent_receipt_wait_allows_progress_but_failed_or_lost_wait_is_uncertain() {
    for fail_wait in [true, false] {
        let env = Env::new(14).await;
        let (producer, backing) = MockBackingProcess::channel();
        let permit = grant(
            &env.operations,
            Plan::Retire {
                growth_bytes: 6 * MIB,
                backing,
            },
        )
        .await;
        let (waiting, observed) = oneshot::channel();
        let task = permit
            .spawn(move |mut operation| async move {
                let settlement = operation.complete_phase();
                tokio::pin!(settlement);
                assert!(futures_util::poll!(settlement.as_mut()).is_pending());
                waiting.send(()).unwrap();
                settlement.await
            })
            .unwrap();
        observed.await.unwrap();
        // The actual public wait is pending, yet another owner can read/admit.
        let other = grant(&env.operations, fresh(1)).await;
        drop(other);
        if fail_wait {
            producer.fail_wait();
        } else {
            drop(producer);
        }
        assert_eq!(
            task.join().await.unwrap().err().unwrap(),
            Error::UnconfirmedBacking
        );
        let report = env.operations.close_and_wait().await.unwrap();
        assert_eq!(report.uncertain, 1);
        assert_eq!(report.cleanup_growth_bytes, 6 * MIB);
    }
}

#[tokio::test]
async fn real_nonzero_child_exit_settles_only_vm_phase_while_required_disk_tail_is_joined() {
    let env = Env::new(14).await;
    let (completion, backing) = MockBackingProcess::channel();
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", "read gate; exit 7"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    // The explicit external Sandbox receipt is produced only by this real,
    // sole provider-owned wait. No kill/PID/pool observation publishes it.
    let native_wait = tokio::spawn(async move {
        let status = child.wait().await.unwrap();
        assert_eq!(status.code(), Some(7));
        completion.confirm_exit();
    });
    let retire = grant(
        &env.operations,
        Plan::Retire {
            growth_bytes: 6 * MIB,
            backing,
        },
    )
    .await;
    let tail = grant(&env.operations, Plan::CleanupIo { growth_bytes: MIB }).await;
    let path = env.dir.path().join("required-post-exit-publication");
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    writer
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let tail = tail
        .spawn(move |operation| async move {
            let mut operation = tokio::task::spawn_blocking(move || {
                writer.write_all(&vec![0x33; MIB as usize]).unwrap();
                writer.shutdown(std::net::Shutdown::Write).unwrap();
                std::fs::write(path, b"required publication preserved").unwrap();
                operation
            })
            .await
            .unwrap();
            complete(&mut operation).await;
        })
        .unwrap();
    let mut reader = tokio::task::spawn_blocking(move || {
        let mut first = [0];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, [0x33]);
        reader
    })
    .await
    .unwrap();
    let (waiting, awaiting_exit) = oneshot::channel();
    let (settled, vm_finished) = oneshot::channel();
    let export = env.dir.path().join("required-export");
    let retirement = retire
        .spawn(move |mut operation| async move {
            tokio::fs::write(export, b"required export finished before exit")
                .await
                .unwrap();
            {
                let phase = operation.complete_phase();
                tokio::pin!(phase);
                assert!(futures_util::poll!(phase.as_mut()).is_pending());
                waiting.send(()).unwrap();
                phase.await.unwrap();
            }
            settled.send(()).unwrap();
            tail.join().await.unwrap();
        })
        .unwrap();
    awaiting_exit.await.unwrap();
    let mut additional = env.operations.request(fresh(8)).unwrap();
    assert_eq!(
        additional.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 14 * MIB,
            required: 17 * MIB
        }
    );
    input.write_all(b"finish\n").await.unwrap();
    drop(input);
    native_wait.await.unwrap();
    vm_finished.await.unwrap();
    // Same availability: no synthetic bytes credited by exit. The finished
    // VM allowance is gone, but growing tail and required work remain owned.
    let fitting = additional.try_grant().await.unwrap();
    assert_eq!(env.operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
    assert_eq!(env.operations.snapshot().unwrap().tracked_tasks, 2);
    assert!(
        !env.dir
            .path()
            .join("required-post-exit-publication")
            .exists()
    );
    drop(fitting);
    let shutdown = pending_shutdown(env.operations.clone()).await;
    tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len(), MIB as usize - 1);
        assert!(bytes.iter().all(|byte| *byte == 0x33));
    })
    .await
    .unwrap();
    retirement.join().await.unwrap();
    let report = shutdown.await.unwrap().unwrap();
    assert_eq!(report.registered_operations, 0);
    assert_eq!(report.tracked_tasks, 0);
    assert_eq!(
        tokio::fs::read(env.dir.path().join("required-export"))
            .await
            .unwrap(),
        b"required export finished before exit"
    );
    assert_eq!(
        tokio::fs::read(env.dir.path().join("required-post-exit-publication"))
            .await
            .unwrap(),
        b"required publication preserved"
    );
}

#[tokio::test]
async fn sample_before_settlement_cannot_spend_headroom_after_allowance_removal() {
    let env = Env::new(14).await;
    let permit = grant(
        &env.operations,
        Plan::HostIo {
            growth_bytes: 8 * MIB,
        },
    )
    .await;
    let path = env.dir.path().join("prepared-input");
    let (prepared, observed) = oneshot::channel();
    let (finish, finishing) = oneshot::channel();
    let task = permit
        .spawn(move |mut operation| async move {
            tokio::fs::write(path, b"physical preparation completed")
                .await
                .unwrap();
            prepared.send(()).unwrap();
            finishing.await.unwrap();
            complete(&mut operation).await;
        })
        .unwrap();
    observed.await.unwrap();
    let mut next = env.operations.request(fresh(1)).unwrap();
    let (captured, deliver) = env.source.gate_next_read();
    let deciding = tokio::spawn(async move {
        let result = next.try_grant().await;
        (next, result)
    });
    captured.await.unwrap();
    // The completed growth is now reflected in the external host observation.
    env.source.available(5).await;
    finish.send(()).unwrap();
    task.join().await.unwrap();
    deliver.send(()).unwrap();
    let (mut next, stale) = deciding.await.unwrap();
    assert_eq!(stale.err().unwrap(), Error::AccountingChanged);
    assert_eq!(
        next.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 5 * MIB,
            required: 7 * MIB
        }
    );
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
async fn closing_during_observation_never_activates_a_late_grant() {
    let env = Env::new(14).await;
    let mut request = env.operations.request(fresh(8)).unwrap();
    let (captured, deliver) = env.source.gate_next_read();
    let deciding = tokio::spawn(async move { request.try_grant().await });
    captured.await.unwrap();
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(report.queued, 1);
    assert_eq!(report.tracked_tasks, 0);
    deliver.send(()).unwrap();
    assert_eq!(deciding.await.unwrap().err().unwrap(), Error::Closed);
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}
