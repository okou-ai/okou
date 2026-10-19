use super::super::*;
use super::support::*;
use crate::home_promotion::PreparedHomeImagePromotion;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::home_observation::{HomeObservationKind, HomeObservationOutcome};
use runner_storage::operation_test_support::RecordedHomeObservations;
use std::future::{Future as _, poll_fn};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};
use tokio_util::task::TaskTracker;

async fn wait_for_admission(cache: &HomeImageCache, count: u32) {
    tokio::time::timeout(
        Duration::from_secs(5),
        cache
            .inner
            .publication_admission_entered
            .acquire_many(count),
    )
    .await
    .expect("publishers must reach admission")
    .unwrap()
    .forget();
}

async fn publication_burst(real_hold: bool) -> usize {
    const COUNT: u32 = 24;
    let mut f = Fixture::new().await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
    let held = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    f.cache.publication_io_held_test_gate = Some((Arc::clone(&held), Arc::clone(&release)));
    let mut contexts = Vec::new();
    let mut originals = Vec::new();
    for index in 0..COUNT {
        let key = format!("burst-{index}");
        let context = f
            .context(
                &key,
                key.as_bytes(),
                "2026-10-15T08:00:00Z",
                HomeCacheTerminalStatus::Success,
                StorageFingerprints::default(),
            )
            .await;
        originals.push((
            key,
            tokio::fs::read(f.paths.active_home_image(&context.sandbox_id()))
                .await
                .unwrap(),
        ));
        contexts.push(context);
        // Only the first clone pauses after acquiring the real IO permit.
        f.cache.publication_io_held_test_gate = None;
    }
    let tracker = TaskTracker::new();
    let published = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for (index, context) in contexts.into_iter().enumerate() {
        let published = Arc::clone(&published);
        // Dropping the result observer must not remove accepted publication from
        // the same TaskTracker ownership used by cleanup and shutdown.
        drop(tracker.spawn(async move {
            if PreparedHomeImagePromotion::required(context, "publication_burst")
                .publish()
                .await
            {
                published.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }));
        if index == 0 {
            tokio::time::timeout(Duration::from_secs(5), held.notified())
                .await
                .expect("first publisher must own IO admission");
        }
    }
    wait_for_admission(&f.cache, COUNT).await;
    tracker.close();
    let mut joined = Box::pin(tracker.wait());
    poll_fn(|task| {
        assert!(joined.as_mut().poll(task).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    if real_hold {
        // Descriptive, explicitly ignored baseline/candidate workload. This
        // controlled hold is not a production duration or a latency assertion.
        tokio::time::sleep(Duration::from_secs(1)).await;
    } else {
        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(300)).await;
        tokio::time::resume();
    }
    release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(10), joined)
        .await
        .expect("shutdown must join every accepted publisher");

    let committed = published.load(std::sync::atomic::Ordering::SeqCst);
    let observations = recorded.events();
    let publications: Vec<_> = observations
        .iter()
        .filter(|event| event.kind == HomeObservationKind::Publication)
        .collect();
    assert_eq!(publications.len(), COUNT as usize);
    assert_eq!(
        publications
            .iter()
            .filter(|event| event.outcome == HomeObservationOutcome::Published)
            .count(),
        committed
    );
    let admission_timeout = publications
        .iter()
        .filter(|event| event.reason.as_deref() == Some("publication_admission_timeout"))
        .count();
    let mut readable = 0;
    for (key, original) in originals {
        let mut lease = f.lease(&key).await;
        if lease.result() != HomeCacheCheckoutResult::Hit {
            continue;
        }
        let Some(sandbox::HomeDriveSeedImage::Move(seed)) =
            lease.home_drive_config().await.unwrap().unwrap().seed_image
        else {
            panic!("committed burst image must be consumable");
        };
        assert_eq!(tokio::fs::read(seed).await.unwrap(), original);
        readable += 1;
    }
    assert_eq!(readable, committed);
    println!(
        "publication burst: candidates={COUNT} committed={committed} readable={readable} admission_timeout={admission_timeout} refused={}",
        COUNT as usize - committed
    );
    readable
}

#[tokio::test]
async fn stopped_publication_burst_survives_io_hold_and_joins_after_observer_loss() {
    assert_eq!(publication_burst(false).await, 24);
}

#[tokio::test]
#[ignore = "descriptive controlled real-time baseline/candidate comparison"]
async fn measure_stopped_publication_burst() {
    assert_eq!(publication_burst(true).await, 24);
}

#[tokio::test]
async fn admission_timeout_preserves_required_context_and_reports_its_own_reason() {
    let mut f = Fixture::new().await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
    let context = f
        .context(
            "required",
            b"retained-home",
            "2026-10-15T08:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let active = f.paths.active_home_image(&context.sandbox_id());
    let original = tokio::fs::read(&active).await.unwrap();
    let paths = f.cache.entry_paths(&f.key("required"));
    let staging = paths.tmp_image(context.run_id());
    let required = PreparedHomeImagePromotion::required(context, "admission_timeout");
    let permit = f
        .cache
        .inner
        .publication_admission
        .acquire_many(4)
        .await
        .unwrap();
    let mut publication = Box::pin(required.publish_required());
    tokio::select! {
        result = publication.as_mut() => panic!("publication passed blocked admission: {result:?}"),
        () = wait_for_admission(&f.cache, 1) => {}
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    assert!(publication.await.is_err());
    tokio::time::resume();
    let publications: Vec<_> = recorded
        .events()
        .into_iter()
        .filter(|event| event.kind == HomeObservationKind::Publication)
        .collect();
    assert_eq!(publications.len(), 1);
    assert_eq!(publications[0].outcome, HomeObservationOutcome::Skipped);
    assert_eq!(
        publications[0].reason.as_deref(),
        Some("publication_admission_timeout")
    );
    assert_eq!(tokio::fs::read(&active).await.unwrap(), original);
    assert!(!paths.metadata().exists());
    assert!(!staging.exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.entry_lock_path(&f.key("required")))
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    drop(permit);
    assert!(required.publish_required().await.unwrap());
    drop(required);
    assert_eq!(
        f.lease("required").await.result(),
        HomeCacheCheckoutResult::Hit
    );
}

#[tokio::test]
async fn cancelled_admission_keeps_entry_and_bytes_without_blocking_other_checkout() {
    let f = Fixture::new().await;
    f.commit("other", b"other-home", "2026-10-15T08:00:00Z")
        .await;
    wait_for_admission(&f.cache, 1).await;
    let context = f
        .context(
            "waiting",
            b"owned-home",
            "2026-10-15T08:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let active = f.paths.active_home_image(&context.sandbox_id());
    let original = tokio::fs::read(&active).await.unwrap();
    let permit = f
        .cache
        .inner
        .publication_admission
        .acquire_many(4)
        .await
        .unwrap();
    let mut publication = Box::pin(context.promote());
    tokio::select! {
        result = publication.as_mut() => panic!("publication passed blocked admission: {result:?}"),
        () = wait_for_admission(&f.cache, 1) => {}
    }
    assert_eq!(
        f.lease("waiting").await.result(),
        HomeCacheCheckoutResult::LockBusy
    );
    assert_eq!(
        f.lease("other").await.result(),
        HomeCacheCheckoutResult::Hit
    );
    drop(publication);
    assert_eq!(tokio::fs::read(&active).await.unwrap(), original);
    assert!(!f.cache.entry_paths(&f.key("waiting")).metadata().exists());
    drop(permit);
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(context);
    let mut lease = f.lease("waiting").await;
    let Some(sandbox::HomeDriveSeedImage::Move(seed)) =
        lease.home_drive_config().await.unwrap().unwrap().seed_image
    else {
        panic!("cancelled admission must remain retryable with intact bytes");
    };
    assert_eq!(tokio::fs::read(seed).await.unwrap(), original);
}
