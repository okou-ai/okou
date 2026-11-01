mod pressure;
use super::*;
use std::io::SeekFrom;
use std::os::unix::fs::MetadataExt;
use std::process::Command;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[derive(Default)]
struct RecordingObserver {
    home_drive_present: bool,
    home_seed_image_used: bool,
    stages: Vec<HomeDriveImagePrepareStage>,
}

impl HomeDriveImagePrepareObserver for RecordingObserver {
    fn mark_home_drive_present(&mut self) {
        self.home_drive_present = true;
    }

    fn mark_home_seed_image_used(&mut self) {
        self.home_seed_image_used = true;
    }

    fn record_stage_result(
        &mut self,
        stage: HomeDriveImagePrepareStage,
        _started_at: Instant,
        result: sandbox::Result<()>,
    ) -> sandbox::Result<()> {
        self.stages.push(stage);
        result
    }
}

fn pressured_reserve(parent: &Path) -> HomeDriveSpaceReserve {
    let stats = nix::sys::statvfs::statvfs(parent).unwrap();
    HomeDriveSpaceReserve::new(stats.blocks().saturating_mul(stats.fragment_size()), 0)
}

#[tokio::test]
async fn copy_reserve_accounts_sparse_blocks_instead_of_logical_image_size() {
    let source_root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir_in("/dev/shm").unwrap();
    let source = source_root.path().join("sparse.ext4");
    let target = target_root.path().join("home.ext4");
    let mut file = tokio::fs::File::create(&source).await.unwrap();
    file.set_len(home_drive_size_bytes(64)).await.unwrap();
    file.seek(SeekFrom::Start(4096)).await.unwrap();
    file.write_all(b"sparse-marker").await.unwrap();
    file.flush().await.unwrap();
    drop(file);
    let stats = nix::sys::statvfs::statvfs(target_root.path()).unwrap();
    let available = stats
        .blocks_available()
        .saturating_mul(stats.fragment_size());
    let headroom = home_drive_size_bytes(32);
    assert!(
        available > headroom,
        "sparse-copy fixture requires 32 MiB of tmpfs headroom"
    );
    let reserve = HomeDriveSpaceReserve::new(available - headroom, 0);
    // The logical image cannot fit above this reserve, but its physical
    // allocation can. Use real copy/target bytes rather than a sizing mock.
    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            size_mb: 64,
            seed_image: Some(HomeDriveSeedImage::Copy(source.clone())),
            space_reserve: reserve,
        },
        None,
        None,
    )
    .await
    .unwrap();
    assert!(source.exists());
    let metadata = std::fs::metadata(&target).unwrap();
    assert_eq!(metadata.len(), home_drive_size_bytes(64));
    assert!(metadata.blocks().saturating_mul(512) < home_drive_size_bytes(1));
    let mut file = tokio::fs::File::open(target).await.unwrap();
    file.seek(SeekFrom::Start(4096)).await.unwrap();
    let mut marker = [0; 13];
    file.read_exact(&mut marker).await.unwrap();
    assert_eq!(&marker, b"sparse-marker");
}

#[tokio::test]
async fn reserve_refuses_fresh_and_copy_before_mutating_images_but_allows_move() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.ext4");
    tokio::fs::write(&source, b"preserved-seed").await.unwrap();
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap();
    file.set_len(home_drive_size_bytes(1)).unwrap();
    drop(file);
    let identity = std::fs::metadata(&source).unwrap();
    let expected = tokio::fs::read(&source).await.unwrap();
    let reserve = pressured_reserve(dir.path());
    for seed_image in [None, Some(HomeDriveSeedImage::Copy(source.clone()))] {
        let target = dir.path().join("target.ext4");
        tokio::fs::write(&target, b"untouched-target")
            .await
            .unwrap();
        let mut observer = RecordingObserver::default();
        let error = prepare_home_drive_image(
            &target,
            &sandbox::HomeDriveConfig {
                size_mb: 1,
                seed_image,
                space_reserve: reserve,
            },
            None,
            Some(&mut observer),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                ..
            }
        ));
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"untouched-target");
        assert_eq!(tokio::fs::read(&source).await.unwrap(), expected);
        assert!(
            observer.stages.is_empty(),
            "refusal must precede copy or format"
        );
    }
    let target = dir.path().join("moved.ext4");
    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Move(source.clone())),
            space_reserve: reserve,
        },
        None,
        None,
    )
    .await
    .unwrap();
    let moved = std::fs::metadata(&target).unwrap();
    assert_eq!((moved.dev(), moved.ino()), (identity.dev(), identity.ino()));
    assert!(!source.exists());
    assert_eq!(tokio::fs::read(target).await.unwrap(), expected);
}

