use super::*;

#[cfg(unix)]
#[tokio::test]
async fn dir_stats_does_not_recurse_through_symlinked_child_dir() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let normal_child = root.join("normal");
    let nested_child = normal_child.join("nested");
    std::fs::create_dir_all(&nested_child).unwrap();
    let direct_file = root.join("direct.bin");
    let normal_file = normal_child.join("inside.bin");
    let nested_file = nested_child.join("nested.bin");
    std::fs::write(&direct_file, vec![1u8; 4096]).unwrap();
    std::fs::write(&normal_file, vec![2u8; 8192]).unwrap();
    std::fs::write(&nested_file, vec![3u8; 16384]).unwrap();
    let descendants = [
        normal_child,
        nested_child,
        direct_file,
        normal_file,
        nested_file,
    ];
    let expected_bytes = || {
        descendants
            .iter()
            .map(|path| std::fs::symlink_metadata(path).unwrap().blocks() * 512)
            .sum::<u64>()
    };

    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("outside.bin"), vec![2u8; 1024 * 1024]).unwrap();
    let link = root.join("linked");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let symlink_bytes = std::fs::symlink_metadata(&link).unwrap().blocks() * 512;

    let (with_symlink, _) = dir_stats(&root).await;
    assert_eq!(
        with_symlink,
        expected_bytes() + symlink_bytes,
        "dir_stats should count every ordinary descendant and the symlink entry, excluding the root and symlink target"
    );
    std::fs::remove_file(&link).unwrap();
    let (without_symlink, _) = dir_stats(&root).await;
    assert_eq!(
        without_symlink,
        expected_bytes(),
        "dir_stats should count every ordinary descendant after removing the symlink"
    );

    assert_eq!(
        with_symlink,
        without_symlink + symlink_bytes,
        "dir_stats should count the symlink itself but not recurse into its target"
    );
}

#[tokio::test]
async fn collect_dir_stats_withholds_root_metadata_after_incomplete_walk() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("archive.tar.gz"), vec![1u8; 4096]).unwrap();
    let entry_reader = DirStatsEntryReader::after_entry(|| {
        Err(std::io::Error::other(
            "injected directory iteration failure",
        ))
    });

    let stats = collect_dir_stats_with_reader(&root, entry_reader, None).await;

    assert!(stats.root_metadata.is_none());
}

#[tokio::test]
async fn collect_dir_stats_submits_one_blocking_task_for_high_entry_tree() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    const DIRECTORY_COUNT: usize = 8;
    const FILES_PER_DIRECTORY: usize = 128;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let mut expected_bytes = 0u64;
    let contents = [1u8; 4096];
    for directory_index in 0..DIRECTORY_COUNT {
        let child = root.join(format!("dir-{directory_index}"));
        std::fs::create_dir_all(&child).unwrap();
        for file_index in 0..FILES_PER_DIRECTORY {
            let file = child.join(format!("file-{file_index}"));
            std::fs::write(&file, contents).unwrap();
            expected_bytes += std::fs::symlink_metadata(&file).unwrap().blocks() * 512;
        }
        expected_bytes += std::fs::symlink_metadata(&child).unwrap().blocks() * 512;
    }
    let expected_mtime = std::fs::symlink_metadata(&root)
        .unwrap()
        .modified()
        .unwrap();
    let task_submissions = AtomicUsize::new(0);

    let stats =
        collect_dir_stats_with_reader(&root, DirStatsEntryReader::new(), Some(&task_submissions))
            .await;

    assert_eq!(
        stats.size, expected_bytes,
        "collect_dir_stats should count every file and descendant directory, excluding the root"
    );
    assert_eq!(task_submissions.load(Ordering::Relaxed), 1);
    assert_eq!(stats.mtime, expected_mtime);
    assert!(stats.root_metadata.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_collect_dir_stats_stops_the_blocking_walk() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    struct Completion {
        entry_count: Arc<AtomicUsize>,
        finished: mpsc::Sender<usize>,
    }

    impl Drop for Completion {
        fn drop(&mut self) {
            let _ = self.finished.send(self.entry_count.load(Ordering::Relaxed));
        }
    }

    const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("first.bin"), vec![1u8; 4096]).unwrap();
    std::fs::write(root.join("second.bin"), vec![2u8; 4096]).unwrap();

    let (reached_tx, reached_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let entry_count = Arc::new(AtomicUsize::new(0));
    let observed_entry_count = Arc::clone(&entry_count);
    let completion = Completion {
        entry_count,
        finished: finished_tx,
    };
    let mut pause = Some((reached_tx, resume_rx));
    let entry_reader = DirStatsEntryReader::after_entry(move || {
        let _completion = &completion;
        if observed_entry_count.fetch_add(1, Ordering::Relaxed) == 0
            && let Some((reached, resume)) = pause.take()
        {
            reached.send(()).unwrap();
            resume.recv().unwrap();
        }
        Ok(())
    });
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        collect_dir_stats_with_cancel(&root, entry_reader, task_cancel, None).await
    });

    reached_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert!(cancel.is_cancelled());
    resume_tx.send(()).unwrap();
    assert_eq!(finished_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 1);
}
