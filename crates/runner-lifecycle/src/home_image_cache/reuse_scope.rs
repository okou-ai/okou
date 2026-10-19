use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{CACHE_FORMAT_VERSION, HomeImageCache};

impl HomeImageCache {
    /// Advisory, per-profile capability for another process on this boot and
    /// these physical cache/lock directories. Actual checkout still validates
    /// the committed image under its exclusive entry lock.
    /// `profiles` maps configured names to logical image sizes in bytes.
    pub async fn reuse_scopes(&self, profiles: &BTreeMap<&str, u64>) -> BTreeMap<String, String> {
        let Ok(boot_id) = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id").await else {
            return BTreeMap::new();
        };
        let Ok(boot_id) = Uuid::parse_str(boot_id.trim()) else {
            return BTreeMap::new();
        };
        self.reuse_scopes_for_boot(profiles, boot_id).await
    }

    async fn reuse_scopes_for_boot(
        &self,
        profiles: &BTreeMap<&str, u64>,
        boot_id: Uuid,
    ) -> BTreeMap<String, String> {
        if boot_id.is_nil() {
            return BTreeMap::new();
        }
        let Ok(cache) = tokio::fs::metadata(&self.inner.cache_dir).await else {
            return BTreeMap::new();
        };
        let Ok(locks) = tokio::fs::metadata(&self.inner.lock_dir).await else {
            return BTreeMap::new();
        };
        if !cache.is_dir() || !locks.is_dir() {
            return BTreeMap::new();
        }
        let mut domain = Sha256::new();
        domain.update(b"runner-shared-home-scope:v1");
        domain.update(boot_id.as_bytes());
        for identity in [cache.dev(), cache.ino(), locks.dev(), locks.ino()] {
            domain.update(identity.to_le_bytes());
        }
        domain.update(CACHE_FORMAT_VERSION.to_le_bytes());
        domain.update([runner_types::types::HOME_AFFINITY_VERSION]);
        let domain = hex::encode(domain.finalize());
        profiles
            .iter()
            .filter(|(_, size_bytes)| **size_bytes > 0)
            .map(|(profile, size_bytes)| {
                // Reuse the cache's length-framed addressing contract for
                // logical scope, drive layout, profile and image size.
                let scope = self.scoped_cache_key(profile, &domain, *size_bytes);
                ((*profile).to_owned(), scope)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_host::paths::{HomePaths, RunnerPaths};

    #[tokio::test]
    async fn scope_binds_physical_host_cache_locks_format_and_profile_shape() {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().join("host"));
        tokio::fs::create_dir_all(home.home_image_cache_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(home.locks_dir()).await.unwrap();
        let old = HomeImageCache::shared(RunnerPaths::new(root.path().join("old")), &home, "group");
        let new = HomeImageCache::shared(RunnerPaths::new(root.path().join("new")), &home, "group");
        let profiles = BTreeMap::from([("vm0/default", 16 * 1024 * 1024)]);
        let boot = Uuid::new_v4();
        let scopes = old.reuse_scopes_for_boot(&profiles, boot).await;
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes, new.reuse_scopes_for_boot(&profiles, boot).await);
        assert_ne!(
            scopes,
            new.reuse_scopes_for_boot(&profiles, Uuid::new_v4()).await
        );
        assert_ne!(
            scopes,
            new.reuse_scopes_for_boot(&BTreeMap::from([("vm0/default", 32 * 1024 * 1024)]), boot)
                .await
        );
        assert_ne!(
            scopes,
            new.reuse_scopes_for_boot(&BTreeMap::from([("vm0/large", 16 * 1024 * 1024)]), boot)
                .await
        );
        let foreign = HomeImageCache::shared(
            RunnerPaths::new(root.path().join("foreign")),
            &home,
            "other-group",
        );
        assert_ne!(scopes, foreign.reuse_scopes_for_boot(&profiles, boot).await);
        // Keep old directories alive so a new directory cannot reuse its inode.
        tokio::fs::rename(home.locks_dir(), root.path().join("old-locks"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(home.locks_dir()).await.unwrap();
        assert_ne!(scopes, new.reuse_scopes_for_boot(&profiles, boot).await);
        let after_locks = new.reuse_scopes_for_boot(&profiles, boot).await;
        tokio::fs::rename(home.home_image_cache_dir(), root.path().join("old-cache"))
            .await
            .unwrap();
        assert!(new.reuse_scopes_for_boot(&profiles, boot).await.is_empty());
        tokio::fs::create_dir_all(home.home_image_cache_dir())
            .await
            .unwrap();
        assert_ne!(
            after_locks,
            new.reuse_scopes_for_boot(&profiles, boot).await
        );
        assert!(
            new.reuse_scopes_for_boot(&profiles, Uuid::nil())
                .await
                .is_empty()
        );
    }
}
