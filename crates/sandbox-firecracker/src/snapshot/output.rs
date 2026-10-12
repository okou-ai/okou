use std::fmt;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use tokio::runtime::{Handle, RuntimeFlavor};

use crate::paths::SnapshotOutputPaths;

use super::SnapshotError;

/// Exact versioned payload written to [`SnapshotOutputPaths::complete_marker`].
///
/// Writers must use the full byte sequence verbatim, including the trailing
/// line feed (`\n`), after all required snapshot artifacts are present as
/// regular files and the output directory has been synced. Readers must compare
/// the full sequence without trimming or reconstructing it.
///
/// The marker is the snapshot publication commit signal, not standalone proof
/// of completeness: [`crate::FirecrackerSnapshotProvider`] also validates the
/// required artifact files. The marker includes the paired home layout so old
/// workspace snapshots cannot pass completeness under the home-drive reader.
/// Changing the layout/version or any other byte is a compatibility
/// change for independently deployed readers and writers.
pub const SNAPSHOT_COMPLETE_MARKER_CONTENT: &[u8] = b"snapshot-complete-v2:home-drive-v1\n";

/// Result of validating a Firecracker snapshot output directory.
#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotOutputValidation {
    /// The exact completion marker and every required artifact are valid.
    Complete,
    /// A required artifact or the completion marker is absent.
    MissingFile(PathBuf),
    /// A required snapshot artifact or the completion marker is not a regular file.
    NotRegularFile(PathBuf),
    /// The completion marker exists but does not contain the exact expected bytes.
    InvalidCompleteMarker(PathBuf),
}

impl fmt::Display for SnapshotOutputValidation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Complete => f.write_str("snapshot output is complete"),
            Self::MissingFile(path) => {
                write!(f, "required snapshot file not found: {}", path.display())
            }
            Self::NotRegularFile(path) => {
                write!(
                    f,
                    "snapshot artifact is not a regular file: {}",
                    path.display()
                )
            }
            Self::InvalidCompleteMarker(path) => {
                write!(f, "snapshot complete marker is invalid: {}", path.display())
            }
        }
    }
}

fn io_error_with_path(action: &str, path: &Path, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("{action} {}: {error}", path.display()),
    )
}

fn non_file_snapshot_artifact_error(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "snapshot artifact is not a regular file: {}",
            path.display()
        ),
    )
}

fn require_snapshot_artifact_regular_file_sync(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| io_error_with_path("stat snapshot artifact", path, e))?;
    if !metadata.file_type().is_file() {
        return Err(non_file_snapshot_artifact_error(path));
    }
    Ok(())
}

pub(super) fn run_snapshot_blocking_fs<T>(f: impl FnOnce() -> T) -> T {
    match Handle::try_current() {
        Ok(handle) => match handle.runtime_flavor() {
            RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
            RuntimeFlavor::CurrentThread => f(),
            _ => f(),
        },
        Err(_) => f(),
    }
}

/// Validates the complete Firecracker snapshot artifact contract.
///
/// Missing, malformed, and non-regular entries are ordinary incomplete
/// outcomes. Filesystem failures that prevent validation are returned as I/O
/// errors with the affected path in their context.
pub async fn validate_snapshot_output(
    output: &SnapshotOutputPaths,
) -> io::Result<SnapshotOutputValidation> {
    let marker = output.complete_marker();
    match tokio::fs::symlink_metadata(&marker).await {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Ok(SnapshotOutputValidation::NotRegularFile(marker)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(SnapshotOutputValidation::MissingFile(marker));
        }
        Err(e) => {
            return Err(io_error_with_path(
                "stat snapshot complete marker",
                &marker,
                e,
            ));
        }
    }

    let file = match tokio::fs::File::open(&marker).await {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(SnapshotOutputValidation::MissingFile(marker));
        }
        Err(e) => {
            return Err(io_error_with_path(
                "read snapshot complete marker",
                &marker,
                e,
            ));
        }
    };
    let read_limit = SNAPSHOT_COMPLETE_MARKER_CONTENT.len() + 1;
    let mut content = Vec::with_capacity(read_limit);
    if let Err(e) = file.take(read_limit as u64).read_to_end(&mut content).await {
        return Err(io_error_with_path(
            "read snapshot complete marker",
            &marker,
            e,
        ));
    }
    if content != SNAPSHOT_COMPLETE_MARKER_CONTENT {
        return Ok(SnapshotOutputValidation::InvalidCompleteMarker(marker));
    }

    for artifact in output.required_artifacts() {
        match tokio::fs::symlink_metadata(&artifact).await {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => return Ok(SnapshotOutputValidation::NotRegularFile(artifact)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(SnapshotOutputValidation::MissingFile(artifact));
            }
            Err(e) => return Err(io_error_with_path("stat snapshot artifact", &artifact, e)),
        }
    }
    Ok(SnapshotOutputValidation::Complete)
}

