use sandbox::SnapshotProvider;

use crate::FirecrackerSnapshotProvider;
use crate::paths::SnapshotOutputPaths;

use super::*;

#[test]
fn snapshot_blocking_fs_runs_without_tokio_runtime() {
    assert_eq!(run_snapshot_blocking_fs(|| "done"), "done");
}

#[test]
#[should_panic(expected = "snapshot blocking fs panic")]
fn snapshot_blocking_fs_propagates_panic() {
    run_snapshot_blocking_fs(|| panic!("snapshot blocking fs panic"));
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_blocking_fs_current_thread_runtime_runs() {
    assert_eq!(run_snapshot_blocking_fs(|| "done"), "done");
}

#[tokio::test(flavor = "multi_thread")]
async fn snapshot_blocking_fs_multi_thread_runtime_runs() {
    assert_eq!(run_snapshot_blocking_fs(|| "done"), "done");
}

async fn write_required_snapshot_artifacts(output: &SnapshotOutputPaths) {
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    for artifact in output.required_artifacts() {
        tokio::fs::write(&artifact, b"snapshot artifact")
            .await
            .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
    }
}

#[test]
fn required_artifacts_lists_snapshot_data_files() {
    let output = SnapshotOutputPaths::new(PathBuf::from("/data/images/test-snapshot"));

    assert_eq!(
        output.required_artifacts(),
        [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ]
    );
}

#[tokio::test]
async fn prepare_snapshot_output_removes_snapshot_artifacts_only() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    let stale_work_file = output.work_dir().join("nested").join("stale.txt");
    let unrelated = dir.path().join("keep.txt");

    tokio::fs::create_dir_all(stale_work_file.parent().expect("parent"))
        .await
        .expect("create stale work dir");
    tokio::fs::write(&stale_work_file, b"stale")
        .await
        .expect("write stale work file");
    tokio::fs::write(&unrelated, b"keep")
        .await
        .expect("write unrelated file");
    for artifact in [
        output.snapshot(),
        output.memory(),
        output.cow(),
        output.cow_bitmap(),
        output.complete_marker(),
    ] {
        tokio::fs::write(&artifact, b"stale")
            .await
            .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
    }

    let work = prepare_snapshot_output(&output)
        .await
        .expect("prepare output");

    assert_eq!(work, output.work_dir());
    assert!(
        tokio::fs::try_exists(output.work_dir()).await.unwrap(),
        "work dir should be recreated"
    );
    assert!(
        !tokio::fs::try_exists(stale_work_file).await.unwrap(),
        "stale work contents should be removed"
    );
    for artifact in [
        output.snapshot(),
        output.memory(),
        output.cow(),
        output.cow_bitmap(),
        output.complete_marker(),
    ] {
        assert!(
            !tokio::fs::try_exists(&artifact).await.unwrap(),
            "stale artifact should be removed: {}",
            artifact.display()
        );
    }
    assert!(
        tokio::fs::try_exists(unrelated).await.unwrap(),
        "non-snapshot output-dir contents should be preserved"
    );
}

#[tokio::test]
async fn prepare_snapshot_output_propagates_stale_artifact_cleanup_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    tokio::fs::create_dir_all(output.snapshot())
        .await
        .expect("create blocking snapshot directory");

    let err = prepare_snapshot_output(&output)
        .await
        .expect_err("prepare must fail when an artifact path cannot be removed as a file");

    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        tokio::fs::metadata(output.snapshot())
            .await
            .expect("blocking directory should remain")
            .is_dir(),
        "failed cleanup should leave the blocking artifact path for operator inspection"
    );
}

#[tokio::test]
async fn publish_snapshot_complete_marker_writes_expected_content() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;

    publish_snapshot_complete_marker(&output).expect("publish complete marker");

    let marker = tokio::fs::read(output.complete_marker())
        .await
        .expect("read complete marker");
    assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);
}