#[tokio::test]
async fn cross_device_pressure_refusal_keeps_sole_source_and_creates_no_copy() {
    let source_root = tempfile::tempdir_in("/dev/shm").unwrap();
    let target_root = tempfile::tempdir().unwrap();
    assert_ne!(
        std::fs::metadata(source_root.path()).unwrap().dev(),
        std::fs::metadata(target_root.path()).unwrap().dev()
    );
    let source = source_root.path().join("seed.ext4");
    tokio::fs::write(&source, b"sole-seed").await.unwrap();
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap();
    file.set_len(home_drive_size_bytes(1)).unwrap();
    drop(file);
    let expected = tokio::fs::read(&source).await.unwrap();
    let target = target_root.path().join("home.ext4");
    let mut observer = RecordingObserver::default();
    assert!(
        prepare_home_drive_image(
            &target,
            &sandbox::HomeDriveConfig {
                size_mb: 1,
                seed_image: Some(HomeDriveSeedImage::Move(source.clone())),
                space_reserve: pressured_reserve(target_root.path()),
            },
            None,
            Some(&mut observer),
        )
        .await
        .is_err()
    );
    assert_eq!(tokio::fs::read(source).await.unwrap(), expected);
    assert!(!target.exists());
    assert!(observer.stages.is_empty());
}

#[tokio::test]
async fn invalid_home_shape_or_path_cannot_consume_seed_or_format_another_file() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.ext4");
    let file = tokio::fs::File::create(&source).await.unwrap();
    file.set_len(home_drive_size_bytes(1)).await.unwrap();
    drop(file);
    for seed in [
        HomeDriveSeedImage::Copy(source.clone()),
        HomeDriveSeedImage::Move(source.clone()),
    ] {
        let error = prepare_home_drive_image(
            &source,
            &sandbox::HomeDriveConfig {
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                size_mb: 1,
                seed_image: Some(seed),
            },
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("distinct files"));
        assert_eq!(
            tokio::fs::metadata(&source).await.unwrap().len(),
            home_drive_size_bytes(1)
        );
    }
    let hard_link = dir.path().join("hard-link.ext4");
    std::fs::hard_link(&source, &hard_link).unwrap();
    assert!(
        prepare_home_drive_image(
            &hard_link,
            &sandbox::HomeDriveConfig {
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                size_mb: 1,
                seed_image: Some(HomeDriveSeedImage::Move(source.clone()))
            },
            None,
            None
        )
        .await
        .is_err()
    );
    assert!(source.exists());
    let zero = dir.path().join("uncreated/home.ext4");
    assert!(
        prepare_home_drive_image(
            &zero,
            &sandbox::HomeDriveConfig {
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                size_mb: 0,
                seed_image: None
            },
            None,
            None
        )
        .await
        .is_err()
    );
    assert!(!zero.parent().unwrap().exists());
    let link = dir.path().join("symlink.ext4");
    std::os::unix::fs::symlink(&source, &link).unwrap();
    assert!(
        prepare_home_drive_image(
            &link,
            &sandbox::HomeDriveConfig {
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                size_mb: 1,
                seed_image: None
            },
            None,
            None
        )
        .await
        .is_err()
    );
    assert_eq!(
        tokio::fs::metadata(&source).await.unwrap().len(),
        home_drive_size_bytes(1)
    );
}

