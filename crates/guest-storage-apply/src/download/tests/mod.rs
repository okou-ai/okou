use super::*;

#[test]
fn download_concurrency_scales_with_remote_batch_size() {
    assert_eq!(download_concurrency(0, 2), 2);
    assert_eq!(download_concurrency(0, 128), 4);
    assert_eq!(download_concurrency(17, 128), 16);
    assert_eq!(download_concurrency(32, 128), 16);
    assert_eq!(download_concurrency(33, 128), 17);
    assert_eq!(download_concurrency(34, 39), 17);
    assert_eq!(download_concurrency(38, 128), 19);
    assert_eq!(download_concurrency(39, 128), 20);
    assert_eq!(download_concurrency(41, 128), 20);
    assert_eq!(download_concurrency(63, 128), 20);
    assert_eq!(download_concurrency(64, 128), 24);
    assert_eq!(download_concurrency(95, 128), 24);
    assert_eq!(download_concurrency(96, 128), 32);
    assert_eq!(download_concurrency(97, 128), 33);
    assert_eq!(download_concurrency(110, 115), 37);
    assert_eq!(download_concurrency(117, 128), 39);
    assert_eq!(download_concurrency(118, 128), 40);
    assert_eq!(download_concurrency(120, 128), 40);
    assert_eq!(download_concurrency(121, 128), 40);
    assert_eq!(download_concurrency(149, 195), 40);
    assert_eq!(download_concurrency(160, 160), 40);
    assert_eq!(download_concurrency(161, 200), 40);
}

fn normalized_path(path: &str) -> PathBuf {
    normalize_path(Path::new(path))
}

fn task_at(path: &str) -> DownloadTask<'static> {
    DownloadTask::storage(
        format!("task {path}"),
        "file:///tmp/archive.tar.gz".to_owned(),
        path.to_owned(),
        false,
    )
}

fn prepared_task_at(path: &str) -> PreparedDownloadTask<'static> {
    PreparedDownloadTask {
        source_ready: None,
        task: task_at(path),
        effective_mount_path: normalized_path(path),
    }
}

fn pending_at(id: usize, path: &str) -> PendingDownload<'static> {
    PendingDownload::new(id, prepared_task_at(path))
}

