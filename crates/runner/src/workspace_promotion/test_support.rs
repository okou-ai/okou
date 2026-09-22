use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sandbox::SandboxId;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::paths::RunnerPaths;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageCache,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest, WorkspaceImagePromotionContext,
    WorkspaceImagePromotionOutcome, WorkspaceImagePromotionRequest,
};
use runner_types::ids::RunId;

pub(crate) const TEST_COMPLETED_AT: &str = "2026-06-03T00:00:00.000Z";
const TEST_WORKSPACE_IMAGE: &[u8] = b"workspace image";
pub(crate) const TEST_WORKSPACE_IMAGE_SIZE_BYTES: u64 = TEST_WORKSPACE_IMAGE.len() as u64;

pub(crate) fn test_restored_session_identity(
    session_id: &str,
    history: &[u8],
) -> RestoredSessionIdentity {
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

pub(crate) struct WorkspacePromotionFixture {
    pub(crate) _dir: Arc<tempfile::TempDir>,
    pub(crate) cache: WorkspaceImageCache,
    pub(crate) promotion: WorkspaceImagePromotionContext,
    pub(crate) sandbox_id: SandboxId,
    pub(crate) reuse_key: String,
}

impl WorkspacePromotionFixture {
    pub(crate) async fn new(reuse_key: &str) -> Self {
        Self::new_with_restored_session_identity(reuse_key, None).await
    }

    pub(crate) async fn new_with_restored_session_identity(
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
    ) -> Self {
        Self::new_with_terminal_status(
            reuse_key,
            restored_session_identity,
            WorkspaceCacheTerminalStatus::Success,
        )
        .await
    }

    pub(crate) async fn new_with_terminal_status(
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
        terminal_status: WorkspaceCacheTerminalStatus,
    ) -> Self {
        let dir = Arc::new(tempfile::tempdir().unwrap());
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());

        Self::new_with_cache_and_terminal_status(
            dir,
            cache,
            reuse_key,
            restored_session_identity,
            terminal_status,
        )
        .await
    }

    pub(crate) async fn new_with_restored_session_identity_and_export_capacity(
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
        export_capacity: usize,
    ) -> Self {
        let dir = Arc::new(tempfile::tempdir().unwrap());
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone())
            .with_promotion_capacity_for_test(export_capacity);

        Self::new_with_cache(dir, cache, reuse_key, restored_session_identity).await
    }

    pub(crate) async fn new_with_cache(
        dir: Arc<tempfile::TempDir>,
        cache: WorkspaceImageCache,
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
    ) -> Self {
        Self::new_with_cache_and_terminal_status(
            dir,
            cache,
            reuse_key,
            restored_session_identity,
            WorkspaceCacheTerminalStatus::Success,
        )
        .await
    }

    async fn new_with_cache_and_terminal_status(
        dir: Arc<tempfile::TempDir>,
        cache: WorkspaceImageCache,
        reuse_key: &str,
        restored_session_identity: Option<&RestoredSessionIdentity>,
        terminal_status: WorkspaceCacheTerminalStatus,
    ) -> Self {
        let paths = cache.paths().clone();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(
            paths.active_workspace_image(&sandbox_id),
            TEST_WORKSPACE_IMAGE,
        )
        .await
        .unwrap();
        let promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
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

    pub(crate) async fn new_from_cache_hit(reuse_key: &str) -> Self {
        let seed = Self::new(reuse_key).await;
        assert_eq!(
            seed.promotion.promote().await.unwrap(),
            WorkspaceImagePromotionOutcome::Promoted
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
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(&reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
                },
                workspace_drive_required: true,
            })
            .await;
        assert_eq!(workspace_image.result(), WorkspaceCacheCheckoutResult::Hit);
        let promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
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

    pub(crate) async fn checkout_result(
        cache: &WorkspaceImageCache,
        reuse_key: &str,
    ) -> WorkspaceCacheCheckoutResult {
        cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
                },
                workspace_drive_required: true,
            })
            .await
            .result()
    }
}
