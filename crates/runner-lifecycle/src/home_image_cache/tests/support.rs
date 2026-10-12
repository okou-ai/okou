use super::super::metadata::HomeCacheMetadata;
use super::super::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_types::ids::RunId;
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub(super) const SIZE: u64 = 1024 * 1024;
pub(super) const ROOTFS: &str = "test-rootfs-full-hash";
pub(super) const PROFILE: &str = "vm0/default";
pub(super) const CWD: &str = "/home/user/workspace";

pub(super) struct Fixture {
    pub dir: tempfile::TempDir,
    pub paths: RunnerPaths,
    pub cache: HomeImageCache,
}
impl Fixture {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let home = HomePaths::with_root(dir.path().join("host"));
        let cache = HomeImageCache::shared(paths.clone(), &home, "group-a");
        Self { dir, paths, cache }
    }
    pub fn key(&self, reuse: &str) -> String {
        self.cache
            .scoped_cache_key(PROFILE, ROOTFS, reuse, CWD, SIZE)
    }
    pub async fn lease(&self, reuse: &str) -> HomeImageLease {
        self.cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: Some(reuse),
                    working_dir: CWD,
                    image_size_bytes: SIZE,
                },
                home_drive_required: true,
            })
            .await
    }
    pub async fn context(
        &self,
        reuse: &str,
        marker: &[u8],
        completed_at: &str,
        terminal: HomeCacheTerminalStatus,
        fingerprints: StorageFingerprints,
    ) -> HomeImagePromotionContext {
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let lease = self
            .cache
            .lease_active(HomeImageLeaseRequest {
                identity: HomeImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: Some(reuse),
                    working_dir: CWD,
                    image_size_bytes: SIZE,
                },
                home_drive_available: true,
            })
            .await;
        write_image(&self.paths.active_home_image(&sandbox_id), marker, SIZE);
        lease
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: terminal,
                completed_at: completed_at.into(),
                storage_fingerprints: fingerprints,
            })
            .unwrap()
    }
    pub async fn commit(&self, reuse: &str, marker: &[u8], timestamp: &str) -> HomeCacheMetadata {
        let context = self
            .context(
                reuse,
                marker,
                timestamp,
                HomeCacheTerminalStatus::Success,
                StorageFingerprints::default(),
            )
            .await;
        assert_eq!(
            context.promote().await.unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
        drop(context);
        self.metadata(reuse).await
    }
    pub async fn metadata(&self, reuse: &str) -> HomeCacheMetadata {
        self.cache
            .read_valid_metadata(
                &self.cache.entry_paths(&self.key(reuse)).metadata(),
                PROFILE,
                ROOTFS,
                reuse,
                CWD,
                SIZE,
            )
            .await
            .unwrap()
            .unwrap()
    }
    pub fn image(&self, reuse: &str, metadata: &HomeCacheMetadata) -> std::path::PathBuf {
        self.cache
            .entry_paths(&self.key(reuse))
            .image(&metadata.image_generation)
            .unwrap()
    }
}

pub(super) fn write_image(path: &Path, marker: &[u8], size: u64) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut image = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    image.set_len(size).unwrap();
    image.seek(SeekFrom::Start(4096)).unwrap();
    image.write_all(marker).unwrap();
    image.sync_all().unwrap();
}

pub(super) fn binding(
    generation: &str,
) -> guest_contracts::home_cache_history::HomeCacheHistoryProofBinding {
    use guest_contracts::home_cache_history::{
        HomeCacheHistoryProof, HomeCacheHistoryProofBinding,
    };
    use guest_contracts::session_history_identity::{
        SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind,
        SessionHistorySourceRef,
    };
    use sha2::{Digest, Sha256};
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::Codex,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        1024,
        SessionHistorySourceRef::Codex {
            sessions_dir: "/home/user/.codex/sessions".into(),
            thread_id: uuid::Uuid::nil().to_string(),
        },
    )
    .unwrap();
    let proof = HomeCacheHistoryProof {
        format_version: 1,
        generation: generation.into(),
        identity,
    };
    let sha256 = hex::encode(Sha256::digest(proof.to_json_vec().unwrap()));
    HomeCacheHistoryProofBinding { proof, sha256 }
}