pub(super) fn remove_file_if_exists_sync(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub(super) fn remove_dir_all_if_exists_sync(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub(super) fn cleanup_remove_file_result(
    result: std::io::Result<()>,
    path: &Path,
    warning: &'static str,
) -> bool {
    match result {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "{warning}"
            );
            false
        }
    }
}

pub(super) fn cleanup_home_image_file_sync(path: &Path, warning: &'static str) -> bool {
    cleanup_remove_file_result(std::fs::remove_file(path), path, warning)
}

pub(super) fn cleanup_remove_dir_result(
    result: std::io::Result<()>,
    dir: &Path,
    warning: &'static str,
) -> bool {
    match result {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                dir = %dir.display(),
                "{warning}"
            );
            false
        }
    }
}

pub(super) async fn prepare_snapshot_output(
    output: &SnapshotOutputPaths,
) -> Result<PathBuf, SnapshotError> {
    // Paths inside work_dir get baked into the snapshot and are used as
    // bind-mount targets during restore, so they must be deterministic.
    //
    // Only remove snapshot-specific artifacts, not the entire output directory.
    //
    // Use synchronous filesystem calls for shared snapshot-hash paths while the
    // caller holds the snapshot lock. A cancelled Tokio fs operation can keep
    // running on the blocking pool after the lock is dropped.
    run_snapshot_blocking_fs(|| prepare_snapshot_output_sync(output))
}

fn prepare_snapshot_output_sync(output: &SnapshotOutputPaths) -> Result<PathBuf, SnapshotError> {
    let work = output.work_dir();
    remove_file_if_exists_sync(&output.complete_marker())?;
    remove_dir_all_if_exists_sync(&work)?;
    for stale in output.required_artifacts() {
        remove_file_if_exists_sync(&stale)?;
    }
    std::fs::create_dir_all(&work)?;
    Ok(work)
}

pub(super) fn sync_snapshot_output_dir(output: &SnapshotOutputPaths) -> Result<(), SnapshotError> {
    std::fs::File::open(output.dir())?.sync_all()?;
    Ok(())
}

pub(super) fn publish_snapshot_complete_marker(
    output: &SnapshotOutputPaths,
) -> Result<(), SnapshotError> {
    publish_snapshot_complete_marker_with_syncs(
        output,
        std::fs::File::sync_all,
        std::fs::File::sync_all,
    )
}

fn publish_snapshot_complete_marker_with_syncs(
    output: &SnapshotOutputPaths,
    sync_marker: impl FnOnce(&std::fs::File) -> io::Result<()>,
    mut sync_output_dir: impl FnMut(&std::fs::File) -> io::Result<()>,
) -> Result<(), SnapshotError> {
    let marker = output.complete_marker();
    let mut marker_created = false;

    let result = (|| -> std::io::Result<()> {
        for artifact in output.required_artifacts() {
            require_snapshot_artifact_regular_file_sync(&artifact)?;
        }

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)?;
        marker_created = true;
        file.write_all(SNAPSHOT_COMPLETE_MARKER_CONTENT)?;
        sync_marker(&file)?;
        drop(file);

        let output_dir = std::fs::File::open(output.dir())?;
        sync_output_dir(&output_dir)?;
        Ok(())
    })();

    if let Err(e) = result {
        if marker_created {
            // If marker publication fails after creating the file, remove it so
            // future readers do not treat an uncommitted publish as complete.
            let _ = std::fs::remove_file(&marker);
            let _ = std::fs::File::open(output.dir()).and_then(|dir| sync_output_dir(&dir));
        }
        return Err(SnapshotError::Io(e));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
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
                let content =
                    std::fs::read(&marker).expect("read marker before injected sync failure");
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

        let err =
            publish_snapshot_complete_marker_with_syncs(&output, std::fs::File::sync_all, |_| {
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

        let err = publish_snapshot_complete_marker(&output)
            .expect_err("publish should fail before marker");

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

        let err =
            publish_snapshot_complete_marker(&output).expect_err("publish should fail on marker");

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
}
