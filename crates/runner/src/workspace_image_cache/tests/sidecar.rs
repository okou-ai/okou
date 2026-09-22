use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::Path;
use std::time::Duration;

use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, paths::CANONICAL_WORKING_DIR,
};
use guest_contracts::session_history_identity::{SessionHistoryFramework, SessionHistoryRefKind};
use sha2::{Digest, Sha256};
use tokio::fs;

use super::super::metadata::WorkspaceImageFileIdentity;
use super::super::types::{
    WorkspaceSessionHistorySidecarMiss, WorkspaceSessionHistorySidecarPublication,
};
use super::super::{
    WorkspaceImageCache, WorkspaceSessionHistorySidecarPromotionSource,
    WorkspaceSessionHistorySidecarRepresentation,
};
use super::support::{TEST_PROFILE_NAME, local_cache, write_current_cache_entry};
use crate::paths::RunnerPaths;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use runner_types::ids::RunId;

const PERMISSIVE_UMASK_CHILD_ENV: &str = "OKOU_RUN_SIDECAR_PERMISSIVE_UMASK_TEST";
const PUBLICATION_UMASK_ENV: &str = "OKOU_SIDECAR_PUBLICATION_UMASK";

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn test_restored_session_identity(session_id: &str, history: &[u8]) -> RestoredSessionIdentity {
    RestoredSessionIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id,
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        Some(history.len() as u64),
    )
}

async fn publish_test_session_history_sidecar(
    cache: &WorkspaceImageCache,
    cache_key: &str,
    run_id: RunId,
    session_id: &str,
    history: &[u8],
) -> RestoredSessionIdentity {
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(cache_key, run_id);
    fs::write(&tmp_path, history).await.unwrap();
    fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o644))
        .await
        .unwrap();
    let identity = test_restored_session_identity(session_id, history);
    let source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
        restored_session_identity: identity.clone(),
    };
    cache
        .publish_session_history_sidecar(
            cache_key,
            run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&source),
        )
        .await
        .unwrap();
    identity
}

#[tokio::test]
async fn session_history_sidecar_publish_and_probe_hit() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-hit";
    let history = br#"{"type":"message","content":"hello"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;

    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let metadata_path = cache
        .entry_paths(&cache_key)
        .session_history_sidecar_metadata()
        .to_path_buf();
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata_path).await.unwrap()).unwrap();
    assert!(metadata.get("historyGenerationRunId").is_none());
    assert!(metadata.get("allocatedBytes").is_none());
    let held_states = cache.held_workspace_states().await;
    assert_eq!(
        held_states[0].workspace_caches[0].profile,
        TEST_PROFILE_NAME
    );
    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();

    assert_eq!(
        sidecar.representation,
        WorkspaceSessionHistorySidecarRepresentation::Raw
    );
    assert_eq!(sidecar.encoded_size, history.len() as u64);
    assert_eq!(fs::read(&sidecar.path).await.unwrap(), history);
    assert_eq!(mode(cache.workspace_image_cache_dir()), 0o700);
    assert_eq!(
        mode(&cache.workspace_image_cache_entry_dir(&cache_key)),
        0o700
    );
    assert_eq!(mode(&metadata_path), 0o600);
    assert_eq!(mode(&sidecar.path), 0o600);
}

#[tokio::test]
async fn session_history_sidecar_publishes_under_permissive_umask() {
    for mask in ["0002", "0000"] {
        run_ignored_child_test(
            "workspace_image_cache::tests::sidecar::session_history_sidecar_publishes_under_permissive_umask_child",
            (PERMISSIVE_UMASK_CHILD_ENV, "1"),
            &[(PUBLICATION_UMASK_ENV, Some(mask))],
            Duration::from_secs(60),
        )
        .await;
    }
}

#[test]
#[ignore]
fn session_history_sidecar_publishes_under_permissive_umask_child() {
    if !ignored_child_test_env_guard_enabled((PERMISSIVE_UMASK_CHILD_ENV, "1")) {
        return;
    }

    let mask = u32::from_str_radix(&std::env::var(PUBLICATION_UMASK_ENV).unwrap(), 8).unwrap();
    // This exact test runs alone in a child; set umask before Tokio starts any workers.
    nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(mask));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(assert_sidecar_private_publication());
}

