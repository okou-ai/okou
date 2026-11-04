use super::*;

#[tokio::test]
async fn pooled_finalizer_starts_before_returned_future_is_polled() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();

    let finalizer = run_finalizer(async move {
        let _ = started_tx.send(());
        finish_rx.await.map_err(|e| {
            error::NbdCowError::Io(std::io::Error::other(format!(
                "test finalizer release dropped: {e}"
            )))
        })?;
        let _ = done_tx.send(());
        Ok::<(), error::NbdCowError>(())
    });

    started_rx.await.unwrap();
    drop(finalizer);
    finish_tx.send(()).unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
#[should_panic(expected = "pooled finalizer panic")]
async fn pooled_finalizer_propagates_panic_when_awaited() {
    let finalizer =
        run_finalizer::<(), error::NbdCowError>(async move { panic!("pooled finalizer panic") });

    let _ = finalizer.await;
}