#[cfg(target_os = "linux")]
#[test]
fn scheduler_limits_parallel_inflate_to_a_single_artifact_with_a_small_companion() {
    use guest_contracts::storage_files::StorageFile;

    enum Companion {
        Archive(u64),
        Decoded(usize, &'static [u8]),
        Artifact,
    }

    for (companion, local_ready, expected) in [
        (Companion::Archive(64 * 1024 - 1), true, Some(1)),
        (Companion::Archive(64 * 1024), true, None),
        (Companion::Archive(0), true, None),
        (Companion::Decoded(1, &[0; 64 * 1024]), true, Some(1)),
        (Companion::Decoded(1, &[0; 64 * 1024 + 1]), true, None),
        (Companion::Decoded(17, &[]), true, None),
        (Companion::Artifact, true, None),
        (Companion::Archive(1), false, None),
    ] {
        let mut artifact = pending_at(1, "/artifact");
        artifact.task.task = DownloadTask::artifact(
            "artifact".into(),
            "file:///tmp/artifact.tar.gz".into(),
            "/artifact".into(),
        );
        artifact.estimated_work = 2 * 1024 * 1024;

        let mut other = pending_at(0, "/companion");
        match companion {
            Companion::Archive(bytes) => other.estimated_work = bytes,
            Companion::Decoded(count, content) => {
                other.task.task.set_files(
                    (0..count)
                        .map(|index| StorageFile {
                            path: format!("file-{index}"),
                            mode: 0o644,
                            mtime: 1,
                            content,
                        })
                        .collect(),
                );
            }
            Companion::Artifact => {
                other.task.task = DownloadTask::artifact(
                    "other artifact".into(),
                    "file:///tmp/companion.tar.gz".into(),
                    "/companion".into(),
                );
                other.estimated_work = 32 * 1024;
            }
        }
        let pending = VecDeque::from([other, artifact]);
        let mut telemetry = DownloadRunTelemetry::start(
            pending.iter().map(|download| {
                (
                    download.task.task.telemetry,
                    download.task.logical_mount_path(),
                )
            }),
            true,
        );
        let mut scheduler = DownloadScheduler::new(pending, 2, local_ready, true);
        let (send, receive) = mpsc::sync_channel(2);
        assert!(scheduler.start_ready_attempts(&send, &mut telemetry));
        let inflaters = (0..2)
            .filter_map(|_| {
                let download = receive.try_recv().unwrap();
                matches!(
                    download.inflate_load,
                    Some(archive::inflate::InflateLoad::Light)
                )
                .then_some(download.id)
            })
            .collect::<Vec<_>>();
        assert_eq!(inflaters, expected.into_iter().collect::<Vec<_>>());
        telemetry.finish();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn scheduler_limits_wide_read_ahead_to_the_first_promoted_local_artifact() {
    for (count, local_ready, artifact_is_largest, expected) in [
        (32, true, false, Some(9)),
        (32, true, true, Some(9)),
        (31, true, false, None),
        (40, false, false, None),
    ] {
        let pending: VecDeque<_> = (0..count)
            .map(|id| {
                let path = format!("/independent-{id}");
                let mut download = pending_at(id, &path);
                if matches!(id, 9 | 17) {
                    download.task.task = DownloadTask::artifact(
                        path.clone(),
                        "file:///tmp/artifact.tar.gz".into(),
                        path,
                    );
                    download.estimated_work = if id == 9 { 700_000 } else { 500_000 };
                } else if id == 2 {
                    download.estimated_work = if artifact_is_largest {
                        600_000
                    } else {
                        900_000
                    };
                }
                download
            })
            .collect();
        let mut telemetry = DownloadRunTelemetry::start(
            pending.iter().map(|download| {
                (
                    download.task.task.telemetry,
                    download.task.logical_mount_path(),
                )
            }),
            true,
        );
        let mut scheduler = DownloadScheduler::new(pending, LOCAL_CONCURRENT, local_ready, true);
        let (send, receive) = mpsc::sync_channel(LOCAL_CONCURRENT);
        let mut inflaters = Vec::new();
        while scheduler.has_work() {
            assert!(scheduler.start_ready_attempts(&send, &mut telemetry));
            assert!(scheduler.can_make_progress());
            while let Ok(download) = receive.try_recv() {
                if let Some(load) = download.inflate_load {
                    assert!(matches!(load, archive::inflate::InflateLoad::WideBatch));
                    inflaters.push(download.id);
                }
                scheduler.record_completion(DownloadCompletion {
                    download,
                    outcome: AttemptOutcome::Finished(Ok(())),
                });
            }
        }
        assert_eq!(inflaters, expected.into_iter().collect::<Vec<_>>());
        telemetry.finish();
    }
}

#[test]
fn scheduler_front_loads_one_archive_then_dispatches_original_order() {
    let pending = [1, 90, 10, 100, 80, 20]
        .into_iter()
        .enumerate()
        .map(|(id, hint)| {
            let mut download = pending_at(id, &format!("/independent-{id}"));
            download.estimated_work = hint;
            download
        })
        .collect::<VecDeque<_>>();
    let mut telemetry = DownloadRunTelemetry::start(
        pending.iter().map(|download| {
            (
                download.task.task.telemetry,
                download.task.logical_mount_path(),
            )
        }),
        true,
    );
    let mut scheduler = DownloadScheduler::new(pending, 4, true, true);
    let (send, receive) = mpsc::sync_channel(4);
    assert!(scheduler.start_ready_attempts(&send, &mut telemetry));
    let first = (0..4)
        .map(|_| receive.try_recv().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        first.iter().map(|task| task.id).collect::<Vec<_>>(),
        [3, 0, 1, 2]
    );
    for download in first {
        scheduler.record_completion(DownloadCompletion {
            download,
            outcome: AttemptOutcome::Finished(Ok(())),
        });
    }
    assert!(scheduler.start_ready_attempts(&send, &mut telemetry));
    for expected in [4, 5] {
        let download = receive.try_recv().unwrap();
        assert_eq!(download.id, expected);
        scheduler.record_completion(DownloadCompletion {
            download,
            outcome: AttemptOutcome::Finished(Ok(())),
        });
    }
    assert!(!scheduler.has_work());
    telemetry.finish();
}

#[test]
fn local_scheduler_starts_one_ready_artifact_alongside_the_largest_archive() {
    for (artifact_path, artifact_bytes, allow_priority, expected) in [
        ("/artifact", 512 * 1024, true, [3, 5, 0, 1]),
        ("/artifact", 2 * 1024 * 1024, true, [5, 0, 1, 2]),
        ("/artifact", 512 * 1024, false, [3, 0, 1, 2]),
        ("/ordinary-0/child", 512 * 1024, true, [3, 0, 1, 2]),
    ] {
        let mut pending = (0..5)
            .map(|id| pending_at(id, &format!("/ordinary-{id}")))
            .collect::<VecDeque<_>>();
        pending[3].estimated_work = 1024 * 1024;
        let mut artifact = pending_at(5, artifact_path);
        artifact.task.task = DownloadTask::artifact(
            "artifact".into(),
            "file:///tmp/artifact.tar.gz".into(),
            artifact_path.into(),
        );
        artifact.estimated_work = artifact_bytes;
        pending.push_back(artifact);
        let mut telemetry = DownloadRunTelemetry::start(
            pending.iter().map(|download| {
                (
                    download.task.task.telemetry,
                    download.task.logical_mount_path(),
                )
            }),
            false,
        );
        let mut scheduler = DownloadScheduler::new(pending, 4, allow_priority, false);
        let (send, receive) = mpsc::sync_channel(4);

        assert!(scheduler.start_ready_attempts(&send, &mut telemetry));
        assert_eq!(
            (0..4)
                .map(|_| receive.try_recv().unwrap().id)
                .collect::<Vec<_>>(),
            expected
        );
        telemetry.finish();
    }
}

#[test]
fn ready_archive_priority_preserves_fifo_ties_and_source_gates() {
    for (hints, gated, prioritize_large, expected) in [
        ([0, 0, 0], false, true, 0),
        ([100, 100, 100], false, true, 0),
        ([1, 100, 10], false, true, 1),
        ([1, 100, 10], true, true, 2),
        ([1, 100, 10], false, false, 0),
        ([1, 100, 10], true, false, 0),
    ] {
        let pending = hints
            .into_iter()
            .enumerate()
            .map(|(id, hint)| {
                let mut download = pending_at(id, &format!("/independent-{id}"));
                download.estimated_work = hint;
                if gated && id == 1 {
                    download.task.source_ready = Some(Arc::new(AtomicBool::new(false)));
                }
                download
            })
            .collect();
        assert_eq!(
            find_startable_download(
                &pending,
                None,
                if prioritize_large {
                    DownloadSelection::Largest
                } else {
                    DownloadSelection::Fifo
                },
                &mut |_, _, _, _| {},
            ),
            Some((expected, expected))
        );
    }
}

#[test]
fn large_archive_priority_respects_logical_and_physical_reservations() {
    for physical_alias in [false, true] {
        let first = pending_at(0, "/independent");
        let mut large = pending_at(
            1,
            if physical_alias {
                "/alias"
            } else {
                "/data/child"
            },
        );
        large.estimated_work = 100;
        if physical_alias {
            large.task.effective_mount_path = normalized_path("/data/child");
        }
        let reservations = [DownloadReservation {
            id: 2,
            logical_mount_path: normalized_path("/data"),
            effective_mount_path: normalized_path("/data"),
        }];
        assert_eq!(
            find_startable_download(
                &VecDeque::from([first, large]),
                Some(&reservations),
                DownloadSelection::Largest,
                &mut |_, _, _, _| {},
            ),
            Some((0, 0))
        );
    }
}

#[test]
fn unpublished_predecessor_blocks_conflicting_ready_work_but_not_independent_work() {
    for physical_alias in [false, true] {
        let gate = Arc::new(AtomicBool::new(false));
        let mut first = pending_at(0, "/data/parent");
        first.task.source_ready = Some(gate.clone());
        let mut child = pending_at(
            1,
            if physical_alias {
                "/alias"
            } else {
                "/data/parent/child"
            },
        );
        if physical_alias {
            child.task.effective_mount_path = normalized_path("/data/parent/child");
        }
        child.estimated_work = 100;
        let pending = VecDeque::from([first, child, pending_at(2, "/independent")]);
        assert_eq!(
            find_startable_download(
                &pending,
                Some(&[]),
                DownloadSelection::Largest,
                &mut |_, _, _, _| {}
            ),
            Some((2, 2))
        );
        gate.store(true, Ordering::Release);
        assert_eq!(
            find_startable_download(
                &pending,
                Some(&[]),
                DownloadSelection::Largest,
                &mut |_, _, _, _| {}
            ),
            Some((0, 0))
        );
    }
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
            source_ready: None,
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
        Some(&reservations),
        DownloadSelection::Fifo,
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
            Some(&reservations),
            DownloadSelection::Fifo,
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
        source_ready: None,
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