async fn assert_sidecar_private_publication() {
    let (dir, paths, cache) = local_cache().await;
    fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();
    fs::set_permissions(paths.base_dir(), std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-private";
    let history = br#"{"type":"message","content":"private"}"#;
    let cache_key =
        cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, CANONICAL_WORKING_DIR, 4096);
    cache
        .ensure_workspace_cache_entry_dir(&cache_key)
        .await
        .unwrap();
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, run_id);
    fs::write(&tmp_path, history).await.unwrap();
    fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))
        .await
        .unwrap();
    let identity = test_restored_session_identity(session_id, history);
    let source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path: tmp_path.clone(),
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
        restored_session_identity: identity.clone(),
    };

    cache
        .publish_session_history_sidecar(
            &cache_key,
            run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&source),
        )
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();
    assert_eq!(fs::read(&sidecar.path).await.unwrap(), history);
    assert_eq!(mode(&sidecar.path), 0o600);
    let entry_paths = cache.entry_paths(&cache_key);
    assert_eq!(mode(entry_paths.session_history_sidecar_metadata()), 0o600);
    assert!(!tmp_path.exists());
    assert!(
        !entry_paths
            .tmp_session_history_sidecar_metadata(run_id)
            .exists()
    );
}

#[tokio::test]
async fn session_history_sidecar_rejects_group_writable_source() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-group-writable";
    let history = br#"{"type":"message","content":"unsafe"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, run_id);
    fs::write(&tmp_path, history).await.unwrap();
    fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o660))
        .await
        .unwrap();
    let source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path: tmp_path.clone(),
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
        restored_session_identity: test_restored_session_identity(session_id, history),
    };

    let error = cache
        .publish_session_history_sidecar(
            &cache_key,
            run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&source),
        )
        .await
        .unwrap_err();

    assert!(error.to_string().contains("group/other writable"));
    assert!(!tmp_path.exists());
    assert!(
        !cache
            .entry_paths(&cache_key)
            .session_history_sidecar_metadata()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn session_history_sidecar_does_not_publish_non_regular_source() {
    let (dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-symlink-source";
    let history = br#"{"type":"message","content":"outside"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let outside = dir.path().join("outside-session-history");
    fs::write(&outside, history).await.unwrap();
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, run_id);
    symlink(&outside, &tmp_path).unwrap();
    let source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path: tmp_path.clone(),
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
        restored_session_identity: test_restored_session_identity(session_id, history),
    };

    cache
        .publish_session_history_sidecar(
            &cache_key,
            run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&source),
        )
        .await
        .unwrap();

    assert!(!tmp_path.exists());
    assert_eq!(fs::read(&outside).await.unwrap(), history);
    assert!(
        !cache
            .entry_paths(&cache_key)
            .session_history_sidecar_metadata()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn previous_session_history_sidecar_metadata_remains_restoreable() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-previous";
    let history = br#"{"type":"message","content":"previous"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let metadata_path = cache
        .entry_paths(&cache_key)
        .session_history_sidecar_metadata()
        .to_path_buf();
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata_path).await.unwrap()).unwrap();
    let metadata = metadata.as_object_mut().unwrap();
    assert!(
        metadata
            .insert("allocatedBytes".into(), 4096_u64.into())
            .is_none()
    );
    assert!(
        metadata
            .insert("historyGenerationRunId".into(), run_id.to_string().into(),)
            .is_none()
    );
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();

    assert_eq!(
        sidecar.representation,
        WorkspaceSessionHistorySidecarRepresentation::Raw
    );
    assert_eq!(sidecar.encoded_size, history.len() as u64);
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn invalid_session_history_sidecars_are_rejected_by_probe() {
    #[derive(Clone, Copy, Debug)]
    enum InvalidSidecarCase {
        MissingMetadata,
        MalformedMetadata,
        UnsupportedRepresentation,
        MetadataSymlink,
        MissingBody,
        BodySymlink,
        SessionMismatch,
        InvalidHash,
        InvalidSize,
        EncodedTooLarge,
    }

    for (case, expected_miss) in [
        (
            InvalidSidecarCase::MissingMetadata,
            WorkspaceSessionHistorySidecarMiss::Missing,
        ),
        (
            InvalidSidecarCase::MalformedMetadata,
            WorkspaceSessionHistorySidecarMiss::InvalidMetadata,
        ),
        (
            InvalidSidecarCase::UnsupportedRepresentation,
            WorkspaceSessionHistorySidecarMiss::UnsupportedFormat,
        ),
        (
            InvalidSidecarCase::MetadataSymlink,
            WorkspaceSessionHistorySidecarMiss::InvalidMetadata,
        ),
        (
            InvalidSidecarCase::MissingBody,
            WorkspaceSessionHistorySidecarMiss::BodyMissing,
        ),
        (
            InvalidSidecarCase::BodySymlink,
            WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch,
        ),
        (
            InvalidSidecarCase::SessionMismatch,
            WorkspaceSessionHistorySidecarMiss::IdentityMismatch,
        ),
        (
            InvalidSidecarCase::InvalidHash,
            WorkspaceSessionHistorySidecarMiss::IdentityMismatch,
        ),
        (
            InvalidSidecarCase::InvalidSize,
            WorkspaceSessionHistorySidecarMiss::IdentityMismatch,
        ),
        (
            InvalidSidecarCase::EncodedTooLarge,
            WorkspaceSessionHistorySidecarMiss::InvalidMetadata,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let session_id = "sess-sidecar-invalid-observation";
        let history = br#"{"type":"message","content":"invalid"}"#;
        let cache_key = write_current_cache_entry(
            &cache,
            run_id,
            session_id,
            CANONICAL_WORKING_DIR,
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        let identity =
            publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history)
                .await;
        let entry_paths = cache.entry_paths(&cache_key);
        let entry_dir = entry_paths.entry_dir();
        let metadata_path = entry_paths.session_history_sidecar_metadata().to_path_buf();
        let body_path = cache
            .probe_session_history_sidecar(&cache_key, &identity)
            .await
            .unwrap()
            .path;

        match case {
            InvalidSidecarCase::MissingMetadata => {
                fs::remove_file(&metadata_path).await.unwrap();
            }
            InvalidSidecarCase::MalformedMetadata => {
                fs::write(&metadata_path, b"not-json").await.unwrap();
            }
            InvalidSidecarCase::UnsupportedRepresentation
            | InvalidSidecarCase::SessionMismatch
            | InvalidSidecarCase::InvalidHash
            | InvalidSidecarCase::InvalidSize
            | InvalidSidecarCase::EncodedTooLarge => {
                let mut metadata: serde_json::Value =
                    serde_json::from_slice(&fs::read(&metadata_path).await.unwrap()).unwrap();
                match case {
                    InvalidSidecarCase::UnsupportedRepresentation => {
                        metadata["representation"] = "codex-zstd".into();
                    }
                    InvalidSidecarCase::SessionMismatch => {
                        metadata["sessionIdHash"] =
                            hex::encode(Sha256::digest(b"another-session")).into();
                    }
                    InvalidSidecarCase::InvalidHash => {
                        metadata["historyHash"] = "not-a-sha256-hash".into();
                    }
                    InvalidSidecarCase::InvalidSize => {
                        metadata["historySizeBytes"] = 0.into();
                    }
                    InvalidSidecarCase::EncodedTooLarge => {
                        metadata["encodedSize"] = (RESUME_SESSION_HISTORY_MAX_BYTES + 1).into();
                    }
                    unexpected => {
                        panic!("unexpected grouped invalid sidecar case: {unexpected:?}")
                    }
                }
                fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
                    .await
                    .unwrap();
            }
            InvalidSidecarCase::MetadataSymlink => {
                let target = entry_dir.join("session-history.metadata.target.json");
                fs::rename(&metadata_path, &target).await.unwrap();
                symlink(&target, &metadata_path).unwrap();
            }
            InvalidSidecarCase::MissingBody => {
                fs::remove_file(&body_path).await.unwrap();
            }
            InvalidSidecarCase::BodySymlink => {
                let target = entry_dir.join("session-history.target.blob");
                fs::rename(&body_path, &target).await.unwrap();
                symlink(&target, &body_path).unwrap();
            }
        }

        assert_eq!(
            cache
                .probe_session_history_sidecar(&cache_key, &identity)
                .await
                .unwrap_err(),
            expected_miss,
            "case: {case:?}"
        );
    }
}

#[tokio::test]
async fn session_history_sidecar_explicit_prune_removes_existing_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-prune";
    let history = br#"{"type":"message","content":"old"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;

    cache
        .publish_session_history_sidecar(
            &cache_key,
            RunId::new_v4(),
            WorkspaceSessionHistorySidecarPublication::Prune,
        )
        .await
        .unwrap();

    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::Missing
    );
}

