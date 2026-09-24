use std::path::{Path, PathBuf};

use runner_host::paths::{
    scoped_workspace_image_cache_key, workspace_image_cache_capacity_lock_path,
    workspace_image_cache_lock_path,
};
use runner_types::ids::RunId;

use super::WorkspaceImageCache;
use super::metadata::WorkspaceCacheMetadata;

const METADATA_FILE_NAME: &str = "metadata.json";
const CURRENT_IMAGE_FILE_NAME: &str = "current.ext4";
const SESSION_HISTORY_SIDECAR_FILE_NAME: &str = "session-history.blob";
const SESSION_HISTORY_SIDECAR_METADATA_FILE_NAME: &str = "session-history.metadata.json";

#[derive(Clone, Debug)]
pub struct CacheEntryPaths {
    entry_dir: PathBuf,
    metadata: PathBuf,
    current_image: PathBuf,
    session_history_sidecar_metadata: PathBuf,
}

impl CacheEntryPaths {
    pub fn new(cache_dir: &Path, cache_key: &str) -> Self {
        Self::from_entry_dir(Self::entry_dir_for(cache_dir, cache_key))
    }

    pub(super) fn from_entry_dir(entry_dir: PathBuf) -> Self {
        Self {
            metadata: entry_dir.join(METADATA_FILE_NAME),
            current_image: entry_dir.join(CURRENT_IMAGE_FILE_NAME),
            session_history_sidecar_metadata: entry_dir
                .join(SESSION_HISTORY_SIDECAR_METADATA_FILE_NAME),
            entry_dir,
        }
    }

    fn entry_dir_for(cache_dir: &Path, cache_key: &str) -> PathBuf {
        let mut entry_dir = cache_dir.to_path_buf();
        entry_dir.push(cache_key);
        entry_dir
    }

    fn child_path(mut entry_dir: PathBuf, file_name: &str) -> PathBuf {
        entry_dir.push(file_name);
        entry_dir
    }

    fn child_for(cache_dir: &Path, cache_key: &str, file_name: &str) -> PathBuf {
        Self::child_path(Self::entry_dir_for(cache_dir, cache_key), file_name)
    }

    fn temporary_path(entry_dir: PathBuf, file_name: &str, run_id: RunId) -> PathBuf {
        Self::child_path(entry_dir, &format!("{file_name}.tmp.{run_id}"))
    }

    pub(super) fn lock_path(lock_dir: &Path, cache_key: &str) -> PathBuf {
        workspace_image_cache_lock_path(lock_dir, cache_key)
    }

    pub fn entry_dir(&self) -> &Path {
        &self.entry_dir
    }

    pub fn metadata(&self) -> &Path {
        &self.metadata
    }

    pub fn current_image(&self) -> &Path {
        &self.current_image
    }

    pub fn session_history_sidecar_metadata(&self) -> &Path {
        &self.session_history_sidecar_metadata
    }

    pub fn tmp_image(&self, run_id: RunId) -> PathBuf {
        Self::temporary_path(self.entry_dir.clone(), CURRENT_IMAGE_FILE_NAME, run_id)
    }

    pub fn tmp_metadata(&self, run_id: RunId) -> PathBuf {
        Self::temporary_path(self.entry_dir.clone(), METADATA_FILE_NAME, run_id)
    }

    pub(super) fn tmp_session_history_sidecar_metadata(&self, run_id: RunId) -> PathBuf {
        Self::temporary_path(
            self.entry_dir.clone(),
            SESSION_HISTORY_SIDECAR_METADATA_FILE_NAME,
            run_id,
        )
    }
}

impl WorkspaceImageCache {
    pub(super) fn workspace_image_cache_dir(&self) -> &Path {
        &self.inner.cache_dir
    }

    pub(super) fn workspace_image_cache_fs_stats_path(&self) -> PathBuf {
        super::fs::existing_fs_stats_path(self.workspace_image_cache_dir())
    }

    pub(super) fn workspace_image_cache_entry_dir(&self, cache_key: &str) -> PathBuf {
        CacheEntryPaths::entry_dir_for(self.workspace_image_cache_dir(), cache_key)
    }

    pub(super) fn workspace_image_cache_metadata(&self, cache_key: &str) -> PathBuf {
        CacheEntryPaths::child_for(
            self.workspace_image_cache_dir(),
            cache_key,
            METADATA_FILE_NAME,
        )
    }

    pub(super) fn workspace_image_cache_current_image(&self, cache_key: &str) -> PathBuf {
        CacheEntryPaths::child_for(
            self.workspace_image_cache_dir(),
            cache_key,
            CURRENT_IMAGE_FILE_NAME,
        )
    }

    pub(super) fn workspace_image_cache_tmp_sidecar(
        &self,
        cache_key: &str,
        run_id: RunId,
    ) -> PathBuf {
        CacheEntryPaths::temporary_path(
            CacheEntryPaths::entry_dir_for(self.workspace_image_cache_dir(), cache_key),
            SESSION_HISTORY_SIDECAR_FILE_NAME,
            run_id,
        )
    }

    pub(super) fn scoped_cache_key(
        &self,
        profile_name: &str,
        reuse_key: &str,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> String {
        scoped_workspace_image_cache_key(
            &self.inner.cache_scope,
            profile_name,
            reuse_key,
            working_dir,
            image_size_bytes,
        )
    }

    pub(super) fn metadata_matches_cache_key(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
    ) -> bool {
        scoped_workspace_image_cache_key(
            &metadata.cache_scope,
            &metadata.profile_name,
            &metadata.reuse_key,
            &metadata.working_dir,
            metadata.logical_image_size_bytes,
        ) == cache_key
    }

    pub fn entry_paths(&self, cache_key: &str) -> CacheEntryPaths {
        CacheEntryPaths::new(self.workspace_image_cache_dir(), cache_key)
    }

    pub(super) fn entry_lock_path(&self, cache_key: &str) -> PathBuf {
        CacheEntryPaths::lock_path(&self.inner.lock_dir, cache_key)
    }

    pub(super) fn capacity_lock_path(&self) -> PathBuf {
        workspace_image_cache_capacity_lock_path(&self.inner.lock_dir)
    }
}

pub(super) fn is_cache_key_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
