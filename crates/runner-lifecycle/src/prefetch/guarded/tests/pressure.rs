use super::*;

struct HeldSource {
    path: PathBuf,
    entered: Notify,
    release: Notify,
    held: std::sync::atomic::AtomicBool,
}

impl MemoryObservationSource for HeldSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            if !self.held.swap(true, std::sync::atomic::Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            HostMemoryObservation::read_at(&self.path).await
        })
    }
}

#[tokio::test]
async fn pressure_change_during_real_grant_wait_revokes_even_a_recovered_offer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    let source = Arc::new(HeldSource {
        path: path.clone(),
        entered: Notify::new(),
        release: Notify::new(),
        held: std::sync::atomic::AtomicBool::new(false),
    });
    let operations = HostMemoryOperations::new(policy(), source.clone()).unwrap();
    let mut scheduling = pressure_policy();
    scheduling.optional_start_interval = Duration::from_secs(60);
    let mut driver = HostPressureCoordinator::new(scheduling, operations.clone()).unwrap();
    for _ in 0..2 {
        tokio::fs::write(&path, "MemAvailable: 49152 kB\n")
            .await
            .unwrap();
        driver.observe(HostMemoryObservation::read_at(&path).await);
    }
    let snapshot = dir.path().join("snapshot");
    tokio::fs::write(&snapshot, vec![7; 4096]).await.unwrap();
    let (mut tasks, mut latest) = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: snapshot,
            memory_mb: 1,
        }],
        1,
        GuardedPrefetchConfig {
            pressure: driver.optional_control(),
            overhead_bytes: MIB,
        },
    )
    .unwrap();
    tokio::time::timeout(WAIT, source.entered.notified())
        .await
        .unwrap();
    assert_eq!(operations.snapshot().unwrap().queued, 1);
    tokio::fs::write(&path, "MemAvailable: 12288 kB\n")
        .await
        .unwrap();
    driver.observe(HostMemoryObservation::read_at(&path).await);
    for _ in 0..2 {
        tokio::fs::write(&path, "MemAvailable: 49152 kB\n")
            .await
            .unwrap();
        driver.observe(HostMemoryObservation::read_at(&path).await);
    }
    assert_eq!(driver.decision().state, HostPressureState::Ready);
    source.release.notify_one();
    let refused = report(&mut latest, |r| r.deferred > 0).await;
    assert_eq!(refused.accepted, 0);
    assert_eq!(
        refused.last_error,
        Some(MemoryOperationError::ResourceChanged.to_string())
    );
    tasks.cancel();
    tokio::time::timeout(WAIT, tasks.drain()).await.unwrap();
    assert_eq!(operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn recovery_reads_preserve_path_selection_full_bytes_and_original_authority() {
    let fixture = Fixture::new(12).await;
    let a = fixture.file("a", &vec![7; 8192], 1).await;
    let duplicate = MemoryPrefetchCandidate {
        path: a.path.clone(),
        memory_mb: 2,
    };
    let b = fixture.file("b", &vec![7; 4096], 1).await;
    let c = fixture.file("c", &vec![7; 1024], 4).await;
    let (mut tasks, mut latest) =
        MemoryPrefetchTasks::spawn_guarded([a, duplicate, b, c], 3, fixture.config()).unwrap();
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    fixture.available(48).await;
    let result = report(&mut latest, |r| r.finished).await;
    assert_eq!(
        (result.accepted, result.completed, result.read_bytes),
        (2, 2, 12288)
    );
    assert_eq!((result.failed, result.uncertain), (0, 0));
    tasks.drain().await;
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    fixture.stop().await;
}

#[tokio::test]
async fn unsupported_overhead_and_oversize_file_never_report_truncated_success() {
    let fixture = Fixture::new(48).await;
    let candidate = fixture.file("large", &vec![7; MIB as usize + 1], 1).await;
    let mut bad = fixture.config();
    bad.overhead_bytes = 0;
    assert!(matches!(
        MemoryPrefetchTasks::spawn_guarded([], 1, bad),
        Err(MemoryOperationError::UnsupportedGrowth)
    ));
    let (mut tasks, mut latest) =
        MemoryPrefetchTasks::spawn_guarded([candidate], 1, fixture.config()).unwrap();
    let result = report(&mut latest, |r| r.finished).await;
    assert_eq!(
        (result.completed, result.read_bytes, result.failed),
        (0, 0, 1)
    );
    assert!(result.last_error.unwrap().contains("declared read bound"));
    tasks.drain().await;
    fixture.stop().await;
}

#[tokio::test]
async fn a_recovered_owner_cannot_revive_an_original_revoked_optional_offer() {
    let dir = tempfile::tempdir().unwrap();
    let meminfo = dir.path().join("meminfo");
    let operations =
        HostMemoryOperations::new(policy(), Arc::new(FileSource(meminfo.clone()))).unwrap();
    let mut driver = HostPressureCoordinator::new(pressure_policy(), operations.clone()).unwrap();
    for _ in 0..2 {
        tokio::fs::write(&meminfo, "MemAvailable: 49152 kB\n")
            .await
            .unwrap();
        driver.observe(HostMemoryObservation::read_at(&meminfo).await);
    }
    let control = driver.optional_control();
    let offer = control.take_optional_start().unwrap().unwrap();
    assert!(offer.revalidate().unwrap());
    tokio::fs::write(&meminfo, "MemAvailable: 12288 kB\n")
        .await
        .unwrap();
    driver.observe(HostMemoryObservation::read_at(&meminfo).await);
    for _ in 0..2 {
        tokio::fs::write(&meminfo, "MemAvailable: 49152 kB\n")
            .await
            .unwrap();
        driver.observe(HostMemoryObservation::read_at(&meminfo).await);
    }
    assert_eq!(control.decision().state, HostPressureState::Ready);
    assert!(!offer.revalidate().unwrap());
    drop(driver);
    assert!(matches!(
        control.take_optional_start(),
        Err(MemoryOperationError::Closed)
    ));
    assert!(!offer.revalidate().unwrap());
    assert_eq!(operations.snapshot().unwrap().registered_operations, 0);
}