#[tokio::test]
async fn session_history_sidecar_invalid_replacement_preserves_existing_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-invalid-source-prune";
    let history = br#"{"type":"message","content":"old"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let invalid_tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, RunId::new_v4());
    fs::write(&invalid_tmp_path, b"new").await.unwrap();
    let invalid_source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path: invalid_tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: 0,
        restored_session_identity: identity.clone(),
    };

    cache
        .publish_session_history_sidecar(
            &cache_key,
            RunId::new_v4(),
            WorkspaceSessionHistorySidecarPublication::Replace(&invalid_source),
        )
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn session_history_sidecar_preserve_keeps_existing_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-preserve";
    let history = br#"{"type":"message","content":"old"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;

    cache
        .publish_session_history_sidecar(
            &cache_key,
            RunId::new_v4(),
            WorkspaceSessionHistorySidecarPublication::PreserveExisting,
        )
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn session_history_sidecar_body_rename_failure_preserves_committed_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "session-a",
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let history_a = br#"{"type":"message","content":"a"}"#;
    let identity_a =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, "session-a", history_a)
            .await;
    let committed_a = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap();
    let metadata_path = cache
        .entry_paths(&cache_key)
        .session_history_sidecar_metadata()
        .to_path_buf();
    let metadata_a = fs::read(&metadata_path).await.unwrap();

    let replacement_run_id = RunId::new_v4();
    let history_b = br#"{"type":"message","content":"b"}"#;
    let identity_b = test_restored_session_identity("session-b", history_b);
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, replacement_run_id);
    fs::write(&tmp_path, history_b).await.unwrap();
    let replacement = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history_b.len() as u64,
        restored_session_identity: identity_b,
    };
    let blocked_slot = cache
        .entry_paths(&cache_key)
        .entry_dir()
        .to_path_buf()
        .join("session-history.second.blob");
    fs::create_dir(&blocked_slot).await.unwrap();

    cache
        .publish_session_history_sidecar(
            &cache_key,
            replacement_run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&replacement),
        )
        .await
        .unwrap_err();

    let still_committed = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap();
    assert_eq!(still_committed.path, committed_a.path);
    assert_eq!(fs::read(still_committed.path).await.unwrap(), history_a);
    assert_eq!(fs::read(metadata_path).await.unwrap(), metadata_a);
}

