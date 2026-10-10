use std::path::PathBuf;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;

use crate::home_image_cache::{
    HomeCacheCheckoutResult, HomeCacheTerminalStatus, HomeImageCache, HomeImageLeaseIdentity,
    HomeImagePrepareRequest,
};
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::paths::{RunnerPaths, scoped_home_image_cache_key};
use runner_types::ids::RunId;

pub(in crate::executor::tests) async fn seed_home_image_cache(
    cache: &HomeImageCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    home_disk_mb: u32,
) -> PathBuf {
    seed_home_image_cache_with_fingerprints(
        cache,
        runner_paths,
        session_id,
        home_disk_mb,
        &StorageFingerprints::default(),
    )
    .await
}

pub(in crate::executor::tests) async fn seed_home_image_cache_with_fingerprints(
    cache: &HomeImageCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    home_disk_mb: u32,
    storage_fingerprints: &StorageFingerprints,
) -> PathBuf {
    let sandbox_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let reuse_key = format!("thread:workspace-cache-{session_id}");
    let lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                reuse_key: Some(&reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Miss);

    let active_image = runner_paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(u64::from(home_disk_mb) * 1024 * 1024)
        .await
        .unwrap();
    drop(file);

    assert!(
        lease
            .promote(
                run_id,
                HomeCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                storage_fingerprints,
            )
            .await
            .unwrap()
    );

    let cache_key = scoped_home_image_cache_key(
        "",
        "vm0/default",
        "test-rootfs",
        &reuse_key,
        u64::from(home_disk_mb) * 1024 * 1024,
    );
    cache
        .entry_paths(&cache_key)
        .image(&run_id.to_string())
        .expect("successful promotion commits the publisher's immutable generation")
}
