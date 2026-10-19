use super::*;
use std::sync::Arc;
use tokio::sync::{Notify, Semaphore};
use tokio_util::task::TaskTracker;

struct AllocationFixture {
    _source_root: tempfile::TempDir,
    _target_root: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    victim: PathBuf,
    reserve: HomeDriveSpaceReserve,
}

#[tokio::test]
async fn fragmented_sparse_copy_bound_covers_destination_extent_metadata() {
    use std::os::unix::fs::FileExt;
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("fragmented-source.ext4");
    let target = root.path().join("fragmented-target.ext4");
    let unit = nix::sys::statvfs::statvfs(root.path())
        .unwrap()
        .fragment_size();
    let logical = 4096 * unit;
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&source)
        .unwrap();
    file.set_len(logical).unwrap();
    let data = vec![7; unit as usize];
    for extent in 0..2048 {
        file.write_all_at(&data, extent * 2 * unit).unwrap();
    }
    file.sync_all().unwrap();
    let bound = sandbox::home_drive_copy_peak_bytes_from_file(&file, logical, unit);
    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            size_mb: u32::try_from(logical / (1024 * 1024)).unwrap(),
            seed_image: Some(HomeDriveSeedImage::Copy(source)),
            space_reserve: HomeDriveSpaceReserve::default(),
        },
        None,
        None,
    )
    .await
    .unwrap();
    let copied = std::fs::File::open(&target).unwrap();
    copied.sync_all().unwrap();
    let allocated = copied.metadata().unwrap().blocks() * 512;
    assert!(
        allocated <= bound.saturating_add(8192),
        "copied image allocation {allocated} exceeds sparse data bound {bound} plus metadata allowance"
    );
}

#[tokio::test]
async fn nonregular_copy_observation_is_bounded_and_integer_rounding_stays_conservative() {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let fifo = root.path().join("replaced-source");
    nix::unistd::mkfifo(
        &fifo,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let observed_path = fifo.clone();
    let mut observed = tokio::task::spawn_blocking(move || {
        sandbox::home_drive_copy_peak_bytes(&observed_path, 1024 * 1024, 4096)
    });
    match tokio::time::timeout(Duration::from_secs(5), &mut observed).await {
        Ok(result) => assert_eq!(result.unwrap(), 1024 * 1024),
        Err(_) => {
            // Release a regressed blocking open before failing; no detached
            // blocking thread or runtime shutdown remains stuck on the FIFO.
            let writer = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(fifo)
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), observed)
                .await
                .unwrap()
                .unwrap();
            drop(writer);
            panic!("copy demand observation waited for a nonregular source");
        }
    }
    assert_eq!(
        sandbox::home_drive_copy_peak_bytes(&root.path().join("missing"), u64::MAX, 4096),
        u64::MAX
    );
    let path = root.path().join("held-source");
    std::fs::write(&path, b"held image").unwrap();
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    file.set_len(1024 * 1024).unwrap();
    file.seek(SeekFrom::Start(123)).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, vec![8; 1024 * 1024]).unwrap();
    let bound = sandbox::home_drive_copy_peak_bytes_from_file(&file, 1024 * 1024, 4096);
    assert!((4096..=1024 * 1024).contains(&bound));
    assert_eq!(file.stream_position().unwrap(), 123);
    assert_eq!(
        sandbox::home_drive_copy_peak_bytes_from_file(&file, 1024 * 1024, 0),
        1024 * 1024
    );
}