#[tokio::test]
async fn publish_snapshot_complete_marker_cleans_up_after_marker_sync_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    let marker = output.complete_marker();

    let err = publish_snapshot_complete_marker_with_syncs(
        &output,
        |_| {
            let content = std::fs::read(&marker).expect("read marker before injected sync failure");
            assert_eq!(content, SNAPSHOT_COMPLETE_MARKER_CONTENT);
            Err(io::Error::other("injected marker sync failure"))
        },
        std::fs::File::sync_all,
    )
    .expect_err("marker sync failure should fail publication");

    match err {
        SnapshotError::Io(error) => {
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(error.to_string(), "injected marker sync failure");
        }
        other => panic!("expected marker sync I/O error, got: {other:?}"),
    }
    assert!(
        !tokio::fs::try_exists(&marker).await.unwrap(),
        "failed publication must remove its complete marker"
    );
    for artifact in output.required_artifacts() {
        let content = tokio::fs::read(&artifact)
            .await
            .unwrap_or_else(|e| panic!("read {}: {e}", artifact.display()));
        assert_eq!(
            content,
            b"snapshot artifact",
            "failed publication must preserve {}",
            artifact.display()
        );
    }

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "failed publication must leave the snapshot incomplete"
    );

    publish_snapshot_complete_marker(&output).expect("retry marker publication");
    assert!(
        provider.is_complete(output.dir()).await.unwrap(),
        "retry must publish a complete snapshot"
    );
}

#[tokio::test]
async fn publish_snapshot_complete_marker_cleans_up_after_output_directory_sync_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    let marker = output.complete_marker();
    let mut directory_sync_attempts = 0;

    let err = publish_snapshot_complete_marker_with_syncs(&output, std::fs::File::sync_all, |_| {
        directory_sync_attempts += 1;
        match directory_sync_attempts {
            1 => {
                let content = std::fs::read(&marker)
                    .expect("read marker before injected directory sync failure");
                assert_eq!(content, SNAPSHOT_COMPLETE_MARKER_CONTENT);
                Err(io::Error::other("injected output directory sync failure"))
            }
            2 => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected cleanup directory sync failure",
            )),
            attempt => panic!("unexpected directory sync attempt: {attempt}"),
        }
    })
    .expect_err("output directory sync failure should fail publication");

    assert_eq!(
        directory_sync_attempts, 2,
        "failed publication should re-sync after marker cleanup"
    );
    match err {
        SnapshotError::Io(error) => {
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(error.to_string(), "injected output directory sync failure");
        }
        other => panic!("expected output directory sync I/O error, got: {other:?}"),
    }
    assert!(
        !tokio::fs::try_exists(&marker).await.unwrap(),
        "failed publication must remove its complete marker"
    );
    for artifact in output.required_artifacts() {
        let content = tokio::fs::read(&artifact)
            .await
            .unwrap_or_else(|e| panic!("read {}: {e}", artifact.display()));
        assert_eq!(
            content,
            b"snapshot artifact",
            "failed publication must preserve {}",
            artifact.display()
        );
    }

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "failed publication must leave the snapshot incomplete"
    );

    publish_snapshot_complete_marker(&output).expect("retry marker publication");
    assert!(
        provider.is_complete(output.dir()).await.unwrap(),
        "retry must publish a complete snapshot"
    );
}

#[tokio::test]
async fn publish_snapshot_complete_marker_rejects_missing_artifact_without_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    for artifact in [output.snapshot(), output.memory(), output.cow()] {
        tokio::fs::write(&artifact, b"snapshot artifact")
            .await
            .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
    }

    let err =
        publish_snapshot_complete_marker(&output).expect_err("publish should fail before marker");

    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "missing artifact must not publish complete marker"
    );
}

#[tokio::test]
async fn publish_snapshot_complete_marker_rejects_directory_artifact_without_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::remove_file(output.snapshot())
        .await
        .expect("remove snapshot file");
    tokio::fs::create_dir(output.snapshot())
        .await
        .expect("replace snapshot file with directory");

    let err = publish_snapshot_complete_marker(&output)
        .expect_err("publish should reject non-file artifact paths");

    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "non-file artifact must not publish complete marker"
    );
}

#[tokio::test]
async fn publish_snapshot_complete_marker_rejects_symlink_artifact_without_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    let target = dir.path().join("target-snapshot.bin");
    tokio::fs::write(&target, b"target snapshot")
        .await
        .expect("write symlink target");
    tokio::fs::remove_file(output.snapshot())
        .await
        .expect("remove snapshot file");
    std::os::unix::fs::symlink(&target, output.snapshot())
        .expect("replace snapshot file with symlink");

    let err = publish_snapshot_complete_marker(&output)
        .expect_err("publish should reject symlink artifact paths");

    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "symlink artifact must not publish complete marker"
    );
}

