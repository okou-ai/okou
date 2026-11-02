use super::*;
use std::task::Poll;
use tokio::sync::oneshot;

#[tokio::test]
async fn awakened_background_work_observes_a_resumed_clock() {
    let (armed, entered) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let task = tokio::spawn(async move {
        armed.send(()).unwrap();
        released.await.unwrap();
        // pause() rejects an already-paused clock. Awakened background
        // work must run only after the helper has resumed the runtime.
        time::pause();
        time::resume();
    });
    entered.await.unwrap();
    // Queue background work before advancing, so a yield while paused
    // exposes it even before the timer driver processes expired timers.
    release.send(()).unwrap();
    advance_timer_phase(Duration::from_secs(6)).await;
    time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn an_owned_deadline_remains_pending_until_its_full_budget() {
    let deadline = time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    poll_fn(|cx| {
        assert!(deadline.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    advance_timer_phase(Duration::from_secs(6)).await;
    poll_fn(|cx| {
        assert!(deadline.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    advance_timer_phase(Duration::from_secs(4)).await;
    deadline.await;
}
