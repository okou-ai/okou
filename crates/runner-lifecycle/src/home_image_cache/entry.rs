use super::metadata::HomeCacheMetadata;
use super::{HOME_DRIVE_LAYOUT, HomeImageCache};
use runner_host::paths::{
    home_image_cache_capacity_lock_path, home_image_cache_lock_path,
    home_image_cache_routine_gc_lock_path, scoped_home_image_cache_key,
};
use runner_types::ids::RunId;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct CacheEntryPaths {
    entry_dir: PathBuf,
}
impl CacheEntryPaths {
    pub fn new(cache_dir: &Path, cache_key: &str) -> Self {
        Self::from_entry_dir(cache_dir.join(cache_key))
    }
    pub(super) fn from_entry_dir(entry_dir: PathBuf) -> Self {
        Self { entry_dir }
    }
    pub fn entry_dir(&self) -> &Path {
        &self.entry_dir
    }
    pub fn metadata(&self) -> PathBuf {
        self.entry_dir.join("metadata.json")
    }
    /// Only a canonical UUID can become part of an image filename.
    pub fn image(&self, generation: &str) -> Option<PathBuf> {
        valid_generation(generation)
            .then(|| self.entry_dir.join(format!("image-{generation}.ext4")))
    }
    pub fn tmp_image(&self, run_id: RunId) -> PathBuf {
        self.entry_dir.join(format!("image-{run_id}.ext4.tmp"))
    }
    pub fn tmp_metadata(&self, run_id: RunId) -> PathBuf {
        self.entry_dir.join(format!("metadata.json.tmp.{run_id}"))
    }
    pub(super) fn lock_path(lock_dir: &Path, cache_key: &str) -> PathBuf {
        home_image_cache_lock_path(lock_dir, cache_key)
    }
}

pub(super) fn valid_generation(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

pub(super) fn image_generation(name: &str) -> Option<&str> {
    let value = name.strip_prefix("image-")?.strip_suffix(".ext4")?;
    valid_generation(value).then_some(value)
}

impl HomeImageCache {
    pub(super) fn home_image_cache_dir(&self) -> &Path {
        &self.inner.cache_dir
    }
    pub(super) fn home_image_cache_fs_stats_path(&self) -> PathBuf {
        super::fs::existing_fs_stats_path(self.home_image_cache_dir())
    }
    pub(super) fn home_image_cache_entry_dir(&self, cache_key: &str) -> PathBuf {
        self.inner.cache_dir.join(cache_key)
    }
    pub(super) fn home_image_cache_metadata(&self, cache_key: &str) -> PathBuf {
        self.entry_paths(cache_key).metadata()
    }
    pub(super) fn scoped_cache_key(
        &self,
        profile_name: &str,
        rootfs_hash: &str,
        reuse_key: &str,
        _working_dir: &str,
        image_size_bytes: u64,
    ) -> String {
        scoped_home_image_cache_key(
            &self.inner.cache_scope,
            profile_name,
            rootfs_hash,
            reuse_key,
            image_size_bytes,
        )
    }
    pub(super) fn metadata_matches_cache_key(
        &self,
        key: &str,
        metadata: &HomeCacheMetadata,
    ) -> bool {
        metadata.drive_layout == HOME_DRIVE_LAYOUT
            && scoped_home_image_cache_key(
                &metadata.cache_scope,
                &metadata.profile_name,
                &metadata.rootfs_hash,
                &metadata.reuse_key,
                metadata.logical_image_size_bytes,
            ) == key
    }
    pub fn entry_paths(&self, cache_key: &str) -> CacheEntryPaths {
        CacheEntryPaths::new(self.home_image_cache_dir(), cache_key)
    }
    pub(super) fn entry_lock_path(&self, cache_key: &str) -> PathBuf {
        CacheEntryPaths::lock_path(&self.inner.lock_dir, cache_key)
    }
    pub(super) fn capacity_lock_path(&self) -> PathBuf {
        home_image_cache_capacity_lock_path(&self.inner.lock_dir)
    }
    pub(super) fn routine_gc_lock_path(&self) -> PathBuf {
        home_image_cache_routine_gc_lock_path(&self.inner.lock_dir)
    }
}

pub(super) fn is_cache_key_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
