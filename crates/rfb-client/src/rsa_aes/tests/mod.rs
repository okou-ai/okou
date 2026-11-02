use super::*;
use std::{sync::mpsc, time::Duration};
use tokio::sync::oneshot;

#[tokio::test]
async fn cancelled_waiters_do_not_release_running_crypto_job_capacity() {
    // Native task lifetime has no public socket observation once its waiter
    // is cancelled. Real blocking jobs use explicit test-owned completion gates.
    let (release_first, wait_first) = mpsc::channel();
    let (entered_first, started_first) = oneshot::channel();
    let first = tokio::spawn(crypto(move || {
        entered_first
            .send(())
            .map_err(|_| Error::InvalidRsaAesExchange)?;
        wait_first
            .recv()
            .map_err(|_| Error::InvalidRsaAesExchange)?;
        Ok(())
    }));
    let (release_second, wait_second) = mpsc::channel();
    let (entered_second, started_second) = oneshot::channel();
    let second = tokio::spawn(crypto(move || {
        entered_second
            .send(())
            .map_err(|_| Error::InvalidRsaAesExchange)?;
        wait_second
            .recv()
            .map_err(|_| Error::InvalidRsaAesExchange)?;
        Ok(())
    }));
    started_first.await.unwrap();
    started_second.await.unwrap();
    first.abort();
    second.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert!(second.await.unwrap_err().is_cancelled());
    assert!(matches!(crypto(|| Ok(())).await, Err(Error::ResourceLimit)));
    release_first.send(()).unwrap();
    release_second.send(()).unwrap();
    // Acquisition waits for actual native permit teardown, not elapsed time
    // or the already-cancelled async JoinHandles.
    let permits = tokio::time::timeout(Duration::from_secs(5), CRYPTO.acquire_many(2))
        .await
        .unwrap()
        .unwrap();
    drop(permits);
    assert!(crypto(|| Ok(())).await.is_ok());
}
