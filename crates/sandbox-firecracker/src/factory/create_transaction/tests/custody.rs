use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

use crate::network::{NetnsPool, NetnsPoolHandle};

use super::*;

#[tokio::test]
async fn owned_rollback_keeps_custody_when_factory_group_abandons_its_observer() {
    let fixture = WorkspaceSockFixture::new().await;
    let (dropped, released) = tokio::sync::oneshot::channel();
    let mut tx = SandboxCreateTransaction::new("owned-group-rollback".into());
    fixture.track_on(&mut tx);
    tx.retain_custody(Some(sandbox::SandboxCreateCustody::new(Arc::new(
        RollbackTaskDropSignal(Some(dropped)),
    ))));
    let cleanup = BlockingRemoveDirCleanup::default();
    let _scope = cleanup.scope();
    let cleanup_group = Arc::new(FactoryCleanupGroup::new());
    let group = cleanup_group.clone();
    let adapter = cleanup.clone();
    let waiter = tokio::spawn(async move {
        rollback_create_transaction(tx, adapter, &group).await;
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), cleanup.wait_entered(2))
        .await
        .unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    drop(cleanup_group);
    tokio::pin!(released);
    assert!(futures_util::poll!(released.as_mut()).is_pending());
    assert!(fixture.workspace.exists() && fixture.sock_dir.exists());
    cleanup.release();
    tokio::time::timeout(std::time::Duration::from_secs(5), released)
        .await
        .unwrap()
        .unwrap();
    cleanup.wait_removed(2, &fixture).await;
}

#[test]
fn owned_real_filesystem_rollback_survives_cancelled_waiter_and_transaction_drop() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let fixture = WorkspaceSockFixture::new().await;
        tokio::fs::write(
            fixture.workspace.join("home.ext4"),
            b"original partial home bytes",
        )
        .await
        .unwrap();
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let (entered, accepted) = tokio::sync::oneshot::channel();
        let blocked = tokio::task::spawn_blocking(move || {
            let _ = entered.send(());
            let mut byte = [0];
            reader.read_exact(&mut byte).unwrap();
        });
        accepted.await.unwrap();
        let (dropped, released) = tokio::sync::oneshot::channel();
        let custody =
            sandbox::SandboxCreateCustody::new(Arc::new(RollbackTaskDropSignal(Some(dropped))));
        let cleanup = FactoryCreateRollbackCleanup {
            id: "owned-rollback".into(),
            netns_pool: NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
            custody: Some(custody.clone()),
        };
        let mut tx = SandboxCreateTransaction::new("owned-rollback".into());
        fixture.track_on(&mut tx);
        tx.retain_custody(Some(custody));
        {
            let rollback = tx.rollback(&cleanup);
            tokio::pin!(rollback);
            assert!(futures_util::poll!(rollback.as_mut()).is_pending());
        }
        // The actual blocking filesystem producer was accepted but queued;
        // neither its borrowed waiter nor transaction is now its owner.
        drop(tx);
        drop(cleanup);
        tokio::pin!(released);
        assert!(futures_util::poll!(released.as_mut()).is_pending());
        assert_eq!(
            std::fs::read(fixture.workspace.join("home.ext4")).unwrap(),
            b"original partial home bytes"
        );
        writer.write_all(b"x").unwrap();
        blocked.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), released)
            .await
            .unwrap()
            .unwrap();
        assert!(!fixture.workspace.exists());
        assert!(!fixture.sock_dir.exists());
    });
}

#[tokio::test]
async fn cancelling_transaction_transfers_custody_with_the_same_leaked_resources() {
    let fixture = WorkspaceSockFixture::new().await;
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (dropped, released) = tokio::sync::oneshot::channel();
    let custody =
        sandbox::SandboxCreateCustody::new(Arc::new(RollbackTaskDropSignal(Some(dropped))));
    let mut tx =
        SandboxCreateTransaction::new_with_leak_tx("cancelled-owned-create".into(), Some(sent));
    fixture.track_on(&mut tx);
    tx.retain_custody(Some(custody));
    tx.track_network(test_network());
    drop(tx);
    let mut leaked = received.recv().await.unwrap();
    assert_eq!(leaked.workspace, fixture.workspace);
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert!(leaked.create_custody.is_some());
    let _network = leaked.network.take().unwrap().into_info_for_test();
    tokio::pin!(released);
    assert!(futures_util::poll!(released.as_mut()).is_pending());
    assert!(fixture.workspace.exists());
    // Invocation-owned cleanup of the returned leak report after assertions.
    tokio::fs::remove_dir_all(&leaked.workspace).await.unwrap();
    tokio::fs::remove_dir_all(&leaked.sock_dir).await.unwrap();
    drop(leaked);
    released.await.unwrap();
}
