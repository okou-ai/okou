use std::path::PathBuf;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;

use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageCache,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest, WorkspaceImagePromotionOutcome,
    WorkspaceImagePromotionRequest, WorkspaceSessionHistorySidecarRepresentation,
};
use runner_host::paths::{RunnerPaths, scoped_workspace_image_cache_key};
use runner_types::ids::RunId;
use runner_types::types::ExecutionContext;

pub(in crate::executor::tests) async fn seed_workspace_image_cache(
    cache: &WorkspaceImageCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    workspace_disk_mb: u32,
) -> PathBuf {
    seed_workspace_image_cache_with_fingerprints(
        cache,
        runner_paths,
        session_id,
        workspace_disk_mb,
        &StorageFingerprints::default(),
    )
    .await
}

pub(in crate::executor::tests) async fn seed_workspace_image_cache_with_sidecar(
    cache: &WorkspaceImageCache,
    runner_paths: &RunnerPaths,
    context: &ExecutionContext,
    workspace_disk_mb: u32,
    body: &[u8],
    representation: WorkspaceSessionHistorySidecarRepresentation,
) -> PathBuf {
    let sandbox_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let reuse_key = context.reuse_key.as_deref().expect("workspace reuse key");
    let restored_session_identity =
        RestoredSessionIdentity::from_context(context).expect("restored session identity");
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(u64::from(workspace_disk_mb) * 1024 * 1024)
        .await
        .unwrap();
    drop(file);

    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: Some(&restored_session_identity),
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-06-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .expect("workspace promotion context");
    let guard = promotion
        .try_acquire_session_history_sidecar_entry_guard()
        .await
        .expect("workspace sidecar guard");
    let sidecar_path = guard.session_history_sidecar_tmp_path();
    tokio::fs::create_dir_all(sidecar_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&sidecar_path, body).await.unwrap();
    let source =
        guard.session_history_sidecar_source(sidecar_path, representation, body.len() as u64);
    assert_eq!(
        guard
            .promote_with_session_history_sidecar(&promotion, &source)
            .await
            .unwrap(),
        WorkspaceImagePromotionOutcome::Promoted
    );

    let cache_key = scoped_workspace_image_cache_key(
        "",
        "vm0/default",
        reuse_key,
        CANONICAL_WORKING_DIR,
        u64::from(workspace_disk_mb) * 1024 * 1024,
    );
    cache.entry_paths(&cache_key).current_image().to_path_buf()
}

pub(in crate::executor::tests) async fn seed_workspace_image_cache_with_fingerprints(
    cache: &WorkspaceImageCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    workspace_disk_mb: u32,
    storage_fingerprints: &StorageFingerprints,
) -> PathBuf {
    let sandbox_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let reuse_key = format!("thread:workspace-cache-{session_id}");
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(&reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(u64::from(workspace_disk_mb) * 1024 * 1024)
        .await
        .unwrap();
    drop(file);

    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                storage_fingerprints,
            )
            .await
            .unwrap()
    );

    let cache_key = scoped_workspace_image_cache_key(
        "",
        "vm0/default",
        &reuse_key,
        CANONICAL_WORKING_DIR,
        u64::from(workspace_disk_mb) * 1024 * 1024,
    );
    cache.entry_paths(&cache_key).current_image().to_path_buf()
}