#[tokio::test]
async fn session_history_sidecar_metadata_commit_failure_rolls_back_replacement() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "session-a",
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let history_a = br#"{"type":"message","content":"a"}"#;
    let identity_a =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, "session-a", history_a)
            .await;
    let committed_a = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap();
    let body_a = committed_a.path;
    let body_a_identity =
        WorkspaceImageFileIdentity::from_metadata(&fs::symlink_metadata(&body_a).await.unwrap());
    let entry_paths = cache.entry_paths(&cache_key);
    let entry_dir = entry_paths.entry_dir().to_path_buf();
    let metadata_path = entry_paths.session_history_sidecar_metadata().to_path_buf();
    let metadata_a = fs::read(&metadata_path).await.unwrap();

    let failed_run_id = RunId::new_v4();
    let history_b = br#"{"type":"message","content":"b"}"#;
    let identity_b = test_restored_session_identity("session-b", history_b);
    let failed_source = cache.workspace_image_cache_tmp_sidecar(&cache_key, failed_run_id);
    let failed_metadata = entry_paths.tmp_session_history_sidecar_metadata(failed_run_id);
    let inactive_body = entry_dir.join("session-history.second.blob");
    fs::write(&failed_source, history_b).await.unwrap();
    let replacement = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path: failed_source.clone(),
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history_b.len() as u64,
        restored_session_identity: identity_b.clone(),
    };
    cache.fail_next_session_history_sidecar_metadata_commit();

    let error = cache
        .publish_session_history_sidecar(
            &cache_key,
            failed_run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&replacement),
        )
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("injected workspace session history sidecar metadata commit failure"),
        "unexpected replacement error: {error}",
    );
    assert!(!failed_source.exists());
    assert!(!failed_metadata.exists());
    assert!(!inactive_body.exists());
    assert_eq!(fs::read(&metadata_path).await.unwrap(), metadata_a);
    let still_committed = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap();
    assert_eq!(still_committed.path, body_a);
    assert_eq!(fs::read(&still_committed.path).await.unwrap(), history_a);
    assert_eq!(
        WorkspaceImageFileIdentity::from_metadata(
            &fs::symlink_metadata(&still_committed.path).await.unwrap(),
        ),
        body_a_identity,
    );
    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity_b)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::IdentityMismatch,
    );

    let retry_identity_b = publish_test_session_history_sidecar(
        &cache,
        &cache_key,
        RunId::new_v4(),
        "session-b",
        history_b,
    )
    .await;
    let committed_b = cache
        .probe_session_history_sidecar(&cache_key, &retry_identity_b)
        .await
        .unwrap();
    assert_eq!(committed_b.path, inactive_body);
    assert!(!body_a.exists());
    assert_eq!(fs::read(committed_b.path).await.unwrap(), history_b);
}