#[tokio::test]
async fn seed_and_target_symlink_parents_are_rejected_without_copy_or_move() {
    let dir = tempfile::tempdir().unwrap();
    let backing = dir.path().join("backing");
    tokio::fs::create_dir(&backing).await.unwrap();
    let source = backing.join("source.ext4");
    let file = tokio::fs::File::create(&source).await.unwrap();
    file.set_len(home_drive_size_bytes(1)).await.unwrap();
    drop(file);
    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(&backing, &alias).unwrap();
    let target = dir.path().join("target.ext4");
    for seed in [
        HomeDriveSeedImage::Copy(alias.join("source.ext4")),
        HomeDriveSeedImage::Move(alias.join("source.ext4")),
    ] {
        assert!(
            prepare_home_drive_image(
                &target,
                &sandbox::HomeDriveConfig {
                    space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                    size_mb: 1,
                    seed_image: Some(seed)
                },
                None,
                None
            )
            .await
            .is_err()
        );
        assert!(source.exists());
        assert!(!target.exists());
    }
    assert!(
        prepare_home_drive_image(
            &alias.join("target.ext4"),
            &sandbox::HomeDriveConfig {
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                size_mb: 1,
                seed_image: None
            },
            None,
            None
        )
        .await
        .is_err()
    );
    assert!(!backing.join("target.ext4").exists());
}

#[test]
fn home_drive_size_bytes_converts_mib_to_bytes() {
    assert_eq!(home_drive_size_bytes(16), 16 * 1024 * 1024);
}

#[tokio::test]
async fn prepare_home_drive_image_without_seed_truncates_and_formats_fresh_image() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("nested").join("home.ext4");
    let mut observer = RecordingObserver::default();

    tokio::fs::create_dir_all(target.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&target, vec![0xff; 4096]).await.unwrap();

    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 16,
            seed_image: None,
        },
        None,
        Some(&mut observer),
    )
    .await
    .unwrap();

    let metadata = tokio::fs::metadata(&target).await.unwrap();
    assert_eq!(metadata.len(), home_drive_size_bytes(16));
    assert!(observer.home_drive_present);
    assert!(!observer.home_seed_image_used);
    assert_eq!(
        observer.stages,
        vec![HomeDriveImagePrepareStage::FreshFormat]
    );

    let fsck = Command::new("e2fsck")
        .args(["-f", "-n"])
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        fsck.status.success(),
        "e2fsck failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&fsck.stdout),
        String::from_utf8_lossy(&fsck.stderr)
    );

    let tune2fs = Command::new("tune2fs")
        .arg("-l")
        .arg(&target)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(
        tune2fs.status.success(),
        "tune2fs failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&tune2fs.stdout),
        String::from_utf8_lossy(&tune2fs.stderr)
    );
    let tune2fs_stdout = String::from_utf8(tune2fs.stdout).unwrap();
    let features = tune2fs_stdout
        .lines()
        .find_map(|line| line.strip_prefix("Filesystem features:"))
        .expect("tune2fs output should contain filesystem features");
    assert!(
        features
            .split_whitespace()
            .any(|feature| feature == "has_journal")
    );
}

#[tokio::test]
async fn prepare_home_drive_image_sparse_copies_seed_image() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("seed.ext4");
    let target = tmp.path().join("nested").join("home.ext4");
    let marker_offset = 4096;
    let marker = b"vm0";
    let mut observer = RecordingObserver::default();

    let mut source_file = tokio::fs::File::create(&source).await.unwrap();
    source_file.set_len(home_drive_size_bytes(1)).await.unwrap();
    source_file
        .seek(SeekFrom::Start(marker_offset))
        .await
        .unwrap();
    source_file.write_all(marker).await.unwrap();
    source_file.flush().await.unwrap();
    drop(source_file);

    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Copy(source.clone())),
        },
        None,
        Some(&mut observer),
    )
    .await
    .unwrap();

    let metadata = tokio::fs::metadata(&target).await.unwrap();
    assert_eq!(metadata.len(), home_drive_size_bytes(1));
    assert!(observer.home_drive_present);
    assert!(observer.home_seed_image_used);
    assert_eq!(
        observer.stages,
        vec![HomeDriveImagePrepareStage::SeedSparseCopy]
    );

    let mut target_file = tokio::fs::File::open(&target).await.unwrap();
    target_file
        .seek(SeekFrom::Start(marker_offset))
        .await
        .unwrap();
    let mut copied_marker = [0; 3];
    target_file.read_exact(&mut copied_marker).await.unwrap();
    assert_eq!(&copied_marker, marker);
}

