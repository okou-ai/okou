use super::*;
use crate::SandboxOpReporter;

#[tokio::test]
async fn committed_memory_download_leaves_foreground_writer_available() {
    for foreground_wins in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let version = "committed-version";
        let content = b"complete committed memory archive";
        let mut server = gated_archive_server(content.to_vec(), 1).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
        let (reports, mut observations) = tokio::sync::mpsc::unbounded_channel();
        let reporter = SandboxOpReporter::new(move |records| {
            let _ = reports.send(records);
            std::future::ready(())
        });
        coordinator.warm_committed_memory(
            home.clone(),
            version,
            &server.url,
            content.len() as u64,
            reporter,
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let cache_dir = home.storage_cache_dir("memory", version);
        let archive = cache_dir.join("archive.tar.gz");
        assert!(!archive.exists());
        let lock::TryLock::Acquired(writer) =
            lock::try_acquire_or_busy(home.storage_lock("memory", version))
                .await
                .unwrap()
        else {
            panic!("the pending warm fetch must leave the foreground writer available");
        };
        let expected = if foreground_wins {
            let winner = b"archive already published by the foreground writer";
            write_to_cache(&cache_dir, winner).await.unwrap();
            winner.as_slice()
        } else {
            content.as_slice()
        };
        drop(writer);
        server.release.add_permits(1);

        let records = tokio::time::timeout(Duration::from_secs(5), observations.recv())
            .await
            .unwrap()
            .unwrap();
        assert_background_op(
            &records,
            if foreground_wins {
                STORAGE_CACHE_BACKGROUND_FILL_SKIPPED
            } else {
                "storage_cache_committed_memory_warm_published"
            },
            true,
        );
        assert_eq!(fs::read(archive).await.unwrap(), expected);
        assert!(!staging_dir(&cache_dir).exists());
        coordinator.shutdown().await;
        server.task.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn committed_memory_warming_skips_invalid_size_and_resident_versions() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let resident = home.storage_cache_dir("memory", "resident");
    let body = b"complete archive bytes";
    write_to_cache(&resident, body).await.unwrap();
    let (url, server) = raw_http_url(http_response("200 OK", body)).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    let (reports, mut observations) = tokio::sync::mpsc::unbounded_channel();
    let reporter = SandboxOpReporter::new(move |records| {
        let _ = reports.send(records);
        std::future::ready(())
    });
    // The resident version leaves the fixture's sole GET for the mismatched
    // download. Neither case can replace a published archive.
    coordinator.warm_committed_memory(
        home.clone(),
        "resident",
        &url,
        body.len() as u64,
        reporter.clone(),
    );
    let skipped = tokio::time::timeout(Duration::from_secs(5), observations.recv())
        .await
        .unwrap()
        .unwrap();
    assert_background_op(&skipped, STORAGE_CACHE_BACKGROUND_FILL_SKIPPED, true);
    coordinator.warm_committed_memory(
        home.clone(),
        "mismatched",
        &url,
        body.len() as u64 + 1,
        reporter,
    );
    let unavailable = tokio::time::timeout(Duration::from_secs(5), observations.recv())
        .await
        .unwrap()
        .unwrap();
    assert_background_op(
        &unavailable,
        STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE,
        true,
    );
    assert_eq!(
        fs::read(resident.join("archive.tar.gz")).await.unwrap(),
        body
    );
    assert!(!home.storage_cache_dir("memory", "mismatched").exists());
    coordinator.shutdown().await;
    await_raw_http_sequence(server).await;
}
