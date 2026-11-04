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
mod tests;
