//! Allocator requests and live buffers are observed only in the exact guarded child.
use super::super::allocation::{
    LARGEST, LIVE_PAYLOAD_BYTES, Measurement, PAYLOAD_THRESHOLD, RELEASED_PAYLOAD_BYTES,
};
use super::*;
use guest_contracts::storage_manifest::ArtifactEntry;
use std::sync::atomic::Ordering;
use std::time::Duration;

const CHILD_ENV: &str = "OKOU_TEST_DECODED_STORAGE_BATCH_MEMORY";
const CHILD_TEST: &str =
    "executor::tests::storage_delivery_tests::memory::decoded_storage_batch_memory_child";
#[tokio::test]
async fn decoded_storage_batches_bound_allocations_and_release_completed_inputs() {
    let output = crate::test_fixtures::ignored_child::run_ignored_child_test(
        CHILD_TEST,
        (CHILD_ENV, "1"),
        &[],
        Duration::from_secs(60),
    )
    .await;
    assert!(
        !output.truncated,
        "allocation child output must be complete"
    );
    eprintln!("{}", output.stderr);
}

fn assert_complete_delivery(sandbox: &MockSandbox, expected: &serde_json::Value, content: &[u8]) {
    let mut mounts = Vec::new();
    let mut delivered = 0;
    for call in sandbox.storage_manifest_calls() {
        let (json, payload) = storage_files::split_input(&call.manifest_json).unwrap();
        assert!(json.len() <= storage_files::MAX_MANIFEST_BYTES);
        let manifest: Manifest = serde_json::from_slice(json).unwrap();
        let value: serde_json::Value = serde_json::from_slice(json).unwrap();
        mounts.extend(value["storageMounts"].as_array().unwrap().iter().cloned());
        assert_eq!(value["cleanupPaths"], serde_json::json!([]));
        let groups = storage_files::decode(payload).unwrap();
        storage_files::validate_bindings(
            &manifest,
            groups.iter().map(|group| group.mount_path.as_str()),
        )
        .unwrap();
        for group in groups {
            assert_eq!(group.files.len(), 1);
            let file = &group.files[0];
            assert_eq!(file.path, "file");
            assert_eq!(file.content, content);
            assert_eq!(file.mode, 0o755);
            assert_eq!(file.mtime, 1234);
            delivered += 1;
        }
    }
    assert!(
        serde_json::Value::Array(mounts) == expected["storageMounts"],
        "complete canonical mount data must survive batching"
    );
    assert_eq!(
        delivered,
        expected["storageMounts"].as_array().unwrap().len()
    );
}

#[tokio::test]
#[ignore = "ordinary parent runs this exact guarded allocation process"]
async fn decoded_storage_batch_memory_child() {
    if !crate::test_fixtures::ignored_child::ignored_child_test_env_guard_enabled((CHILD_ENV, "1"))
    {
        return;
    }

    let fixture = DeliveryFixture::new(256, 256, 35_000).await;
    let sandbox = MockSandbox::new("large-decoded-manifest");
    let (manifest, files) = fixture.prepare(&sandbox).await;
    let expected = serde_json::to_value(&manifest).unwrap();
    let source_bytes = serde_json::to_vec(&manifest).unwrap().len();
    assert!(source_bytes > 8 * 1024 * 1024);
    assert_eq!(files.len(), 256);
    let context = minimal_context();
    let mut telemetry = test_telemetry(&fixture.config, &context);
    let measurement = Measurement::start();
    let result =
        download_storages_with_files(&sandbox, &context, manifest, &files, &mut telemetry).await;
    drop(measurement);
    let largest = LARGEST.load(Ordering::Relaxed);
    fixture.shutdown().await;

    result.unwrap();
    assert_complete_delivery(&sandbox, &expected, b"content");
    eprintln!("aggregate: source bytes={source_bytes}, largest allocation={largest}");
    // Individual requests only, not RSS or an aggregate final-batch bound.
    assert!(
        largest <= 1024 * 1024,
        "input-sized sizing allocation: {largest}"
    );
    encoded_payloads_follow_the_current_guest_operation().await;
}

