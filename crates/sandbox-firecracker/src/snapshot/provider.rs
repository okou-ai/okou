use std::path::Path;

use async_trait::async_trait;
use sandbox::{PendingSnapshotPublish, SnapshotCreateConfig, SnapshotProvider};

use crate::factory::config_hash;
use crate::paths::SnapshotOutputPaths;

use super::output::{SnapshotOutputValidation, validate_snapshot_output};
use super::{SnapshotError, create_uncommitted_snapshot};

/// Firecracker-backed snapshot provider.
///
/// Snapshot creation uses [`SnapshotCreateConfig::id`] as the runtime socket
/// directory identifier. See that field for the Firecracker ID requirements,
/// including the `_52000` guest-control listener suffix and preflight path
/// validation. Other [`SnapshotProvider`] implementations may impose different
/// requirements on the same provider-neutral configuration type.
///
/// Stateless — can be created with zero cost and used immediately.
pub struct FirecrackerSnapshotProvider;

#[async_trait]
impl SnapshotProvider for FirecrackerSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<Box<dyn PendingSnapshotPublish>, sandbox::SnapshotError> {
        let publish = create_uncommitted_snapshot(config)
            .await
            .map_err(SnapshotError::into_sandbox_error)?;
        Ok(Box::new(publish))
    }

    fn config_hash(&self) -> String {
        config_hash()
    }

    async fn is_complete(&self, output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
        let output = SnapshotOutputPaths::new(output_dir.to_path_buf());
        Ok(matches!(
            validate_snapshot_output(&output).await?,
            SnapshotOutputValidation::Complete
        ))
    }
}

#[cfg(test)]
mod tests {
    use sandbox::SnapshotProvider;

    use crate::paths::SnapshotOutputPaths;
    use crate::snapshot::SNAPSHOT_COMPLETE_MARKER_CONTENT;
    use crate::snapshot::output::publish_snapshot_complete_marker;

    use super::*;

    struct SnapshotOutputFixture {
        _dir: tempfile::TempDir,
        output: SnapshotOutputPaths,
    }

    impl SnapshotOutputFixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
            tokio::fs::create_dir_all(output.dir())
                .await
                .expect("create output dir");
            Self { _dir: dir, output }
        }

        async fn write_required_snapshot_artifacts(&self) {
            for artifact in self.output.required_artifacts() {
                tokio::fs::write(&artifact, b"snapshot artifact")
                    .await
                    .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
            }
        }
    }

    async fn write_complete_marker(output: &SnapshotOutputPaths) {
        tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
            .await
            .expect("write complete marker");
    }

    #[tokio::test]
    async fn snapshot_provider_requires_cow_bitmap_for_complete_snapshot() {
        let fixture = SnapshotOutputFixture::new().await;
        let output = &fixture.output;
        fixture.write_required_snapshot_artifacts().await;
        tokio::fs::remove_file(output.cow_bitmap())
            .await
            .expect("remove cow bitmap");

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "snapshot without dirty bitmap sidecar must be incomplete"
        );
        assert!(
            publish_snapshot_complete_marker(output).is_err(),
            "complete marker publication must fail before all artifacts exist"
        );
        assert!(
            !tokio::fs::try_exists(output.complete_marker())
                .await
                .unwrap(),
            "failed marker publication must not leave a marker behind"
        );

        tokio::fs::write(output.cow_bitmap(), b"bitmap")
            .await
            .expect("write cow bitmap");
        publish_snapshot_complete_marker(output).expect("publish complete marker");
        assert!(provider.is_complete(output.dir()).await.unwrap());
    }

    #[tokio::test]
    async fn snapshot_provider_requires_complete_marker_for_complete_snapshot() {
        let fixture = SnapshotOutputFixture::new().await;
        let output = &fixture.output;
        fixture.write_required_snapshot_artifacts().await;

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "snapshot artifacts without complete marker must be incomplete"
        );

        tokio::fs::write(output.complete_marker(), b"wrong marker")
            .await
            .expect("write malformed marker");
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "malformed complete marker must not commit the snapshot"
        );

        tokio::fs::remove_file(output.complete_marker())
            .await
            .expect("remove malformed marker");
        publish_snapshot_complete_marker(output).expect("publish complete marker");
        assert!(provider.is_complete(output.dir()).await.unwrap());
    }

    #[tokio::test]
    async fn snapshot_provider_rejects_symlinked_complete_marker() {
        let fixture = SnapshotOutputFixture::new().await;
        let output = &fixture.output;
        fixture.write_required_snapshot_artifacts().await;
        let target = output.dir().join("complete-marker-target");
        tokio::fs::write(&target, SNAPSHOT_COMPLETE_MARKER_CONTENT)
            .await
            .expect("write marker symlink target");
        std::os::unix::fs::symlink(&target, output.complete_marker())
            .expect("create complete marker symlink");

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "symlinked complete marker must not commit the snapshot"
        );
    }

    #[tokio::test]
    async fn snapshot_provider_rejects_valid_marker_with_missing_artifact() {
        let fixture = SnapshotOutputFixture::new().await;
        let output = &fixture.output;
        fixture.write_required_snapshot_artifacts().await;
        publish_snapshot_complete_marker(output).expect("publish complete marker");
        tokio::fs::remove_file(output.cow_bitmap())
            .await
            .expect("remove cow bitmap");

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "valid marker must not hide a missing snapshot artifact"
        );
    }

    #[tokio::test]
    async fn snapshot_provider_rejects_valid_marker_with_directory_artifact() {
        let fixture = SnapshotOutputFixture::new().await;
        let output = &fixture.output;
        fixture.write_required_snapshot_artifacts().await;
        tokio::fs::remove_file(output.snapshot())
            .await
            .expect("remove snapshot file");
        tokio::fs::create_dir(output.snapshot())
            .await
            .expect("replace snapshot file with directory");
        write_complete_marker(output).await;

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "valid marker must not hide a directory artifact path"
        );
    }

    #[tokio::test]
    async fn snapshot_provider_rejects_valid_marker_with_symlink_artifact() {
        let fixture = SnapshotOutputFixture::new().await;
        let output = &fixture.output;
        fixture.write_required_snapshot_artifacts().await;
        let target = output.dir().join("target-snapshot.bin");
        tokio::fs::write(&target, b"target snapshot")
            .await
            .expect("write symlink target");
        tokio::fs::remove_file(output.snapshot())
            .await
            .expect("remove snapshot file");
        std::os::unix::fs::symlink(&target, output.snapshot())
            .expect("replace snapshot file with symlink");
        write_complete_marker(output).await;

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "valid marker must not hide a symlink artifact path"
        );
    }
}
