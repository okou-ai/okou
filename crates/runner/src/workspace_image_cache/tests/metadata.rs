use tokio::fs;

use super::super::fs::{allocated_bytes, local_timestamp};
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheCheckoutResult,
    WorkspaceCacheTerminalStatus, WorkspaceImageCache, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest,
};
use super::support::{TEST_PROFILE_NAME, local_cache, write_current_cache_entry};
use crate::paths::RunnerPaths;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;

#[tokio::test]
async fn prepare_removes_symlink_cache_entry_without_following_it() {
    let (dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-entry-symlink";
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, "/workspace", 5);
    let outside_entry = dir.path().join("outside-cache-entry");
    fs::create_dir_all(&outside_entry).await.unwrap();
    let outside_current = outside_entry.join("current.ext4");
    fs::write(&outside_current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&outside_current).await.unwrap();
    let metadata = WorkspaceCacheMetadata {
        format_version: CACHE_FORMAT_VERSION,
        cache_scope: cache.inner.cache_scope.clone(),
        profile_name: TEST_PROFILE_NAME.into(),
        reuse_key: reuse_key.into(),
        working_dir: "/workspace".into(),
        last_completed_at: "2026-05-01T00:00:00.000Z".into(),
        last_used_at: "2026-05-01T00:00:00.000Z".into(),
        last_terminal_status: WorkspaceCacheTerminalStatus::Success,
        workspace_trust: WorkspaceTrust::Clean,
        logical_image_size_bytes: current_metadata.len(),
        allocated_bytes: allocated_bytes(&current_metadata),
        current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
        drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
        storage_fingerprints: StorageFingerprints::default(),
        state: WorkspaceCacheState::Current,
    };
    fs::write(
        outside_entry.join("metadata.json"),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .await
    .unwrap();
    let entry_dir = cache.entry_paths(&key).entry_dir().to_path_buf();
    fs::create_dir_all(entry_dir.parent().unwrap())
        .await
        .unwrap();
    std::os::unix::fs::symlink(&outside_entry, &entry_dir).unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(
        lease
            .workspace_drive_config()
            .expect("workspace drive should stay enabled")
            .seed_image
            .is_none()
    );
    assert!(matches!(
        fs::symlink_metadata(&entry_dir).await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    ));
    assert_eq!(fs::read(&outside_current).await.unwrap(), b"image");
}

#[tokio::test]
async fn metadata_missing_current_present_is_not_a_cache_hit() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-no-metadata", "/workspace", 5);
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    fs::write(
        cache.entry_paths(&key).current_image().to_path_buf(),
        b"image",
    )
    .await
    .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-no-metadata"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    assert_eq!(
        lease
            .workspace_drive_config()
            .and_then(|config| config.seed_image),
        None
    );
}

