use super::BinaryLoggingFixture;
use crate::support::assert_does_not_contain_any;
use serde_json::json;

#[test]
fn binary_empty_artifact_preparation_failure_preserves_prior_work() {
    let fixture = BinaryLoggingFixture::new("empty-artifact-prepare-failure").unwrap();
    let prepared_empty_artifact = fixture.dir.path().join("prepared-empty-artifact");
    let blocker = fixture.dir.path().join("artifact-blocker");
    let blocked_empty_artifact = blocker.join("blocked-empty-artifact");
    std::fs::write(&blocker, "not a directory").unwrap();

    let earlier_archive_url = "https://storage.invalid/empty?token=earlier-secret-token";
    let blocked_archive_url = "https://storage.invalid/empty?token=blocked-secret-token";
    let manifest = json!({
        "storageMounts": [
            {
                "mountPath": prepared_empty_artifact,
                "archiveUrl": earlier_archive_url,
                "empty": true,
                "name": "prepared-empty",
                "versionId": "prepared-empty-v1",
                "writeback": true
            },
            {
                "mountPath": blocked_empty_artifact,
                "archiveUrl": blocked_archive_url,
                "empty": true,
                "name": "blocked-empty",
                "versionId": "blocked-empty-v1",
                "writeback": true
            }
        ]
    });

    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();

    assert!(!output.status.success());
    assert!(prepared_empty_artifact.is_dir());
    assert!(!blocked_empty_artifact.exists());

    let system_log = fixture.read_system_log().unwrap();
    let ops_log = fixture.read_ops_log().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let forbidden = [
        earlier_archive_url,
        blocked_archive_url,
        "earlier-secret-token",
        "blocked-secret-token",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log, &forbidden);

    let ops = fixture.ops_entries().unwrap();
    let target_prepare_index = ops
        .iter()
        .position(|entry| {
            entry["action_type"] == "guest_storage_apply_target_prepare" && entry["success"] == true
        })
        .expect("missing successful guest_storage_apply_target_prepare operation");
    let failed_artifact_index = ops
        .iter()
        .position(|entry| {
            entry["action_type"] == "artifact_empty_prepare" && entry["success"] == false
        })
        .expect("missing failed artifact_empty_prepare operation");
    assert!(
        target_prepare_index < failed_artifact_index,
        "download target preparation should precede the artifact failure: {ops:?}"
    );
    let mut empty_artifact_ops = ops
        .iter()
        .filter(|entry| entry["action_type"] == "artifact_empty_prepare");
    let prepared = empty_artifact_ops.next().unwrap();
    assert_eq!(prepared["success"], true);
    assert!(prepared.get("error").is_none());

    let failed = empty_artifact_ops.next().unwrap();
    assert_eq!(failed["success"], false);
    let error = failed["error"].as_str().unwrap();
    assert!(error.contains("artifact 2"), "unexpected error: {error}");
    assert!(
        error.contains("vasStorageName=blocked-empty"),
        "unexpected error: {error}"
    );
    assert!(
        error.contains("vasVersionId=blocked-empty-v1"),
        "unexpected error: {error}"
    );
    assert!(empty_artifact_ops.next().is_none());
    assert!(
        !ops.iter()
            .any(|entry| entry["action_type"] == "guest_storage_apply_archive_scheduler"),
        "archive scheduler should not run: {ops:?}"
    );
}
