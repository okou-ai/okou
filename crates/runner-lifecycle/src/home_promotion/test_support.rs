use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;
use std::sync::Arc;

use crate::home_image_cache::{
    HomeCacheCheckoutResult, HomeCacheTerminalStatus, HomeImageCache, HomeImageLeaseIdentity,
    HomeImagePrepareRequest, HomeImagePromotionContext, HomeImagePromotionOutcome,
    HomeImagePromotionRequest,
};
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::paths::RunnerPaths;
use runner_types::ids::RunId;

pub fn add_healthy_cache_preparation_matcher(overrides: &sandbox_mock::MockSandboxOverrides) {
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-cache".to_string(),
        exit_code: 0,
        stdout: serde_json::to_vec(
            &crate::idle_reuse_preparation::healthy_reuse_preparation_report(),
        )
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
const TEST_HOME_IMAGE: &[u8] = b"home image";
pub const TEST_HOME_IMAGE_SIZE_BYTES: u64 = 1024 * 1024;

pub fn test_home_image() -> Vec<u8> {
    let mut image = vec![0; TEST_HOME_IMAGE_SIZE_BYTES as usize];
    image
        .get_mut(..TEST_HOME_IMAGE.len())
        .expect("fixture image holds the complete marker")
        .copy_from_slice(TEST_HOME_IMAGE);
    image
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
        Self::new_with_terminal_status(reuse_key, HomeCacheTerminalStatus::Success).await
    }

    pub async fn new_with_terminal_status(
        reuse_key: &str,
        terminal_status: HomeCacheTerminalStatus,
    ) -> Self {
        let dir = Arc::new(tempfile::tempdir().unwrap());
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = HomeImageCache::new(paths.clone());

        Self::new_with_cache_and_terminal_status(dir, cache, reuse_key, terminal_status).await
    }

    pub async fn new_with_cache(
        dir: Arc<tempfile::TempDir>,
        cache: HomeImageCache,
        reuse_key: &str,
    ) -> Self {
        Self::new_with_cache_and_terminal_status(
            dir,
            cache,
            reuse_key,
            HomeCacheTerminalStatus::Success,
        )
        .await
    }

    async fn new_with_cache_and_terminal_status(
        dir: Arc<tempfile::TempDir>,
        cache: HomeImageCache,
        reuse_key: &str,
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
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_home_image(&sandbox_id), test_home_image())
            .await
            .unwrap();
        let promotion = home_image
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                terminal_status,
                completed_at: TEST_COMPLETED_AT.into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .expect("home image should be promotable");

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
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: "2026-06-04T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .expect("home image cache hit should be promotable");

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
