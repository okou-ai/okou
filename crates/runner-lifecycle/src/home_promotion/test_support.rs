use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sandbox::SandboxId;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::home_image_cache::{
    HomeCacheCheckoutResult, HomeCacheTerminalStatus, HomeImageCache,
    HomeImageLeaseIdentity, HomeImagePrepareRequest, HomeImagePromotionContext,
    HomeImagePromotionOutcome, HomeImagePromotionRequest,
};
use runner_host::paths::RunnerPaths;
use runner_types::ids::RunId;

pub fn add_healthy_cache_preparation_matcher(overrides: &sandbox_mock::MockSandboxOverrides) {
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-cache".to_string(),
        exit_code: 0,
        stdout: serde_json::to_vec(&guest_contracts::home_cache_history::TerminalHomeCachePreparationReport {
            cleanup: crate::idle_reuse_preparation::healthy_reuse_preparation_report(), history_proof: None,
        })
        .unwrap(),
        stderr: Vec::new(),
    });
}

pub fn mock_sandbox_ready_for_cache_preparation(
    name: impl Into<String>,
) -> sandbox_mock::MockSandbox {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_cache_preparation_matcher(&overrides);
    sandbox_mock::MockSandbox::with_overrides(name, overrides)
}

pub const TEST_COMPLETED_AT: &str = "2026-06-03T00:00:00.000Z";
const TEST_HOME_IMAGE: &[u8] = b"workspace image";
pub const TEST_HOME_IMAGE_SIZE_BYTES: u64 = TEST_HOME_IMAGE.len() as u64;

pub fn test_restored_session_identity(session_id: &str, history: &[u8]) -> RestoredSessionIdentity {
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: "/home/user/.claude".to_string(),
            working_dir: CANONICAL_WORKING_DIR.to_string(),
            session_id: session_id.to_string(),
        },
    )
    .unwrap();
    RestoredSessionIdentity::from_final_metadata(
        metadata,
        "/home/user/.vm0/guest-agent/runs/run-1/final-session-history-identity.json",
        "/home/user/.vm0/guest-agent/runs/run-1",
    )
    .unwrap()
}

pub struct HomePromotionFixture {
    pub _dir: Arc<tempfile::TempDir>,
    pub cache: HomeImageCache,
    pub promotion: HomeImagePromotionContext,
    pub sandbox_id: SandboxId,
    pub reuse_key: String,
}

impl HomePromotionFixture {
    pub async fn new(reuse_key: &str) -> Self {
        Self::new_with_restored_session_identity(reuse_key, None).await
    }

    pub async fn new_with_restored_session_identity(
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
    ) -> Self {
        Self::new_with_terminal_status(
            reuse_key,
            restored_session_identity,
            HomeCacheTerminalStatus::Success,
        )
        .await
    }

    pub async fn new_with_terminal_status(
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
        terminal_status: HomeCacheTerminalStatus,
    ) -> Self {
        let dir = Arc::new(tempfile::tempdir().unwrap());
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = HomeImageCache::new(paths.clone());

        Self::new_with_cache_and_terminal_status(
            dir,
            cache,
            reuse_key,
            restored_session_identity,
            terminal_status,
        )
        .await
    }

    pub async fn new_with_cache(
        dir: Arc<tempfile::TempDir>,
        cache: HomeImageCache,
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
    ) -> Self {
        Self::new_with_cache_and_terminal_status(
            dir,
            cache,
            reuse_key,
            restored_session_identity,
            HomeCacheTerminalStatus::Success,
        )
        .await
    }

    async fn new_with_cache_and_terminal_status(
        dir: Arc<tempfile::TempDir>,
        cache: HomeImageCache,
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
        terminal_status: HomeCacheTerminalStatus,
    ) -> Self {
        let paths = cache.paths().clone();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let home_image = cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    rootfs_hash: "test-rootfs",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_HOME_IMAGE_SIZE_BYTES,
                },
                home_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.home_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(
            paths.active_home_image(&sandbox_id),
            TEST_HOME_IMAGE,
        )
        .await
        .unwrap();
        let promotion = home_image
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity,
                terminal_status,
                completed_at: TEST_COMPLETED_AT.into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .expect("workspace image should be promotable");

        Self {
            _dir: dir,
            cache,
            promotion,
            sandbox_id,
            reuse_key: reuse_key.into(),
        }
    }

    pub async fn new_from_cache_hit(reuse_key: &str) -> Self {
        let seed = Self::new(reuse_key).await;
        assert_eq!(
            seed.promotion.promote().await.unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
        let Self {
            _dir,
            cache,
            promotion,
            sandbox_id: _,
            reuse_key,
        } = seed;
        drop(promotion);

        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let home_image = cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    rootfs_hash: "test-rootfs",
                    reuse_key: Some(&reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_HOME_IMAGE_SIZE_BYTES,
                },
                home_drive_required: true,
            })
            .await;
        assert_eq!(home_image.result(), HomeCacheCheckoutResult::Hit);
        let promotion = home_image
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: "2026-06-04T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .expect("workspace image cache hit should be promotable");

        Self {
            _dir,
            cache,
            promotion,
            sandbox_id,
            reuse_key,
        }
    }

    pub async fn checkout_result(
        cache: &HomeImageCache,
        reuse_key: &str,
    ) -> HomeCacheCheckoutResult {
        cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    rootfs_hash: "test-rootfs",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_HOME_IMAGE_SIZE_BYTES,
                },
                home_drive_required: true,
            })
            .await
            .result()
    }
}
