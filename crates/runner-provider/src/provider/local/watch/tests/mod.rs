use super::*;

fn watcher(path: &Path, kind: QueueFileKind) -> LocalQueueWatcher {
    let mut watcher = LocalQueueWatcher::new(vec![path.to_path_buf()], kind).unwrap();
    watcher.reconcile().unwrap();
    watcher
}

fn kernel_watch_count(watcher: &LocalQueueWatcher) -> usize {
    std::fs::read_to_string(format!("/proc/self/fdinfo/{}", watcher.inotify.as_raw_fd()))
        .unwrap()
        .lines()
        .filter(|line| line.starts_with("inotify wd:"))
        .count()
}

#[tokio::test]
async fn job_watcher_ignores_temporary_file_until_final_rename() {
    let dir = tempfile::tempdir().unwrap();
    let mut watcher = watcher(dir.path(), QueueFileKind::Job);
    let temporary_path = dir.path().join("run.job.tmp");
    let job_path = dir.path().join("run.job");
    std::fs::write(&temporary_path, b"job").unwrap();
    std::fs::write(dir.path().join("noise.txt"), b"noise").unwrap();

    let mut next_change = Box::pin(watcher.next_change());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut next_change)
            .await
            .is_err(),
        "temporary and unrelated files must not wake job discovery"
    );

    std::fs::rename(temporary_path, job_path).unwrap();
    tokio::time::timeout(Duration::from_secs(2), &mut next_change)
        .await
        .expect("final job rename should wake watcher")
        .unwrap();
}

#[tokio::test]
async fn cancel_watcher_reports_close_written_marker() {
    let dir = tempfile::tempdir().unwrap();
    let mut watcher = watcher(dir.path(), QueueFileKind::Cancel);

    std::fs::write(dir.path().join("run.cancel"), b"").unwrap();

    tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
        .await
        .expect("closed cancel marker should wake watcher")
        .unwrap();
}

#[tokio::test]
async fn invalidated_directory_can_be_reconciled_after_recreation() {
    let root = tempfile::tempdir().unwrap();
    let watched_dir = root.path().join("jobs");
    std::fs::create_dir(&watched_dir).unwrap();
    let mut watcher = watcher(&watched_dir, QueueFileKind::Job);

    std::fs::remove_dir(&watched_dir).unwrap();
    tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
        .await
        .expect("directory invalidation should request reconciliation")
        .unwrap();
    watcher.reconcile().unwrap();

    std::fs::create_dir(&watched_dir).unwrap();
    watcher.reconcile().unwrap();
    std::fs::write(watched_dir.join("run.job"), b"job").unwrap();

    tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
        .await
        .expect("recreated directory should be watched again")
        .unwrap();
}

#[tokio::test]
async fn moved_directories_retire_kernel_watches_before_reconciliation() {
    let root = tempfile::tempdir().unwrap();
    let watched_dir = root.path().join("jobs");
    let other_dir = root.path().join("other-jobs");
    std::fs::create_dir(&watched_dir).unwrap();
    std::fs::create_dir(&other_dir).unwrap();
    let mut watcher = LocalQueueWatcher::new(
        vec![watched_dir.clone(), other_dir.clone()],
        QueueFileKind::Job,
    )
    .unwrap();
    watcher.reconcile().unwrap();
    assert_eq!(kernel_watch_count(&watcher), 2);

    for cycle in 0..8 {
        let retired_dir = root.path().join(format!("retired-{cycle}"));
        std::fs::rename(&watched_dir, &retired_dir).unwrap();
        tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
            .await
            .expect("directory move should request reconciliation")
            .unwrap();
        assert_eq!(
            kernel_watch_count(&watcher),
            1,
            "moved inode must lose its watch while the other watch stays live"
        );

        std::fs::create_dir(&watched_dir).unwrap();
        watcher.reconcile().unwrap();
        assert_eq!(kernel_watch_count(&watcher), 2);

        // rm_watch queues IN_IGNORED. Wait for actual readiness before
        // checking that next_change drains it and waits for a live event.
        tokio::time::timeout(Duration::from_secs(2), watcher.inotify.readable())
            .await
            .expect("watch retirement should queue IN_IGNORED")
            .unwrap()
            .retain_ready();
        assert!(futures_util::poll!(std::pin::pin!(watcher.next_change())).is_pending());

        std::fs::write(retired_dir.join("retired.job"), b"job").unwrap();
        std::fs::rename(&retired_dir, root.path().join(format!("kept-{cycle}"))).unwrap();
        assert!(matches!(
            watcher.inotify.get_ref().0.read_events(),
            Err(Errno::EAGAIN)
        ));

        std::fs::write(watched_dir.join("replacement.job"), b"job").unwrap();
        tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
            .await
            .expect("replacement directory publication should wake watcher")
            .unwrap();
    }

    std::fs::write(other_dir.join("unaffected.job"), b"job").unwrap();
    tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
        .await
        .expect("unaffected directory publication should wake watcher")
        .unwrap();
}
