//! Opportunistic session-history storage attached to workspace image cache entries.
//!
//! A sidecar keeps the history bytes needed to resume the session associated
//! with a cached workspace image. It is a local optimization, not an
//! authoritative history store: a probe miss, or a non-cancellation failure to
//! materialize or restore a probed body, falls back to the authoritative
//! session-history materializer.
//!
//! ## Probe contract
//!
//! A probe accepts only supported metadata whose framework, hashed session ID,
//! history reference kind, history hash, and raw history size exactly match the
//! requested restored-session identity. A raw body is accepted only when its
//! encoded length equals the raw history size; a `CodexZstd` body is accepted
//! only for Codex. The encoded size must also be nonzero and within the
//! resume-history limit. The referenced body must still be a regular file with
//! the recorded file identity and encoded length. Probe failures are classified
//! by `WorkspaceSessionHistorySidecarMiss`, whose stable values let callers
//! record why remote materialization was used instead.
//!
//! ## Publication contract
//!
//! Publication runs while the workspace cache entry is guarded. Promotion can
//! preserve the committed sidecar after consuming a cache hit, replace it from
//! a staged source, or prune it when a non-hit workspace has no replacement. A
//! replacement source must be a regular file whose actual length matches its
//! declared nonzero encoded size, must fit the resume-history limit, and must
//! carry complete restored-session cache identity fields. An invalid source is
//! discarded without changing the committed metadata/body pair.
//!
//! Replacement alternates between two body slots. It writes new metadata to a
//! temporary file, moves the staged body into the inactive slot, and atomically
//! renames the metadata into place as the commit point. Before that rename, the
//! previous metadata still selects the previous body, so a failed replacement
//! leaves the last committed sidecar usable. Only after the metadata commit does
//! publication attempt to remove the old body slot.
//!
//! Sidecar publication is best-effort relative to workspace image promotion. A
//! sidecar failure does not reject an otherwise valid image promotion, but a
//! failure to publish the enclosing workspace cache metadata removes the image
//! and prunes the sidecar. The sidecar metadata and both body slots belong to
//! the cache entry and participate in its inspection, allocated-byte accounting,
//! garbage collection, and cleanup.

use std::path::Path;

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::session_history_identity::{SessionHistoryFramework, SessionHistoryRefKind};
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::restored_session_identity::{RestoredSessionIdentity, RestoredSessionIdentityFields};

use super::fs::{
    remove_workspace_cache_path_if_exists, secure_workspace_cache_publication_file,
    workspace_cache_existing_path_allocated_bytes,
};
use super::metadata::WorkspaceImageFileIdentity;
use super::types::{
    WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss,
    WorkspaceSessionHistorySidecarPromotionSource, WorkspaceSessionHistorySidecarPublication,
    WorkspaceSessionHistorySidecarRepresentation,
};
use super::{WorkspaceImageCache, entry::CacheEntryPaths};

const SESSION_HISTORY_SIDECAR_FORMAT_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceSessionHistorySidecarBodySlot {
    First,
    Second,
}

impl WorkspaceSessionHistorySidecarBodySlot {
    const ALL: [Self; 2] = [Self::First, Self::Second];

    fn next(metadata: Option<&WorkspaceSessionHistorySidecarMetadata>) -> Self {
        match metadata.map(|metadata| metadata.body_slot) {
            Some(Self::First) => Self::Second,
            Some(Self::Second) | None => Self::First,
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::First => "session-history.first.blob",
            Self::Second => "session-history.second.blob",
        }
    }
}