async fn encoded_payloads_follow_the_current_guest_operation() {
    let content = (0..storage_files::MAX_FILE_BYTES)
        .map(|index| index as u8)
        .collect::<Vec<_>>();
    let fixture = DeliveryFixture::with_archive(3, 3, 35_000, archive_with_content(&content)).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_storage_manifest_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("completed-storage-buffers", overrides);
    let (manifest, files) = fixture.prepare(&sandbox).await;
    let expected = serde_json::to_value(&manifest).unwrap();
    let context = minimal_context();
    let mut telemetry = test_telemetry(&fixture.config, &context);
    let mut released_before_apply = Vec::with_capacity(3);
    let mut live_before_apply = Vec::with_capacity(3);
    let measurement = Measurement::start();
    let result = {
        let delivery =
            download_storages_with_files(&sandbox, &context, manifest, &files, &mut telemetry);
        tokio::pin!(delivery);
        for index in 1..=3 {
            tokio::select! {
                result = &mut delivery => panic!("delivery ended before batch {index}: {result:?}"),
                entered = gate.wait_entered(index, RUN_IN_SANDBOX_TEST_TIMEOUT) => { entered.unwrap(); },
            }
            // The source files and both mock transport records remain owned.
            // Inspect records only after measurement to avoid counting copies.
            released_before_apply.push(RELEASED_PAYLOAD_BYTES.load(Ordering::Relaxed));
            live_before_apply.push(LIVE_PAYLOAD_BYTES.load(Ordering::Relaxed));
            gate.release_one();
        }
        tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, delivery)
            .await
            .unwrap()
    };
    drop(measurement);
    fixture.shutdown().await;

    result.unwrap();
    assert_complete_delivery(&sandbox, &expected, &content);
    let calls = sandbox.storage_manifest_calls();
    assert_eq!(calls.len(), 3);
    for call in &calls {
        assert!(call.manifest_json.len() > PAYLOAD_THRESHOLD);
        assert!(guest_storage_apply::run_storage_files_bytes(
            &call.manifest_json
        ));
    }
    for (mount, _) in &files {
        let path = std::path::Path::new(mount).join("file");
        assert_eq!(std::fs::read(&path).unwrap(), content);
        let metadata = std::fs::metadata(path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o755);
        assert_eq!(metadata.mtime(), 1234);
    }
    let mut completed_bytes = 0;
    let mut retained_record_bytes = 0;
    for (index, call) in calls.iter().enumerate() {
        // Each entered operation is retained by both independent mock owners.
        retained_record_bytes += 2 * call.manifest_json.len();
        let expected_live = retained_record_bytes + call.manifest_json.len();
        eprintln!(
            "before batch {index}: released={}, completed payload bytes={completed_bytes}, live={}, current input plus records={expected_live}",
            released_before_apply[index], live_before_apply[index],
        );
        assert_eq!(released_before_apply[index], completed_bytes);
        assert_eq!(
            live_before_apply[index], expected_live,
            "future encoded payloads must not remain live during Guest IO"
        );
        completed_bytes += call.manifest_json.len();
    }
}

#[tokio::test]
async fn mixed_decoded_mounts_preserve_the_canonical_manifest_boundary() {
    for overflow in [0, 1] {
        let mut fixture = DeliveryFixture::new(2, 2, 512).await;
        fixture.manifest.storages[1]
            .mount_path
            .push_str("-\"-\\-界");
        let sandbox = MockSandbox::new("mixed-decoded-boundary");
        let (mut manifest, files) = fixture.prepare(&sandbox).await;
        let storage = manifest.storages.pop().unwrap();
        manifest.artifacts.push(ArtifactEntry {
            mount_path: storage.mount_path,
            archive_url: storage.archive_url,
            empty: false,
            cached: false,
            vas_storage_name: storage.vas_storage_name,
            vas_storage_id: Some("artifact-id".into()),
            vas_version_id: storage.vas_version_id,
            missing_root_policy: Some("preserveParentVersion".into()),
        });
        let target = storage_files::MAX_MANIFEST_BYTES + overflow;
        let before = serde_json::to_vec(&manifest).unwrap().len();
        manifest.artifacts[0]
            .archive_url
            .as_mut()
            .unwrap()
            .extend(std::iter::repeat_n('x', target - before));
        assert_eq!(serde_json::to_vec(&manifest).unwrap().len(), target);
        let expected = serde_json::to_value(&manifest).unwrap();
        let result = apply_with_telemetry(&fixture, &sandbox, manifest, &files).await;
        fixture.shutdown().await;

        result.unwrap();
        assert_complete_delivery(&sandbox, &expected, b"content");
        assert_eq!(sandbox.storage_manifest_calls().len(), 1 + overflow);
    }
}
