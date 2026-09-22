use super::super::fs::allocated_bytes;
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheTerminalStatus,
    WorkspaceImageCache, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
};
use crate::paths::RunnerPaths;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;

pub(super) const TEST_PROFILE_NAME: &str = "vm0/default";

pub(super) fn timestamp_for_index(index: usize) -> String {
    format!("2026-05-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
}

pub(super) async fn local_cache() -> (tempfile::TempDir, RunnerPaths, WorkspaceImageCache) {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths.clone());
    (dir, paths, cache)
}

pub(super) async fn write_current_cache_entry(
    cache: &WorkspaceImageCache,
    run_id: RunId,
    reuse_key: &str,
    working_dir: &str,
    last_completed_at: &str,
    last_used_at: &str,
) -> String {
    write_current_cache_entry_for_profile(
        cache,
        run_id,
        TEST_PROFILE_NAME,
        reuse_key,
        working_dir,
        last_completed_at,
        last_used_at,
    )
    .await
}

pub(super) async fn write_current_cache_entry_for_profile(
    cache: &WorkspaceImageCache,
    run_id: RunId,
    profile_name: &str,
    reuse_key: &str,
    working_dir: &str,
    last_completed_at: &str,
    last_used_at: &str,
) -> String {
    let image = format!("image-{reuse_key}");
    let key = cache.scoped_cache_key(profile_name, reuse_key, working_dir, image.len() as u64);
    tokio::fs::create_dir_all(cache.workspace_image_cache_entry_dir(&key))
        .await
        .unwrap();
    let current = cache.workspace_image_cache_current_image(&key);
    tokio::fs::write(&current, image).await.unwrap();
    let current_metadata = tokio::fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: profile_name.into(),
                reuse_key: reuse_key.into(),
                working_dir: working_dir.into(),
                last_completed_at: last_completed_at.into(),
                last_used_at: last_used_at.into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();
    key
}

pub(super) async fn promote_current_cache_entry(
    cache: &WorkspaceImageCache,
    paths: &RunnerPaths,
    reuse_key: &str,
    image: &[u8],
    last_completed_at: &str,
) -> String {
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, image).await.unwrap();
    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                last_completed_at.into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        reuse_key,
        "/workspace",
        image.len() as u64,
    )
}