#[tokio::test]
async fn prepare_home_drive_image_rejects_seed_image_size_mismatch() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("seed.ext4");
    let target = tmp.path().join("home.ext4");

    let source_file = tokio::fs::File::create(&source).await.unwrap();
    source_file
        .set_len(home_drive_size_bytes(1) - 1)
        .await
        .unwrap();
    drop(source_file);

    let err = prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Copy(source)),
        },
        None,
        None,
    )
    .await
    .unwrap_err();

    match err {
        SandboxError::Initialization { phase, message } => {
            assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
            assert!(message.contains("home seed image size mismatch"));
        }
        other => panic!("expected home seed initialization error, got {other:?}"),
    }
    assert!(!target.exists());
}

#[tokio::test]
async fn prepare_home_drive_image_moves_seed_image() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("seed.ext4");
    let target = tmp.path().join("nested").join("home.ext4");
    let marker_offset = 4096;
    let marker = b"vm0";
    let mut observer = RecordingObserver::default();

    let mut source_file = tokio::fs::File::create(&source).await.unwrap();
    source_file.set_len(home_drive_size_bytes(1)).await.unwrap();
    source_file
        .seek(SeekFrom::Start(marker_offset))
        .await
        .unwrap();
    source_file.write_all(marker).await.unwrap();
    source_file.flush().await.unwrap();
    drop(source_file);
    let source_metadata = tokio::fs::metadata(&source).await.unwrap();
    let source_identity = (source_metadata.dev(), source_metadata.ino());

    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Move(source.clone())),
        },
        None,
        Some(&mut observer),
    )
    .await
    .unwrap();

    assert!(!source.exists());
    let metadata = tokio::fs::metadata(&target).await.unwrap();
    assert_eq!(metadata.len(), home_drive_size_bytes(1));
    assert_eq!((metadata.dev(), metadata.ino()), source_identity);
    assert!(observer.home_drive_present);
    assert!(observer.home_seed_image_used);
    assert!(observer.stages.is_empty());

    let mut target_file = tokio::fs::File::open(&target).await.unwrap();
    target_file
        .seek(SeekFrom::Start(marker_offset))
        .await
        .unwrap();
    let mut moved_marker = [0; 3];
    target_file.read_exact(&mut moved_marker).await.unwrap();
    assert_eq!(&moved_marker, marker);
}

#[tokio::test]
async fn prepare_home_drive_image_moves_seed_image_across_filesystems() {
    let source_root = tempfile::tempdir_in("/dev/shm").unwrap();
    let target_root = tempfile::tempdir_in("/tmp").unwrap();
    let source = source_root.path().join("seed.ext4");
    let target = target_root.path().join("nested").join("home.ext4");
    let source_device = tokio::fs::metadata(source_root.path()).await.unwrap().dev();
    let target_device = tokio::fs::metadata(target_root.path()).await.unwrap().dev();
    assert_ne!(
        source_device, target_device,
        "cross-filesystem move test requires /dev/shm and /tmp on distinct devices"
    );
    let marker_offset = 4096;
    let marker = b"vm0";
    let mut observer = RecordingObserver::default();

    let mut source_file = tokio::fs::File::create(&source).await.unwrap();
    source_file.set_len(home_drive_size_bytes(1)).await.unwrap();
    source_file
        .seek(SeekFrom::Start(marker_offset))
        .await
        .unwrap();
    source_file.write_all(marker).await.unwrap();
    source_file.flush().await.unwrap();
    drop(source_file);

    prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Move(source.clone())),
        },
        None,
        Some(&mut observer),
    )
    .await
    .unwrap();

    assert!(!source.exists());
    let metadata = tokio::fs::metadata(&target).await.unwrap();
    assert_eq!(metadata.dev(), target_device);
    assert_eq!(metadata.len(), home_drive_size_bytes(1));
    assert!(
        metadata.blocks().saturating_mul(512) < metadata.len(),
        "cross-filesystem move fallback must preserve sparse allocation"
    );
    assert!(observer.home_drive_present);
    assert!(observer.home_seed_image_used);
    assert_eq!(
        observer.stages,
        vec![HomeDriveImagePrepareStage::SeedSparseCopy]
    );

    let mut target_file = tokio::fs::File::open(&target).await.unwrap();
    target_file
        .seek(SeekFrom::Start(marker_offset))
        .await
        .unwrap();
    let mut copied_marker = [0; 3];
    target_file.read_exact(&mut copied_marker).await.unwrap();
    assert_eq!(&copied_marker, marker);
}

