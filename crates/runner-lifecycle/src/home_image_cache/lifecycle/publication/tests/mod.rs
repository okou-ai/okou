use super::*;
use std::future::{Future as _, poll_fn};
use std::task::Poll;

async fn queued_admission_deadline(io_slots: u32) {
    let dir = tempfile::tempdir().unwrap();
    let cache = HomeImageCache::new(runner_host::paths::RunnerPaths::new(dir.path().to_owned()));
    for (elapsed, release_before_poll, admitted) in [
        (29, true, true),
        (30, true, false),
        (31, true, false),
        (31, false, false),
    ] {
        let mut held = Some(
            cache
                .inner
                .publication_admission
                .acquire_many(HOME_PUBLICATION_IO_SLOTS as u32)
                .await
                .unwrap(),
        );
        let deadline = Instant::now() + HOME_IMAGE_PUBLICATION_ADMISSION_TIMEOUT;
        let mut admission = std::pin::pin!(cache.publication_admission(deadline, io_slots));
        poll_fn(|cx| {
            assert!(admission.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;

        // Keep this same queued future unpolled until both the deadline and
        // permit readiness have been set explicitly.
        tokio::time::advance(Duration::from_secs(elapsed)).await;
        if release_before_poll {
            drop(held.take());
        }
        let result = poll_fn(|cx| match admission.as_mut().poll(cx) {
            Poll::Ready(result) => Poll::Ready(result.unwrap()),
            Poll::Pending => panic!("admission must decide at the controlled instant"),
        })
        .await;
        assert_eq!(
            result.is_some(),
            admitted,
            "slots={io_slots}, elapsed={elapsed}, released={release_before_poll}"
        );
        drop(result);
        drop(held);
        assert_eq!(
            cache.inner.publication_admission.available_permits(),
            HOME_PUBLICATION_IO_SLOTS
        );
    }
}

#[tokio::test(start_paused = true)]
async fn queued_single_slot_admission_rechecks_its_deadline() {
    queued_admission_deadline(1).await;
}

#[tokio::test(start_paused = true)]
async fn queued_all_slots_admission_rechecks_its_deadline() {
    queued_admission_deadline(HOME_PUBLICATION_IO_SLOTS as u32).await;
}
