use super::*;

fn normalized_path(path: &str) -> PathBuf {
    normalize_path(Path::new(path))
}

fn task_at(path: &str) -> DownloadTask {
    DownloadTask::storage(
        format!("task {path}"),
        "file:///tmp/archive.tar.gz".to_owned(),
        path.to_owned(),
        false,
    )
}

fn prepared_task_at(path: &str) -> PreparedDownloadTask {
    PreparedDownloadTask {
        task: task_at(path),
        effective_mount_path: normalized_path(path),
    }
}

fn pending_at(id: usize, path: &str) -> PendingDownload {
    PendingDownload::new(id, prepared_task_at(path))
}

#[test]
fn mount_paths_conflict_for_exact_and_parent_child_paths() {
    assert!(mount_paths_conflict(
        &normalized_path("/tmp/mount"),
        &normalized_path("/tmp/mount")
    ));
    assert!(mount_paths_conflict(
        &normalized_path("/tmp/mount"),
        &normalized_path("/tmp/mount/child")
    ));
    assert!(mount_paths_conflict(
        &normalized_path("/tmp/mount/child"),
        &normalized_path("/tmp/mount")
    ));
}

#[test]
fn mount_paths_do_not_conflict_for_siblings_or_prefix_traps() {
    assert!(!mount_paths_conflict(
        &normalized_path("/tmp/mount-a"),
        &normalized_path("/tmp/mount-b")
    ));
    assert!(!mount_paths_conflict(
        &normalized_path("/tmp/foo/bar"),
        &normalized_path("/tmp/foo/barista")
    ));
}

#[test]
fn mount_path_conflicts_use_lexical_normalization() {
    assert!(mount_paths_conflict(
        &normalized_path("/tmp//foo/./bar/baz/.."),
        &normalized_path("/tmp/foo/bar")
    ));
    assert!(!mount_paths_conflict(
        &normalized_path("/tmp/foo/bar/../barista"),
        &normalized_path("/tmp/foo/bar")
    ));
}

#[test]
fn task_panic_releases_reservation_and_pending_tasks_finish() {
    guest_telemetry::log::clear_system_log_file();
    let directory = tempfile::tempdir().unwrap();

    fn runner(download: &mut StartedDownload) -> Result<(), DownloadError> {
        if download.task.task.url == "panic" {
            panic!("expected panic");
        }
        fs::write(
            download
                .task
                .effective_mount_path()
                .join(&download.task.task.url),
            &download.task.task.url,
        )
        .map_err(|error| DownloadError::new(error.to_string()))
    }

    // All tasks conflict, so the panic must release its reservation before
    // any of the more-than-four remaining tasks can produce their files.
    let tasks = (0..10)
        .map(|index| PreparedDownloadTask {
            task: DownloadTask::storage(
                format!("task-{index}"),
                if index == 0 {
                    "panic".to_owned()
                } else {
                    format!("file-{index}")
                },
                directory.path().to_str().unwrap().to_owned(),
                false,
            ),
            effective_mount_path: directory.path().to_owned(),
        })
        .collect();
    let result = std::panic::catch_unwind(|| download_all_parallel_with_runner(tasks, runner));

    assert!(matches!(result, Ok(false)));
    for index in 1..10 {
        let name = format!("file-{index}");
        assert_eq!(
            fs::read_to_string(directory.path().join(&name)).unwrap(),
            name
        );
    }
}

#[test]
fn find_startable_download_observes_conflict_and_selects_later_task() {
    let pending = VecDeque::from([
        pending_at(3, "/tmp/mount/child"),
        pending_at(4, "/tmp/other"),
    ]);
    let reservations = vec![DownloadReservation {
        id: 2,
        logical_mount_path: normalized_path("/tmp/mount"),
        effective_mount_path: normalized_path("/tmp/mount"),
    }];
    let mut conflicts = Vec::new();

    let selected = find_startable_download(
        &pending,
        &reservations,
        &mut |pending_id, _, active_id, _| {
            conflicts.push((pending_id, active_id));
        },
    );

    assert_eq!(conflicts, [(3, 2)]);
    assert_eq!(selected, Some((1, 4)));
}

#[test]
fn find_startable_download_reports_first_active_conflict_on_each_scan() {
    let pending = VecDeque::from([pending_at(4, "/tmp/mount/child")]);
    let reservations = vec![
        DownloadReservation {
            id: 2,
            logical_mount_path: normalized_path("/tmp/mount"),
            effective_mount_path: normalized_path("/tmp/mount"),
        },
        DownloadReservation {
            id: 3,
            logical_mount_path: normalized_path("/tmp/mount/child"),
            effective_mount_path: normalized_path("/tmp/mount/child"),
        },
    ];
    let mut conflicts = Vec::new();

    for _ in 0..2 {
        let selected = find_startable_download(
            &pending,
            &reservations,
            &mut |pending_id, _, active_id, _| {
                conflicts.push((pending_id, active_id));
            },
        );
        assert_eq!(selected, None);
    }

    assert_eq!(conflicts, [(4, 2), (4, 2)]);
}

#[test]
fn download_task_failure_detail_includes_entry_metadata() {
    let task = DownloadTask::storage(
            "storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false"
                .into(),
            "file:///tmp/archive.tar.gz".into(),
            "/workspace".into(),
            false,
        );
    let error = DownloadError::new("Failed to read archive entries: invalid gzip header");

    let detail = PreparedDownloadTask {
        task,
        effective_mount_path: PathBuf::from("/workspace"),
    }
    .failure_detail(&error);

    assert!(detail.contains("storage 1"));
    assert!(detail.contains("mountPath=/workspace"));
    assert!(detail.contains("vasStorageName=repo"));
    assert!(detail.contains("vasVersionId=v1"));
    assert!(detail.contains("urlScheme=file"));
    assert!(detail.contains("Failed to read archive entries"));
}
