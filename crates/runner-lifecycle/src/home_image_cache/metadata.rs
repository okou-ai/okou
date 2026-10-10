use super::fs::{allocated_bytes, sync_directory, sync_private_file};
use super::types::HomeCacheTerminalStatus;
use super::{CACHE_FORMAT_VERSION, HOME_DRIVE_LAYOUT, HomeImageCache};
use crate::error::{LifecycleError, LifecycleResult};
use crate::storage_fingerprints::StorageFingerprints;
use guest_contracts::home_cache_history::HomeCacheHistoryProofBinding;
use runner_types::ids::RunId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use tokio::fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HomeCacheState {
    Current,
    Dirty,
    Invalid,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HomeTrust {
    Clean,
}

/// The only authority selecting an immutable generation image. All fields are
/// required: this decoder is not a reader/migrator for any prior disk format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HomeCacheMetadata {
    pub(super) format_version: u32,
    pub(super) cache_scope: String,
    pub(super) profile_name: String,
    pub(super) rootfs_hash: String,
    pub(super) reuse_key: String,
    pub(super) working_dir: String,
    pub(super) fingerprint_scope: String,
    pub(super) image_generation: String,
    pub(super) history_proof: Option<HomeCacheHistoryProofBinding>,
    pub(super) last_completed_at: String,
    pub(super) last_used_at: String,
    pub(super) last_terminal_status: HomeCacheTerminalStatus,
    pub(super) home_trust: HomeTrust,
    pub(super) logical_image_size_bytes: u64,
    pub(super) allocated_bytes: u64,
    pub(super) current_image: HomeImageFileIdentity,
    pub(super) drive_layout: String,
    pub(super) storage_fingerprints: StorageFingerprints,
    pub(super) state: HomeCacheState,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HomeCacheScopeClassification {
    Unclassified,
    Relevant,
    Foreign,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HomeImageFileIdentity {
    pub(super) dev: u64,
    pub(super) ino: u64,
    pub(super) len: u64,
    pub(super) modified_seconds: i64,
    pub(super) modified_nanoseconds: i64,
}
impl HomeImageFileIdentity {
    pub(super) fn from_metadata(m: &std::fs::Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            modified_seconds: m.mtime(),
            modified_nanoseconds: m.mtime_nsec(),
        }
    }
}

pub(super) fn validate_history_binding(
    binding: &HomeCacheHistoryProofBinding,
    generation: &str,
) -> LifecycleResult<()> {
    binding
        .validate()
        .map_err(|e| LifecycleError::Internal(format!("home history proof: {e}")))?;
    if binding.proof.generation != generation || !super::entry::valid_generation(generation) {
        return Err(LifecycleError::Internal(
            "home history proof generation mismatch".into(),
        ));
    }
    let canonical = binding
        .proof
        .to_json_vec()
        .map_err(|e| LifecycleError::Internal(format!("home history proof encoding: {e}")))?;
    if hex::encode(Sha256::digest(&canonical)) != binding.sha256 {
        return Err(LifecycleError::Internal(
            "home history proof digest mismatch".into(),
        ));
    }
    Ok(())
}

impl HomeImageCache {
    pub(super) async fn classify_metadata_scope(
        &self,
        key: &str,
        path: &Path,
    ) -> HomeCacheScopeClassification {
        let Ok(metadata) = self.read_metadata_file(path).await else {
            return HomeCacheScopeClassification::Unclassified;
        };
        if !self.metadata_matches_cache_key(key, &metadata) {
            return HomeCacheScopeClassification::Unclassified;
        }
        if metadata.cache_scope == self.inner.cache_scope {
            HomeCacheScopeClassification::Relevant
        } else {
            HomeCacheScopeClassification::Foreign
        }
    }

    pub(super) async fn read_valid_metadata(
        &self,
        path: &Path,
        profile: &str,
        rootfs_hash: &str,
        reuse_key: &str,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> LifecycleResult<Option<HomeCacheMetadata>> {
        let mut metadata = match self.read_metadata_file(path).await {
            Ok(value) => value,
            Err(LifecycleError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        validate_metadata(
            &metadata,
            &self.inner.cache_scope,
            profile,
            rootfs_hash,
            reuse_key,
            working_dir,
            image_size_bytes,
        )?;
        let key = self.scoped_cache_key(
            profile,
            rootfs_hash,
            reuse_key,
            working_dir,
            image_size_bytes,
        );
        let image = self
            .entry_paths(&key)
            .image(&metadata.image_generation)
            .ok_or_else(|| LifecycleError::Internal("invalid home generation".into()))?;
        let observed = match fs::symlink_metadata(&image).await {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        validate_current_image_identity(&metadata, &observed)?;
        runner_host::host_file::validate_private_file_destination(&image, "committed home image")?;
        metadata.allocated_bytes = allocated_bytes(&observed);
        Ok(Some(metadata))
    }

    pub(super) async fn metadata_matches_current_image(
        &self,
        key: &str,
        metadata: &HomeCacheMetadata,
    ) -> bool {
        let Some(path) = self.entry_paths(key).image(&metadata.image_generation) else {
            return false;
        };
        fs::symlink_metadata(path)
            .await
            .is_ok_and(|m| validate_current_image_identity(metadata, &m).is_ok())
    }

    pub(super) async fn read_metadata_file(
        &self,
        path: &Path,
    ) -> LifecycleResult<HomeCacheMetadata> {
        let bytes = runner_host::state_file::read_to_bytes_required(
            path,
            runner_host::state_file::HOME_METADATA_MAX_BYTES,
            runner_host::state_file::OwnerCheck::None,
        )
        .await?;
        let metadata: HomeCacheMetadata = serde_json::from_slice(&bytes)
            .map_err(|e| LifecycleError::Internal(format!("parse {}: {e}", path.display())))?;
        validate_metadata_structure(&metadata)?;
        Ok(metadata)
    }

    /// Caller holds entry and capacity locks and has already synced the pinned
    /// generation image. A late error may mean the commit became visible: never
    /// delete that candidate in response to an ambiguous rename/directory-sync.
    pub(super) async fn write_metadata(
        &self,
        key: &str,
        run_id: RunId,
        metadata: HomeCacheMetadata,
    ) -> LifecycleResult<()> {
        validate_metadata_structure(&metadata)?;
        if metadata.image_generation != run_id.to_string()
            || !self.metadata_matches_cache_key(key, &metadata)
        {
            return Err(LifecycleError::Internal(
                "home metadata publication identity mismatch".into(),
            ));
        }
        let paths = self.entry_paths(key);
        self.ensure_home_cache_entry_dir(key).await?;
        let bytes = serde_json::to_vec(&metadata)
            .map_err(|e| LifecycleError::Internal(format!("serialize home metadata: {e}")))?;
        if bytes.len() as u64 > runner_host::state_file::HOME_METADATA_MAX_BYTES {
            return Err(LifecycleError::Internal(
                "home metadata exceeds bound".into(),
            ));
        }
        let tmp = paths.tmp_metadata(run_id);
        // Never overwrite another attempt's staging path.
        runner_host::host_file::write_private_new(&tmp, &bytes, "home metadata staging").await?;
        sync_private_file(&tmp).await?;
        sync_directory(paths.entry_dir()).await?;
        #[cfg(test)]
        self.publication_fault(super::PublicationFault::BeforeMetadataRename)?;
        fs::rename(&tmp, paths.metadata()).await?;
        #[cfg(test)]
        self.publication_fault(super::PublicationFault::AfterMetadataRename)?;
        sync_directory(paths.entry_dir()).await?;
        Ok(())
    }
}

pub(super) fn validate_metadata_structure(metadata: &HomeCacheMetadata) -> LifecycleResult<()> {
    if metadata.format_version != CACHE_FORMAT_VERSION
        || metadata.drive_layout != HOME_DRIVE_LAYOUT
        || metadata.fingerprint_scope != "/home/user"
        || metadata.rootfs_hash.is_empty()
        || !super::entry::valid_generation(&metadata.image_generation)
        || metadata.logical_image_size_bytes == 0
        || metadata.current_image.len != metadata.logical_image_size_bytes
        || !super::path_safety::is_safe_guest_working_dir(&metadata.working_dir)
        || super::path_safety::filter_storage_fingerprints_for_home(&metadata.storage_fingerprints)
            != metadata.storage_fingerprints
    {
        return Err(LifecycleError::Internal(
            "invalid canonical home metadata".into(),
        ));
    }
    if metadata.last_terminal_status != HomeCacheTerminalStatus::Success
        && metadata
            .storage_fingerprints
            .storages
            .values()
            .chain(metadata.storage_fingerprints.artifacts.values())
            .any(|f| !f.is_tainted())
    {
        return Err(LifecycleError::Internal(
            "non-success home metadata contains known state".into(),
        ));
    }
    if let Some(binding) = &metadata.history_proof {
        validate_history_binding(binding, &metadata.image_generation)?;
    }
    Ok(())
}

fn validate_metadata(
    metadata: &HomeCacheMetadata,
    scope: &str,
    profile: &str,
    rootfs_hash: &str,
    reuse_key: &str,
    working_dir: &str,
    size: u64,
) -> LifecycleResult<()> {
    validate_metadata_structure(metadata)?;
    if metadata.cache_scope != scope
        || metadata.profile_name != profile
        || metadata.rootfs_hash != rootfs_hash
        || metadata.reuse_key != reuse_key
        || metadata.working_dir != working_dir
        || metadata.logical_image_size_bytes != size
        || metadata.state != HomeCacheState::Current
        || metadata.home_trust != HomeTrust::Clean
    {
        return Err(LifecycleError::Internal(
            "home metadata identity/state mismatch".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_current_image_identity(
    metadata: &HomeCacheMetadata,
    current: &std::fs::Metadata,
) -> LifecycleResult<()> {
    if !current.is_file()
        || current.nlink() != 1
        || metadata.current_image != HomeImageFileIdentity::from_metadata(current)
        || metadata.logical_image_size_bytes != current.len()
    {
        return Err(LifecycleError::Internal(
            "home image identity mismatch".into(),
        ));
    }
    Ok(())
}
