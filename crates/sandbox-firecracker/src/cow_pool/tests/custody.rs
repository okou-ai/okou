use super::*;

struct CustodyCompletion(Option<oneshot::Sender<()>>);

impl Drop for CustodyCompletion {
    fn drop(&mut self) {
        if let Some(completed) = self.0.take() {
            let _ = completed.send(());
        }
    }
}

#[tokio::test]
async fn cancelled_failed_checkout_keeps_create_custody_until_physical_cleanup_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let (slot, started, release, removed) =
        test_slot_with_teardown_gate(dir.path(), "owned-checkout-failure");
    let workspace = slot.workspace().to_owned();
    let target = dir.path().join("sandbox");
    std::fs::create_dir(&target).unwrap();
    // A real partial checkout moves cow.img, then cannot remove the nonempty
    // source directory. The transaction must keep the target for later rollback.
    std::fs::write(workspace.join("leftover"), b"source still owns bytes").unwrap();
    let failed = match slot.checkout_to(&target) {
        Ok(_) => panic!("partial checkout unexpectedly succeeded"),
        Err(error) => error,
    };
    assert_eq!(std::fs::read(target.join("cow.img")).unwrap(), b"cow");
    let (completed, mut custody_finished) = oneshot::channel();
    let cleanup = failed.start_cleanup(Some(sandbox::SandboxCreateCustody::new(Arc::new(
        CustodyCompletion(Some(completed)),
    ))));
    tokio::time::timeout(Duration::from_secs(5), started)
        .await
        .unwrap()
        .unwrap();
    drop(cleanup);
    let retained_during_io = matches!(
        custody_finished.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    );
    let source_retained = workspace.exists();
    // Release and join the real blocking producer before reporting a failure.
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), removed)
            .await
            .unwrap()
            .unwrap(),
        workspace
    );
    if retained_during_io {
        tokio::time::timeout(Duration::from_secs(5), custody_finished)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(source_retained);
    assert!(!workspace.exists());
    assert_eq!(std::fs::read(target.join("cow.img")).unwrap(), b"cow");
    assert!(
        retained_during_io,
        "cancelled checkout cleanup must retain creation custody until physical IO finishes"
    );
}