fn session_history_sidecar_body_paths(paths: &CacheEntryPaths) -> [std::path::PathBuf; 2] {
    WorkspaceSessionHistorySidecarBodySlot::ALL
        .map(|body_slot| paths.entry_dir().join(body_slot.file_name()))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSessionHistorySidecarMetadata {
    version: u8,
    framework: SessionHistoryFramework,
    session_id_hash: String,
    history_ref_kind: SessionHistoryRefKind,
    history_hash: String,
    history_size_bytes: u64,
    representation: WorkspaceSessionHistorySidecarRepresentation,
    encoded_size: u64,
    body_file: WorkspaceImageFileIdentity,
    body_slot: WorkspaceSessionHistorySidecarBodySlot,
}

impl WorkspaceSessionHistorySidecarMetadata {
    fn from_source(
        source: &WorkspaceSessionHistorySidecarPromotionSource,
        body_metadata: &std::fs::Metadata,
        body_slot: WorkspaceSessionHistorySidecarBodySlot,
    ) -> Option<Self> {
        let RestoredSessionIdentityFields {
            framework,
            session_id_hash,
            history_ref_kind,
            history_hash,
            history_size_bytes,
        } = source.restored_session_identity.cache_fields()?;
        Some(Self {
            version: SESSION_HISTORY_SIDECAR_FORMAT_VERSION,
            framework,
            session_id_hash: session_id_hash.to_owned(),
            history_ref_kind,
            history_hash: history_hash.to_owned(),
            history_size_bytes,
            representation: source.representation,
            encoded_size: source.encoded_size,
            body_file: WorkspaceImageFileIdentity::from_metadata(body_metadata),
            body_slot,
        })
    }

    fn body_path(&self, paths: &CacheEntryPaths) -> std::path::PathBuf {
        paths.entry_dir().join(self.body_slot.file_name())
    }

    fn validate_for_request(
        &self,
        expected: &RestoredSessionIdentity,
    ) -> Result<(), WorkspaceSessionHistorySidecarMiss> {
        if self.version != SESSION_HISTORY_SIDECAR_FORMAT_VERSION {
            return Err(WorkspaceSessionHistorySidecarMiss::InvalidMetadata);
        }
        if self.encoded_size == 0 || self.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES {
            return Err(WorkspaceSessionHistorySidecarMiss::InvalidMetadata);
        }
        let fields = expected
            .cache_fields()
            .ok_or(WorkspaceSessionHistorySidecarMiss::IdentityMismatch)?;
        if self.framework != fields.framework
            || self.session_id_hash != fields.session_id_hash
            || self.history_ref_kind != fields.history_ref_kind
            || self.history_hash != fields.history_hash
            || self.history_size_bytes != fields.history_size_bytes
        {
            return Err(WorkspaceSessionHistorySidecarMiss::IdentityMismatch);
        }
        match (self.framework, self.representation) {
            (_, WorkspaceSessionHistorySidecarRepresentation::Raw)
                if self.encoded_size == self.history_size_bytes =>
            {
                Ok(())
            }
            (
                SessionHistoryFramework::Codex,
                WorkspaceSessionHistorySidecarRepresentation::CodexZstd,
            ) => Ok(()),
            _ => Err(WorkspaceSessionHistorySidecarMiss::UnsupportedFormat),
        }
    }

    fn validate_body_metadata(
        &self,
        body_metadata: &std::fs::Metadata,
    ) -> Result<(), WorkspaceSessionHistorySidecarMiss> {
        if !body_metadata.is_file()
            || WorkspaceImageFileIdentity::from_metadata(body_metadata) != self.body_file
            || body_metadata.len() != self.encoded_size
        {
            return Err(WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch);
        }
        Ok(())
    }
}

impl WorkspaceImageCache {
    runner_test_support!(storage; #[cfg(test)]
    pub(super) fn fail_next_session_history_sidecar_metadata_commit(&self) {
        self.inner
            .fail_next_session_history_sidecar_metadata_commit
            .store(true, std::sync::atomic::Ordering::Relaxed);
    });

    async fn commit_session_history_sidecar_metadata(
        &self,
        tmp_metadata_path: &Path,
        sidecar_metadata_path: &Path,
    ) -> std::io::Result<()> {
        #[cfg(test)]
        if self
            .inner
            .fail_next_session_history_sidecar_metadata_commit
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err(std::io::Error::other(
                "injected workspace session history sidecar metadata commit failure",
            ));
        }
        fs::rename(tmp_metadata_path, sidecar_metadata_path).await
    }

    pub(super) async fn probe_session_history_sidecar(
        &self,
        cache_key: &str,
        expected: &RestoredSessionIdentity,
    ) -> Result<WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss> {
        let paths = self.entry_paths(cache_key);
        let metadata = self
            .read_session_history_sidecar_metadata(paths.session_history_sidecar_metadata())
            .await?;
        metadata.validate_for_request(expected)?;
        let body_path = metadata.body_path(&paths);
        let body_metadata = fs::symlink_metadata(&body_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                WorkspaceSessionHistorySidecarMiss::BodyMissing
            } else {
                WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch
            }
        })?;
        metadata.validate_body_metadata(&body_metadata)?;
        Ok(WorkspaceSessionHistorySidecar {
            path: body_path,
            representation: metadata.representation,
            encoded_size: metadata.encoded_size,
        })
    }

    pub(super) async fn publish_session_history_sidecar(
        &self,
        cache_key: &str,
        run_id: RunId,
        publication: WorkspaceSessionHistorySidecarPublication<'_>,
    ) -> RunnerResult<()> {
        match publication {
            WorkspaceSessionHistorySidecarPublication::PreserveExisting => {}
            WorkspaceSessionHistorySidecarPublication::Replace(source) => {
                let paths = self.entry_paths(cache_key);
                self.publish_session_history_sidecar_source(cache_key, run_id, &paths, source)
                    .await?;
            }
            WorkspaceSessionHistorySidecarPublication::Prune => {
                self.prune_session_history_sidecar(cache_key).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn discard_session_history_sidecar_source(
        &self,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) {
        let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
    }

    pub(super) async fn session_history_sidecar_allocated_bytes(
        &self,
        paths: &CacheEntryPaths,
    ) -> u64 {
        let mut allocated = 0_u64;
        for body_path in session_history_sidecar_body_paths(paths) {
            allocated = allocated.saturating_add(
                workspace_cache_existing_path_allocated_bytes(&body_path)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or(0),
            );
        }
        allocated.saturating_add(
            workspace_cache_existing_path_allocated_bytes(paths.session_history_sidecar_metadata())
                .await
                .ok()
                .flatten()
                .unwrap_or(0),
        )
    }

    async fn publish_session_history_sidecar_source(
        &self,
        cache_key: &str,
        run_id: RunId,
        paths: &CacheEntryPaths,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) -> RunnerResult<()> {
        self.ensure_workspace_cache_entry_dir(cache_key).await?;
        let tmp_metadata = fs::symlink_metadata(&source.tmp_path).await?;
        if !tmp_metadata.is_file()
            || tmp_metadata.len() != source.encoded_size
            || source.encoded_size == 0
            || source.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES
        {
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Ok(());
        }
        if let Err(e) = secure_workspace_cache_publication_file(&source.tmp_path) {
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Err(e);
        }
        let previous_metadata = self
            .read_session_history_sidecar_metadata(paths.session_history_sidecar_metadata())
            .await
            .ok();
        let body_slot = WorkspaceSessionHistorySidecarBodySlot::next(previous_metadata.as_ref());
        let Some(sidecar_metadata) =
            WorkspaceSessionHistorySidecarMetadata::from_source(source, &tmp_metadata, body_slot)
        else {
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Ok(());
        };
        let tmp_metadata_path = paths.tmp_session_history_sidecar_metadata(run_id);
        let sidecar_metadata_path = paths.session_history_sidecar_metadata();
        let sidecar_body_path = paths.entry_dir().join(body_slot.file_name());
        let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
        let bytes = serde_json::to_vec_pretty(&sidecar_metadata).map_err(|e| {
            RunnerError::Internal(format!("serialize workspace session history sidecar: {e}"))
        })?;
        if let Err(e) = crate::host_file::write_private_new(
            &tmp_metadata_path,
            &bytes,
            "workspace session history metadata staging file",
        )
        .await
        {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Err(e.into());
        }
        if let Err(e) = secure_workspace_cache_publication_file(&tmp_metadata_path) {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Err(e);
        }
        if let Err(e) = fs::rename(&source.tmp_path, &sidecar_body_path).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Err(e.into());
        }
        if let Err(e) = self
            .commit_session_history_sidecar_metadata(&tmp_metadata_path, sidecar_metadata_path)
            .await
        {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(&sidecar_body_path).await;
            return Err(e.into());
        }
        for body_path in session_history_sidecar_body_paths(paths) {
            if body_path != sidecar_body_path {
                let _ = remove_workspace_cache_path_if_exists(&body_path).await;
            }
        }
        Ok(())
    }

    pub(super) async fn prune_session_history_sidecar(&self, cache_key: &str) -> RunnerResult<()> {
        let paths = self.entry_paths(cache_key);
        let metadata_result =
            remove_workspace_cache_path_if_exists(paths.session_history_sidecar_metadata()).await;
        let [first_body_path, second_body_path] = session_history_sidecar_body_paths(&paths);
        let first_body_result = remove_workspace_cache_path_if_exists(&first_body_path).await;
        let second_body_result = remove_workspace_cache_path_if_exists(&second_body_path).await;
        metadata_result?;
        first_body_result?;
        second_body_result?;
        Ok(())
    }

    async fn read_session_history_sidecar_metadata(
        &self,
        path: &Path,
    ) -> Result<WorkspaceSessionHistorySidecarMetadata, WorkspaceSessionHistorySidecarMiss> {
        let bytes = crate::state_file::read_to_bytes_required(
            path,
            crate::state_file::WORKSPACE_METADATA_MAX_BYTES,
            crate::state_file::OwnerCheck::None,
        )
        .await
        .map_err(|error| match error {
            RunnerError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
                WorkspaceSessionHistorySidecarMiss::Missing
            }
            _ => WorkspaceSessionHistorySidecarMiss::InvalidMetadata,
        })?;
        serde_json::from_slice(&bytes)
            .map_err(|_| WorkspaceSessionHistorySidecarMiss::InvalidMetadata)
    }
}