impl AllocationFixture {
    async fn new() -> Self {
        let source_root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir_in("/dev/shm").unwrap();
        let source = source_root.path().join("source.ext4");
        let target = target_root.path().join("target.ext4");
        let victim = target_root.path().join("disposable-cache");
        tokio::fs::write(&source, vec![7; 4 * 1024 * 1024])
            .await
            .unwrap();
        tokio::fs::write(&victim, vec![9; 8 * 1024 * 1024])
            .await
            .unwrap();
        let stats = nix::sys::statvfs::statvfs(target_root.path()).unwrap();
        let capacity = stats.blocks() * stats.fragment_size();
        assert!(
            capacity > 10 * 1024 * 1024,
            "fixture requires bounded tmpfs capacity"
        );
        // Our live 8 MiB victim guarantees an initial deficit, regardless of
        // unrelated allocations/releases. Reclaim permits a fresh observation;
        // other writers can still make that observation legitimately refuse.
        let reserve = HomeDriveSpaceReserve::new(capacity - 10 * 1024 * 1024, 0);
        Self {
            _source_root: source_root,
            _target_root: target_root,
            source,
            target,
            victim,
            reserve,
        }
    }
}

struct FileReclaimer {
    victim: PathBuf,
    entered: Arc<Notify>,
    release: Option<Arc<Semaphore>>,
    io: TaskTracker,
}

impl sandbox::HomeDrivePressurePolicy for FileReclaimer {
    fn reclaim(
        &self,
        destination_device: u64,
        _required: u64,
        _deadline: tokio::time::Instant,
    ) -> sandbox::HomeDrivePressureFuture<'_> {
        let victim = self.victim.clone();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let accepted = self.io.spawn(async move {
            assert_eq!(
                std::fs::metadata(&victim).unwrap().dev(),
                destination_device
            );
            entered.notify_one();
            if let Some(release) = release {
                release.acquire().await.unwrap().forget();
            }
            tokio::fs::remove_file(victim).await.unwrap();
        });
        Box::pin(async move {
            accepted.await.unwrap();
        })
    }
}

struct NoProgress;
impl sandbox::HomeDrivePressurePolicy for NoProgress {
    fn reclaim(
        &self,
        _device: u64,
        _required: u64,
        _deadline: tokio::time::Instant,
    ) -> sandbox::HomeDrivePressureFuture<'_> {
        Box::pin(async {})
    }
}

fn assert_observed_insufficient(error: &SandboxError) {
    let SandboxError::Initialization { phase, message } = error else {
        panic!("expected a headroom refusal: {error}")
    };
    assert!(matches!(
        phase,
        SandboxInitializationPhase::SandboxAllocation
    ));
    let (_, values) = message.split_once(": available ").unwrap();
    let (available, values) = values.split_once(" bytes, required ").unwrap();
    let (required, _) = values.split_once(" bytes, capacity ").unwrap();
    assert!(available.parse::<u64>().unwrap() < required.parse::<u64>().unwrap());
}

struct UnavailableReclaimer;
impl sandbox::HomeDrivePressurePolicy for UnavailableReclaimer {
    fn reclaim(
        &self,
        _device: u64,
        _required: u64,
        _deadline: tokio::time::Instant,
    ) -> sandbox::HomeDrivePressureFuture<'_> {
        Box::pin(async { panic!("healthy preparation must not depend on reclamation") })
    }
}

#[tokio::test]
async fn pressured_copy_and_exdev_move_recheck_real_space_after_reclamation() {
    for moving in [false, true] {
        let f = AllocationFixture::new().await;
        assert_ne!(
            std::fs::metadata(&f.source).unwrap().dev(),
            std::fs::metadata(f.target.parent().unwrap()).unwrap().dev()
        );
        let policy = FileReclaimer {
            victim: f.victim.clone(),
            entered: Arc::new(Notify::new()),
            release: None,
            io: TaskTracker::new(),
        };
        let result = prepare_home_drive_image(
            &f.target,
            &sandbox::HomeDriveConfig {
                size_mb: 4,
                seed_image: Some(if moving {
                    HomeDriveSeedImage::Move(f.source.clone())
                } else {
                    HomeDriveSeedImage::Copy(f.source.clone())
                }),
                space_reserve: f.reserve,
            },
            Some(&policy),
            None,
        )
        .await;
        policy.io.close();
        policy.io.wait().await;
        assert!(!f.victim.exists());
        match result {
            Ok(()) => {
                assert_eq!(f.source.exists(), !moving);
                assert_eq!(
                    tokio::fs::read(&f.target).await.unwrap(),
                    vec![7; 4 * 1024 * 1024]
                );
            }
            Err(error) => {
                assert_observed_insufficient(&error);
                assert!(!f.target.exists());
                assert_eq!(
                    tokio::fs::read(&f.source).await.unwrap(),
                    vec![7; 4 * 1024 * 1024]
                );
            }
        }
    }
}

