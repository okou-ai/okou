use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use async_trait::async_trait;

#[tokio::test]
async fn snapshot_provider_can_discard_uncommitted_snapshot() {
    let provider = MockSnapshotProvider;
    let output_dir = std::env::temp_dir().join(format!(
        "sandbox-mock-snapshot-discard-{}",
        uuid::Uuid::new_v4().simple()
    ));

    let mut pending = provider
        .create_uncommitted_snapshot(test_snapshot_config(output_dir))
        .await
        .expect("create uncommitted snapshot");

    pending.discard().await.expect("discard pending snapshot");
}

#[tokio::test]
async fn snapshot_provider_default_create_snapshot_commits_pending_publish() {
    let provider = MockSnapshotProvider;
    let output_dir = std::env::temp_dir().join(format!(
        "sandbox-mock-snapshot-{}",
        uuid::Uuid::new_v4().simple()
    ));

    let output = provider
        .create_snapshot(SnapshotCreateConfig {
            id: "snapshot-test".into(),
            binary_path: "/tmp/firecracker".into(),
            kernel_path: "/tmp/kernel".into(),
            rootfs_path: "/tmp/rootfs.ext4".into(),
            output_dir: output_dir.clone(),
            vcpu_count: 1,
            memory_mb: 128,
            home_disk_mb: 16,
        })
        .await
        .expect("create snapshot");

    assert_eq!(output.snapshot_path, output_dir.join("snapshot.bin"));
    assert_eq!(output.memory_path, output_dir.join("memory.bin"));
    assert_eq!(output.cow_path, output_dir.join("cow.img"));
}

struct FailingPendingSnapshotPublish {
    discarded: Arc<AtomicBool>,
    discard_error: Option<&'static str>,
}

#[async_trait]
impl PendingSnapshotPublish for FailingPendingSnapshotPublish {
    async fn commit(&mut self) -> std::result::Result<SnapshotOutput, SnapshotError> {
        Err(SnapshotError::Teardown("commit failed".into()))
    }

    async fn discard(&mut self) -> std::result::Result<(), SnapshotError> {
        self.discarded.store(true, Ordering::SeqCst);
        match self.discard_error {
            Some(message) => Err(SnapshotError::Teardown(message.into())),
            None => Ok(()),
        }
    }
}

struct FailingSnapshotProvider {
    discarded: Arc<AtomicBool>,
    discard_error: Option<&'static str>,
}

#[async_trait]
impl SnapshotProvider for FailingSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        _config: SnapshotCreateConfig,
    ) -> std::result::Result<Box<dyn PendingSnapshotPublish>, SnapshotError> {
        Ok(Box::new(FailingPendingSnapshotPublish {
            discarded: Arc::clone(&self.discarded),
            discard_error: self.discard_error,
        }))
    }

    fn config_hash(&self) -> String {
        "failing-snapshot-config-hash".into()
    }

    async fn is_complete(
        &self,
        _output_dir: &std::path::Path,
    ) -> std::result::Result<bool, SnapshotError> {
        Ok(false)
    }
}

#[tokio::test]
async fn snapshot_provider_default_create_snapshot_discards_after_commit_failure() {
    let discarded = Arc::new(AtomicBool::new(false));
    let provider = FailingSnapshotProvider {
        discarded: Arc::clone(&discarded),
        discard_error: None,
    };
    let output_dir = std::env::temp_dir().join(format!(
        "sandbox-mock-snapshot-failure-{}",
        uuid::Uuid::new_v4().simple()
    ));

    let err = provider
        .create_snapshot(test_snapshot_config(output_dir))
        .await
        .expect_err("commit should fail");

    assert!(
        matches!(err, SnapshotError::Teardown(ref message) if message == "commit failed"),
        "got: {err:?}"
    );
    assert!(
        discarded.load(Ordering::SeqCst),
        "default create_snapshot should discard after commit failure"
    );
}

#[tokio::test]
async fn snapshot_provider_default_create_snapshot_preserves_commit_error_when_discard_fails() {
    let discarded = Arc::new(AtomicBool::new(false));
    let provider = FailingSnapshotProvider {
        discarded: Arc::clone(&discarded),
        discard_error: Some("discard failed"),
    };
    let output_dir = std::env::temp_dir().join(format!(
        "sandbox-mock-snapshot-double-failure-{}",
        uuid::Uuid::new_v4().simple()
    ));

    let err = provider
        .create_snapshot(test_snapshot_config(output_dir))
        .await
        .expect_err("commit should fail");

    assert!(
        matches!(err, SnapshotError::Teardown(ref message) if message == "commit failed"),
        "discard failure must not mask the commit failure, got: {err:?}"
    );
    assert!(
        discarded.load(Ordering::SeqCst),
        "default create_snapshot should still discard after commit failure"
    );
}
