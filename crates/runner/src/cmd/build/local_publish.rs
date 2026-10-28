use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::RootfsPaths;

pub(super) struct LocalFilePublish {
    staging: PathBuf,
    stable: PathBuf,
    sidecar: PathBuf,
}

impl LocalFilePublish {
    pub(super) fn for_rootfs(rootfs: &RootfsPaths) -> Self {
        Self {
            staging: rootfs.rootfs_staging(),
            stable: rootfs.rootfs(),
            sidecar: rootfs.okou_cli_manifest(),
        }
    }

    pub(super) fn stable(&self) -> &Path {
        &self.stable
    }

    /// Delete any staging file left behind by a previous publish attempt.
    ///
    /// For rootfs this is called under the rootfs flock before work continues,
    /// so any staging file is crash residue, not a live writer's in-progress
    /// file. Non-existence is the common case and not logged. Removal is best
    /// effort: a failure here leaves the next write step to fail or overwrite.
    ///
    /// Keep this synchronous while the caller owns the rootfs lock. A cancelled
    /// Tokio fs operation can continue on the blocking pool after the lock is
    /// dropped, which is not safe for the fixed staging path.
    pub(super) fn cleanup_stale_staging_best_effort(&self) {
        match std::fs::symlink_metadata(&self.staging) {
            Ok(metadata) => {
                tracing::warn!(
                    "removing stale rootfs staging file from a previous failed build: {}",
                    self.staging.display()
                );
                let result = if metadata.file_type().is_dir() {
                    std::fs::remove_dir_all(&self.staging)
                } else {
                    std::fs::remove_file(&self.staging)
                };
                if let Err(e) = result {
                    tracing::warn!(
                        "failed to remove stale staging path {}: {e}",
                        self.staging.display()
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(
                    "check staging {}: {e} (continuing; any residue will be overwritten)",
                    self.staging.display()
                );
            }
        }
    }

    /// Publish trusted installed CLI metadata, then commit staging to stable.
    ///
    /// The service advertises installed versions from the sidecar. The rootfs
    /// hash covers the verified CLI package, not these metadata bytes again.
    /// Keep mutation, exact readback and rename synchronous under the caller's
    /// rootfs flock: cancelling a Tokio fs waiter can otherwise release that
    /// authority before its accepted physical operation finishes.
    ///
    /// The same-filesystem rootfs rename is the atomic visibility step, not a
    /// multi-file transaction or a new crash-durability guarantee.
    pub(super) fn commit(&self, installed_manifest: Option<&[u8]>) -> RunnerResult<()> {
        self.publish_cli_sidecar(installed_manifest)?;
        std::fs::rename(&self.staging, &self.stable).map_err(|e| {
            RunnerError::Internal(format!(
                "commit rootfs {} → {}: {e}",
                self.staging.display(),
                self.stable.display()
            ))
        })
    }

    fn publish_cli_sidecar(&self, installed_manifest: Option<&[u8]>) -> RunnerResult<()> {
        match installed_manifest {
            Some(bytes) => {
                std::fs::write(&self.sidecar, bytes).map_err(|e| {
                    RunnerError::Internal(format!(
                        "write Okou CLI sidecar {}: {e}",
                        self.sidecar.display()
                    ))
                })?;
                let actual = std::fs::read(&self.sidecar).map_err(|e| {
                    RunnerError::Internal(format!(
                        "read cached Okou CLI sidecar {}: {e}",
                        self.sidecar.display()
                    ))
                })?;
                verify_cli_sidecar_bytes(&self.sidecar, &actual, bytes)
            }
            None => match std::fs::remove_file(&self.sidecar) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(RunnerError::Internal(format!(
                    "remove stale Okou CLI sidecar {}: {e}",
                    self.sidecar.display()
                ))),
            },
        }
    }

    pub(super) fn finish_after_result(&self, result: RunnerResult<()>) -> RunnerResult<()> {
        match result {
            Ok(()) => Ok(()),
            Err(original_err) => {
                match remove_file_if_exists_sync(&self.staging, "failed rootfs staging file") {
                    Ok(()) => Err(original_err),
                    Err(cleanup_err) => {
                        tracing::warn!(
                            "failed to remove rootfs staging {} after an earlier error: {cleanup_err}",
                            self.staging.display()
                        );
                        Err(original_err)
                    }
                }
            }
        }
    }
}

pub(super) fn verify_cli_sidecar_bytes(
    path: &Path,
    actual: &[u8],
    expected: &[u8],
) -> RunnerResult<()> {
    if actual != expected {
        return Err(RunnerError::Internal(format!(
            "cached Okou CLI sidecar does not match embedded bundle: {}",
            path.display()
        )));
    }
    Ok(())
}

fn remove_file_if_exists_sync(path: &Path, label: &str) -> RunnerResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove {label} {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod sidecar_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use runner_host::paths::HomePaths;

    #[tokio::test]
    async fn local_file_publish_removes_stale_file_residue() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "cleanup-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"crash-residue")
            .await
            .unwrap();
        assert!(rootfs.rootfs_staging().exists());

        publish.cleanup_stale_staging_best_effort();
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_removes_stale_directory_residue() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "cleanup-dir-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);

        tokio::fs::create_dir_all(rootfs.rootfs_staging().join("nested"))
            .await
            .unwrap();
        tokio::fs::write(
            rootfs.rootfs_staging().join("nested").join("partial"),
            b"leftover",
        )
        .await
        .unwrap();

        publish.cleanup_stale_staging_best_effort();
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_stale_cleanup_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "noop-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // No staging file: must not error.
        publish.cleanup_stale_staging_best_effort();
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_stale_cleanup_leaves_committed_rootfs_alone() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "preserve-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs(), b"real-rootfs")
            .await
            .unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"residue")
            .await
            .unwrap();

        publish.cleanup_stale_staging_best_effort();
        assert!(rootfs.rootfs().exists(), "committed rootfs must survive");
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_finish_removes_staging_after_error() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "failed-cleanup-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"partial-rootfs")
            .await
            .unwrap();

        let err = publish
            .finish_after_result(Err(RunnerError::Internal("customize failed".into())))
            .unwrap_err();

        assert!(err.to_string().contains("customize failed"));
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_finish_preserves_original_error_when_cleanup_fails() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "failed-cleanup-dir-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.rootfs_staging())
            .await
            .unwrap();

        let err = publish
            .finish_after_result(Err(RunnerError::Internal("verify failed".into())))
            .unwrap_err();

        assert!(err.to_string().contains("verify failed"));
        assert!(
            rootfs.rootfs_staging().is_dir(),
            "cleanup failure must not mask the original build error"
        );
    }

    #[tokio::test]
    async fn local_file_publish_commit_renames_to_rootfs() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "commit-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"customized")
            .await
            .unwrap();

        publish.commit(None).unwrap();

        assert!(!rootfs.rootfs_staging().exists());
        assert!(rootfs.rootfs().exists());
        let content = tokio::fs::read(rootfs.rootfs()).await.unwrap();
        assert_eq!(content, b"customized");
    }
}
