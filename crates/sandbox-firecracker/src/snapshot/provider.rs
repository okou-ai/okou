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
/// Creation requires the caller-controlled exclusive output access documented
/// on [`SnapshotCreateConfig::output_dir`], including its destructive replacement
/// and publication/discard lifetime requirements. This provider does not acquire
/// the snapshot lock or equivalent coordination for the caller. Both
/// [`SnapshotProvider`] creation methods follow that contract.
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
mod tests;