#[tokio::test]
async fn publish_snapshot_complete_marker_preserves_existing_marker_on_validation_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    for artifact in [output.snapshot(), output.memory(), output.cow()] {
        tokio::fs::write(&artifact, b"snapshot artifact")
            .await
            .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
    }
    tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
        .await
        .expect("write existing marker");

    let err = publish_snapshot_complete_marker(&output)
        .expect_err("publish should fail before marker creation");

    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    let marker = tokio::fs::read(output.complete_marker())
        .await
        .expect("read existing marker");
    assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);
}

#[tokio::test]
async fn publish_snapshot_complete_marker_preserves_existing_marker_on_create_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
        .await
        .expect("write existing marker");

    let err = publish_snapshot_complete_marker(&output).expect_err("publish should fail on marker");

    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    let marker = tokio::fs::read(output.complete_marker())
        .await
        .expect("read existing marker");
    assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);
}

#[tokio::test]
async fn validate_snapshot_output_checks_exact_marker_content() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;

    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate missing marker"),
        SnapshotOutputValidation::MissingFile(output.complete_marker())
    );

    tokio::fs::write(output.complete_marker(), b"wrong marker")
        .await
        .expect("write malformed marker");
    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate malformed marker"),
        SnapshotOutputValidation::InvalidCompleteMarker(output.complete_marker())
    );

    tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
        .await
        .expect("write valid marker");
    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate complete snapshot"),
        SnapshotOutputValidation::Complete
    );
}

#[tokio::test]
async fn validate_snapshot_output_rejects_marker_with_trailing_content() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    let mut marker = SNAPSHOT_COMPLETE_MARKER_CONTENT.to_vec();
    marker.push(b'x');
    tokio::fs::write(output.complete_marker(), marker)
        .await
        .expect("write marker with trailing content");

    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate marker with trailing content"),
        SnapshotOutputValidation::InvalidCompleteMarker(output.complete_marker())
    );
}

#[tokio::test]
async fn validate_snapshot_output_reports_missing_artifact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
        .await
        .expect("write valid marker");
    tokio::fs::remove_file(output.cow_bitmap())
        .await
        .expect("remove bitmap");

    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate missing artifact"),
        SnapshotOutputValidation::MissingFile(output.cow_bitmap())
    );
}

#[tokio::test]
async fn validate_snapshot_output_reports_non_regular_artifact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
        .await
        .expect("write valid marker");
    tokio::fs::remove_file(output.snapshot())
        .await
        .expect("remove snapshot");
    tokio::fs::create_dir(output.snapshot())
        .await
        .expect("replace snapshot with directory");

    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate directory artifact"),
        SnapshotOutputValidation::NotRegularFile(output.snapshot())
    );
}

#[tokio::test]
async fn validate_snapshot_output_reports_non_regular_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    tokio::fs::create_dir_all(output.complete_marker())
        .await
        .expect("create marker directory");

    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate directory marker"),
        SnapshotOutputValidation::NotRegularFile(output.complete_marker())
    );
}

#[tokio::test]
async fn validate_snapshot_output_rejects_symlinked_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
    write_required_snapshot_artifacts(&output).await;
    let target = dir.path().join("complete-marker-target");
    tokio::fs::write(&target, SNAPSHOT_COMPLETE_MARKER_CONTENT)
        .await
        .expect("write marker symlink target");
    std::os::unix::fs::symlink(&target, output.complete_marker())
        .expect("create complete marker symlink");

    assert_eq!(
        validate_snapshot_output(&output)
            .await
            .expect("validate symlinked marker"),
        SnapshotOutputValidation::NotRegularFile(output.complete_marker())
    );
}

#[tokio::test]
async fn validate_snapshot_output_propagates_marker_metadata_errors() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output_dir = dir.path().join("snapshot-output");
    std::os::unix::fs::symlink("snapshot-output", &output_dir)
        .expect("create output directory symlink loop");
    let output = SnapshotOutputPaths::new(output_dir);

    let err = validate_snapshot_output(&output)
        .await
        .expect_err("marker metadata should fail through a symlink loop");
    assert!(
        err.to_string().contains("stat snapshot complete marker"),
        "error should include metadata action: {err}"
    );
    assert!(
        err.to_string()
            .contains(&output.complete_marker().display().to_string()),
        "error should include marker path: {err}"
    );
}