#[tokio::test]
async fn session_history_sidecar_verified_replacement_supersedes_previous_identity() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "session-a",
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let history_a = br#"{"type":"message","content":"a"}"#;
    let identity_a =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, "session-a", history_a)
            .await;
    let body_a = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap()
        .path;
    let history_b = br#"{"type":"message","content":"b"}"#;
    let identity_b = test_restored_session_identity("session-b", history_b);
    let replacement_run_id = RunId::new_v4();
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, replacement_run_id);
    fs::write(&tmp_path, history_b).await.unwrap();
    let replacement = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history_b.len() as u64,
        restored_session_identity: identity_b.clone(),
    };

    cache
        .publish_session_history_sidecar(
            &cache_key,
            replacement_run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&replacement),
        )
        .await
        .unwrap();

    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity_a)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::IdentityMismatch
    );
    let sidecar_b = cache
        .probe_session_history_sidecar(&cache_key, &identity_b)
        .await
        .unwrap();
    assert_ne!(sidecar_b.path, body_a);
    assert!(!body_a.exists());
    assert_eq!(fs::read(sidecar_b.path).await.unwrap(), history_b);
}

#[tokio::test]
async fn session_history_sidecar_probe_rejects_mismatched_body_identity() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-mismatch";
    let history = br#"{"type":"message","content":"stable"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let body_path = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap()
        .path;
    fs::write(body_path, b"changed").await.unwrap();

    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch
    );
}

#[tokio::test]
async fn session_history_sidecar_counts_toward_gc_candidate_and_inspection() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-accounting";
    let history = br#"{"type":"message","content":"accounting"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let entry_paths = cache.entry_paths(&cache_key);
    let body_path = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap()
        .path;
    let current_allocated = fs::symlink_metadata(entry_paths.current_image())
        .await
        .unwrap()
        .blocks()
        .saturating_mul(512);
    let body_allocated = fs::symlink_metadata(body_path)
        .await
        .unwrap()
        .blocks()
        .saturating_mul(512);
    let metadata_allocated = fs::symlink_metadata(entry_paths.session_history_sidecar_metadata())
        .await
        .unwrap()
        .blocks()
        .saturating_mul(512);
    assert!(body_allocated > 0);
    assert!(metadata_allocated > 0);
    let expected_allocated = current_allocated
        .saturating_add(body_allocated)
        .saturating_add(metadata_allocated);

    let candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();
    assert_eq!(candidate.allocated_bytes, expected_allocated);

    let inspection = cache.inspect().await.unwrap();
    let entry = inspection
        .entries
        .iter()
        .find(|entry| entry.cache_key == cache_key)
        .unwrap();
    assert_eq!(entry.allocated_bytes, expected_allocated);
}