async fn assert_metadata_validation_rejects(
    mutate: impl FnOnce(&mut WorkspaceCacheMetadata) -> String,
) {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let reuse_key = "sess-metadata-validation";
    let working_dir = "/workspace";
    let key = write_current_cache_entry(
        &cache,
        run_id,
        reuse_key,
        working_dir,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:01:00.000Z",
    )
    .await;
    let metadata_path = cache.entry_paths(&key).metadata().to_path_buf();
    let mut metadata = cache.read_metadata_file(&metadata_path).await.unwrap();
    let image_size_bytes = metadata.logical_image_size_bytes;
    let expected_error = mutate(&mut metadata);
    cache.write_metadata(&key, run_id, metadata).await.unwrap();

    let err = cache
        .read_valid_metadata(
            &metadata_path,
            TEST_PROFILE_NAME,
            reuse_key,
            working_dir,
            image_size_bytes,
        )
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains(&expected_error),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn metadata_validation_rejects_profile_mismatch() {
    assert_metadata_validation_rejects(|metadata| {
        metadata.profile_name = "vm0/other".into();
        "profile mismatch".into()
    })
    .await;
}

#[tokio::test]
async fn metadata_validation_rejects_reuse_key_mismatch() {
    assert_metadata_validation_rejects(|metadata| {
        metadata.reuse_key = "other".into();
        "reuse key mismatch".into()
    })
    .await;
}

#[tokio::test]
async fn metadata_validation_rejects_working_dir_mismatch() {
    assert_metadata_validation_rejects(|metadata| {
        metadata.working_dir = "/other".into();
        "working dir mismatch".into()
    })
    .await;
}

#[tokio::test]
async fn metadata_validation_rejects_drive_layout_mismatch() {
    assert_metadata_validation_rejects(|metadata| {
        metadata.drive_layout = "workspace-drive-v0".into();
        "drive layout workspace-drive-v0 does not match".into()
    })
    .await;
}

#[tokio::test]
async fn metadata_validation_rejects_logical_image_size_mismatch() {
    assert_metadata_validation_rejects(|metadata| {
        let expected_image_size = metadata.logical_image_size_bytes;
        metadata.logical_image_size_bytes += 1;
        format!(
            "workspace metadata image size {} does not match {expected_image_size}",
            metadata.logical_image_size_bytes
        )
    })
    .await;
}

#[tokio::test]
async fn metadata_validation_rejects_dirty_state() {
    assert_metadata_validation_rejects(|metadata| {
        metadata.state = WorkspaceCacheState::Dirty;
        "metadata is not reusable".into()
    })
    .await;
}

#[tokio::test]
async fn metadata_validation_rejects_invalid_state() {
    assert_metadata_validation_rejects(|metadata| {
        metadata.state = WorkspaceCacheState::Invalid;
        "metadata is not reusable".into()
    })
    .await;
}

#[tokio::test]
async fn write_metadata_replaces_stale_tmp_symlink_without_following_it() {
    let (dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    let outside = dir.path().join("outside-metadata-target");
    fs::write(&outside, b"outside").await.unwrap();
    let metadata_tmp = cache.entry_paths(&key).tmp_metadata(run_id);
    std::os::unix::fs::symlink(&outside, &metadata_tmp).unwrap();

    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

    assert_eq!(fs::read(&outside).await.unwrap(), b"outside");
    let metadata_path = cache.entry_paths(&key).metadata().to_path_buf();
    let metadata_file_type = fs::symlink_metadata(&metadata_path)
        .await
        .unwrap()
        .file_type();
    assert!(metadata_file_type.is_file());
    assert!(!metadata_file_type.is_symlink());
}

#[tokio::test]
async fn prepare_removes_invalid_metadata_entry_and_allows_repromotion() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let image_size = b"old image".len() as u64;
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", image_size);
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"old image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "other".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: image_size,
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(
        !cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "invalid entry should be removed while the entry lock is held"
    );

    let active_image = paths.active_workspace_image(&sandbox_id);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::write(&active_image, b"new image").await.unwrap();
    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let metadata_path = cache.entry_paths(&key).metadata().to_path_buf();
    let metadata = cache.read_metadata_file(&metadata_path).await.unwrap();
    let serialized_metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(metadata_path).await.unwrap()).unwrap();
    assert_eq!(serialized_metadata["formatVersion"], CACHE_FORMAT_VERSION);
    assert!(serialized_metadata.get("keyVersion").is_none());
    assert!(serialized_metadata.get("cliAgentSessionId").is_none());
    assert_eq!(metadata.reuse_key, "sess-1");
    assert_eq!(cache.held_workspace_states().await.len(), 1);
}

#[tokio::test]
async fn metadata_validation_rejects_replaced_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        b"old image".len() as u64,
    );
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"old image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
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
    let replacement = cache
        .entry_paths(&key)
        .entry_dir()
        .to_path_buf()
        .join("replacement.ext4");
    fs::write(&replacement, b"new image").await.unwrap();
    fs::rename(&replacement, &current).await.unwrap();

    let err = cache
        .read_valid_metadata(
            cache.entry_paths(&key).metadata(),
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            current_metadata.len(),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("current image identity mismatch"));
    assert!(
        cache.held_workspace_states().await.is_empty(),
        "stale metadata/current pairs must not be advertised as reusable workspace caches",
    );
}

#[tokio::test]
async fn metadata_validation_rejects_symlink_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        b"image".len() as u64,
    );
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let target = dir.path().join("target.ext4");
    fs::write(&target, b"image").await.unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    std::os::unix::fs::symlink(&target, &current).unwrap();
    let current_target_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_target_metadata.len(),
                allocated_bytes: allocated_bytes(&current_target_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_target_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let err = cache
        .read_valid_metadata(
            cache.entry_paths(&key).metadata(),
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            current_target_metadata.len(),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("current image is not a file"));
    assert!(
        cache.held_workspace_states().await.is_empty(),
        "symlink current image entries must not be advertised as reusable workspace caches",
    );

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(!cache.entry_paths(&key).entry_dir().to_path_buf().exists());
    assert!(
        target.exists(),
        "GC must remove the symlink, not its target"
    );
}
