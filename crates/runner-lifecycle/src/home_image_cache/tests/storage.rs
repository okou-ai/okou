use super::super::*;
use super::support::*;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use std::collections::HashMap;

#[test]
fn whole_home_scope_is_independent_of_cwd_and_lexical_only() {
    let fingerprints = StorageFingerprints {
        storages: HashMap::from([
            (
                "/home/user/workspace/repo".into(),
                StorageFingerprint::new("repo", "v1"),
            ),
            (
                "/home/user/.npm".into(),
                StorageFingerprint::new("npm", "v1"),
            ),
            (
                "/home/user/.codex/sessions".into(),
                StorageFingerprint::tainted(),
            ),
            (
                "/home/user2/other".into(),
                StorageFingerprint::new("other", "v1"),
            ),
            (
                "/home/user/../escape".into(),
                StorageFingerprint::new("other", "v1"),
            ),
            ("/outside".into(), StorageFingerprint::new("other", "v1")),
        ]),
        artifacts: HashMap::from([(
            "/home/user/output".into(),
            StorageFingerprint::new("artifact", "v1"),
        )]),
    };
    let filtered = super::super::path_safety::filter_storage_fingerprints_for_home(&fingerprints);
    assert_eq!(filtered.storages.len(), 3);
    assert_eq!(filtered.artifacts.len(), 1);
    assert!(filtered.storages["/home/user/.codex/sessions"].is_tainted());
    assert!(
        super::super::path_safety::normalize_safe_guest_working_dir("/home/user//work/").is_some()
    );
    assert!(
        super::super::path_safety::normalize_safe_guest_working_dir("/home/user/../work").is_none()
    );
}

#[tokio::test]
async fn success_persists_current_home_partitions_and_failed_turn_unions_previous_taint() {
    let f = Fixture::new().await;
    let previous = StorageFingerprints {
        storages: HashMap::from([
            (
                "/home/user/removed".into(),
                StorageFingerprint::new("old", "v1"),
            ),
            ("/home/user/uncertain".into(), StorageFingerprint::tainted()),
        ]),
        artifacts: HashMap::from([(
            "/home/user/old-output".into(),
            StorageFingerprint::new("out", "v0"),
        )]),
    };
    let first = f
        .context(
            "thread",
            b"home",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            previous.clone(),
        )
        .await;
    assert_eq!(
        first.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(first);
    for status in [
        HomeCacheTerminalStatus::NonzeroExit,
        HomeCacheTerminalStatus::Cancelled,
    ] {
        let run_id = runner_types::ids::RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let lease = f
            .cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: Some("thread"),
                    working_dir: CWD,
                    image_size_bytes: SIZE,
                },
                home_drive_required: true,
            })
            .await;
        assert!(lease.is_cache_hit());
        let source = lease.source_image.as_ref().unwrap();
        let active = f.paths.active_home_image(&sandbox_id);
        std::fs::create_dir_all(active.parent().unwrap()).unwrap();
        std::fs::rename(source, &active).unwrap();
        let current = StorageFingerprints {
            storages: HashMap::from([(
                "/home/user/current".into(),
                StorageFingerprint::new("now", "v2"),
            )]),
            artifacts: HashMap::from([(
                "/home/user/output".into(),
                StorageFingerprint::new("out", "v2"),
            )]),
        };
        let context = lease
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: status,
                completed_at: format!(
                    "2026-10-09T09:0{}:00Z",
                    if status == HomeCacheTerminalStatus::Cancelled {
                        2
                    } else {
                        1
                    }
                ),
                storage_fingerprints: current.clone(),
            })
            .unwrap();
        assert_eq!(
            context.promote().await.unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
        drop(context);
        let stored = f.metadata("thread").await.storage_fingerprints;
        assert!(stored.storages["/home/user/current"].is_tainted());
        assert!(stored.storages["/home/user/removed"].is_tainted());
        assert!(stored.storages["/home/user/uncertain"].is_tainted());
        assert!(stored.artifacts["/home/user/old-output"].is_tainted());
        assert!(stored.artifacts["/home/user/output"].is_tainted());
        assert!(!stored.storages.contains_key("/home/user/output"));
    }
}
