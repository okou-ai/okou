use super::*;
use std::future::{Future, poll_fn};
use std::task::Poll;

#[tokio::test]
async fn dropped_delivery_keeps_publication_joined_by_runner_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let plan = fresh_storage_plan(
        "https://storage.example/publication.tar.gz".to_string(),
        "fresh-publication",
        "v1",
    );
    let group = group_targets(collect_targets(plan.cache_candidates()))
        .into_iter()
        .next()
        .unwrap();
    let cache_dir = home.storage_cache_dir("fresh-publication", "v1");
    let admission = FreshArchiveDeliveryAdmission::new();
    let permit = admission.try_reserve(1).unwrap();
    let bytes = Bytes::from_static(b"complete original archive");
    let expected = bytes.clone();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut delivery = FreshArchiveDelivery {
        cancel: CancellationToken::new(),
        phase_records: FreshArchivePhaseRecords::default(),
        classification: JoinSet::new(),
        groups: None,
        apply: Vec::new(),
        fetches: JoinSet::new(),
        publications: JoinSet::new(),
    };
    let destination = cache_dir.clone();
    delivery.publications.spawn(async move {
        entered_tx.send(()).unwrap();
        release_rx.await.unwrap();
        let result = write_to_cache(&destination, &bytes)
            .await
            .map(|()| FreshArchivePublished { bytes, permit });
        FreshArchivePublicationTaskResult { group, result }
    });
    entered_rx.await.unwrap();
    drop(delivery);

    let mut shutdown = Box::pin(admission.shutdown());
    poll_fn(|cx| {
        assert!(shutdown.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1,
    );
    assert!(matches!(
        admission.try_reserve(1),
        Err(TryAcquireError::Closed)
    ));
    assert!(!cache_dir.join("archive.tar.gz").exists());

    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .expect("runner shutdown must join the detached publication");
    assert_eq!(
        fs::read(cache_dir.join("archive.tar.gz")).await.unwrap(),
        expected,
    );
    assert!(!staging_dir(&cache_dir).exists());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    admission.shutdown().await;
}

#[tokio::test]
async fn grouped_reservation_keeps_each_split_joined_until_retired() {
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut group = admission.try_reserve(3).unwrap();
    let first = group.split(1).unwrap();
    let last = group.split(1).unwrap();
    drop(group);
    drop(first);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1
    );

    let mut shutdown = Box::pin(admission.shutdown());
    poll_fn(|cx| {
        assert!(shutdown.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(matches!(
        admission.try_reserve(1),
        Err(TryAcquireError::Closed)
    ));
    drop(last);
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .expect("every split must retain its own completion witness");
}
