use super::entry::valid_generation;
use super::metadata::{HomeImageFileIdentity, validate_image_file_identity};
use crate::error::{LifecycleError, LifecycleResult};
use serde::Deserialize;
use std::path::Path;

/// GC's physical commit contract. Consumer addressing, eligibility and history
/// fields can evolve independently; decoding them grants no reclamation safety.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GcMetadata {
    pub(super) image_generation: String,
    pub(super) current_image: HomeImageFileIdentity,
    pub(super) logical_image_size_bytes: u64,
    pub(super) last_used_at: String,
}

impl GcMetadata {
    pub(super) fn validate_current_image(
        &self,
        observed: &std::fs::Metadata,
    ) -> LifecycleResult<()> {
        validate_image_file_identity(self.logical_image_size_bytes, self.current_image, observed)
    }
}

pub(super) async fn read_gc_metadata_file(path: &Path) -> LifecycleResult<GcMetadata> {
    let bytes = runner_host::state_file::read_to_bytes_required(
        path,
        runner_host::state_file::HOME_METADATA_MAX_BYTES,
        runner_host::state_file::OwnerCheck::None,
    )
    .await?;
    let metadata: GcMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| LifecycleError::Internal(format!("parse {}: {error}", path.display())))?;
    if !valid_generation(&metadata.image_generation)
        || metadata.logical_image_size_bytes == 0
        || metadata.current_image.len != metadata.logical_image_size_bytes
    {
        return Err(LifecycleError::Internal(
            "invalid physical home metadata".into(),
        ));
    }
    Ok(metadata)
}