#[tokio::test]
async fn prepare_home_drive_image_does_not_copy_after_other_move_error() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("seed.ext4");
    let target = tmp.path().join("home.ext4");
    let mut observer = RecordingObserver::default();

    let source_file = tokio::fs::File::create(&source).await.unwrap();
    source_file.set_len(home_drive_size_bytes(1)).await.unwrap();
    drop(source_file);
    tokio::fs::create_dir(&target).await.unwrap();

    let err = prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Move(source.clone())),
        },
        None,
        Some(&mut observer),
    )
    .await
    .unwrap_err();

    match err {
        SandboxError::Initialization { phase, message } => {
            assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
            assert!(message.contains("move home seed image"));
        }
        other => panic!("expected home seed initialization error, got {other:?}"),
    }
    assert!(source.exists());
    assert!(target.is_dir());
    assert!(observer.home_drive_present);
    assert!(observer.home_seed_image_used);
    assert!(observer.stages.is_empty());
}

#[tokio::test]
async fn prepare_home_drive_image_rejects_move_seed_image_size_mismatch_without_moving() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("seed.ext4");
    let target = tmp.path().join("home.ext4");

    let source_file = tokio::fs::File::create(&source).await.unwrap();
    source_file
        .set_len(home_drive_size_bytes(1) - 1)
        .await
        .unwrap();
    drop(source_file);

    let err = prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Move(source.clone())),
        },
        None,
        None,
    )
    .await
    .unwrap_err();

    match err {
        SandboxError::Initialization { phase, message } => {
            assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
            assert!(message.contains("home seed image size mismatch"));
        }
        other => panic!("expected home seed initialization error, got {other:?}"),
    }
    assert!(source.exists());
    assert!(!target.exists());
}

#[tokio::test]
async fn prepare_home_drive_image_rejects_move_seed_symlink_without_moving() {
    let tmp = tempfile::tempdir().unwrap();
    let real_source = tmp.path().join("real-seed.ext4");
    let source_link = tmp.path().join("seed-link.ext4");
    let target = tmp.path().join("home.ext4");

    let source_file = tokio::fs::File::create(&real_source).await.unwrap();
    source_file.set_len(home_drive_size_bytes(1)).await.unwrap();
    drop(source_file);
    std::os::unix::fs::symlink(&real_source, &source_link).unwrap();

    let err = prepare_home_drive_image(
        &target,
        &sandbox::HomeDriveConfig {
            space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            size_mb: 1,
            seed_image: Some(HomeDriveSeedImage::Move(source_link.clone())),
        },
        None,
        None,
    )
    .await
    .unwrap_err();

    match err {
        SandboxError::Initialization { phase, message } => {
            assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
            assert!(message.contains("home seed image is not a regular file"));
        }
        other => panic!("expected home seed initialization error, got {other:?}"),
    }
    assert!(real_source.exists());
    assert!(source_link.exists());
    assert!(!target.exists());
}