#[tokio::test]
async fn reclaim_completion_without_free_space_does_not_authorize_copy_or_mutate_images() {
    let f = AllocationFixture::new().await;
    tokio::fs::write(&f.target, b"untouched-target")
        .await
        .unwrap();
    let error = prepare_home_drive_image(
        &f.target,
        &sandbox::HomeDriveConfig {
            size_mb: 4,
            seed_image: Some(HomeDriveSeedImage::Copy(f.source.clone())),
            space_reserve: f.reserve,
        },
        Some(&NoProgress),
        None,
    )
    .await
    .unwrap_err();
    assert_observed_insufficient(&error);
    assert!(matches!(
        error,
        SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            ..
        }
    ));
    assert!(
        error
            .to_string()
            .contains("insufficient home image headroom")
    );
    assert_eq!(
        tokio::fs::read(&f.target).await.unwrap(),
        b"untouched-target"
    );
    assert_eq!(
        tokio::fs::read(&f.source).await.unwrap(),
        vec![7; 4 * 1024 * 1024]
    );
    assert!(f.victim.exists());
}

#[tokio::test]
async fn provider_observation_expires_without_aborting_accepted_reclamation() {
    let f = AllocationFixture::new().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let policy = Arc::new(FileReclaimer {
        victim: f.victim.clone(),
        entered: entered.clone(),
        release: Some(release.clone()),
        io: TaskTracker::new(),
    });
    let prepare_policy = policy.clone();
    let target = f.target.clone();
    let config = sandbox::HomeDriveConfig {
        size_mb: 4,
        seed_image: Some(HomeDriveSeedImage::Copy(f.source.clone())),
        space_reserve: f.reserve,
    };
    let prepare = tokio::spawn(async move {
        prepare_home_drive_image(&target, &config, Some(prepare_policy.as_ref()), None).await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    // The accepted file reclaimer is now parked at its explicit release gate.
    // Advance the observation deadline without advancing physical IO.
    tokio::time::pause();
    tokio::time::advance(sandbox::HOME_DRIVE_RECLAIM_OBSERVATION).await;
    tokio::time::resume();
    assert!(
        prepare
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("insufficient home image headroom")
    );
    assert!(!f.target.exists());
    assert!(f.source.exists() && f.victim.exists());
    policy.io.close();
    let drain = policy.io.wait();
    tokio::pin!(drain);
    assert!(futures_util::poll!(&mut drain).is_pending());
    release.add_permits(1);
    drain.await;
    assert!(!f.victim.exists());
}

#[tokio::test]
async fn healthy_copy_fresh_and_same_device_move_do_not_wait_for_reclamation() {
    let root = tempfile::tempdir().unwrap();
    for kind in [0, 1, 2] {
        let source = root.path().join(format!("source-{kind}.ext4"));
        let target = root.path().join(format!("target-{kind}.ext4"));
        tokio::fs::write(&source, b"seed").await.unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .unwrap();
        let seed_image = match kind {
            0 => None,
            1 => Some(HomeDriveSeedImage::Copy(source.clone())),
            _ => Some(HomeDriveSeedImage::Move(source.clone())),
        };
        prepare_home_drive_image(
            &target,
            &sandbox::HomeDriveConfig {
                size_mb: 16,
                seed_image,
                space_reserve: HomeDriveSpaceReserve::default(),
            },
            Some(&UnavailableReclaimer),
            None,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::metadata(target).unwrap().len(), 16 * 1024 * 1024);
        assert_eq!(source.exists(), kind != 2);
    }
}
