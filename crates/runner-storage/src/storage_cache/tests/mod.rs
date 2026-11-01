use super::*;

mod archive_retries;
mod batch_limits;
mod cache_publication;
mod decoded_observation;
mod fresh_staging;
mod fresh_teardown;
mod group_failures;
mod http_reuse;
mod large_selection;
mod phase_diagnostics;
mod rejected_observation;

use async_trait::async_trait;
use httpmock::Method::{GET, HEAD};
use httpmock::prelude::*;
use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};
use sandbox_mock::{MockLifecycleGate, MockSandbox};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpListener;

use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::storage_plan::build_storage_plan;
use crate::test_fixtures::raw_http::{
    RawHttpAction, RawHttpTestServer, http_response, join_raw_http_task, json_response,
    read_http_request,
};
use runner_types::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};

// Cache tests observe selection at its join boundary. Executor tests use
// the production entry point directly to verify pre-create overlap.
async fn prepare_fresh_archive_delivery(
    plan: &mut StoragePlan,
    home: &HomePaths,
    admission: &FreshArchiveDeliveryAdmission,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
    decoded: Option<&decoded::DecodedCache>,
) -> RunnerResult<FreshArchiveDelivery> {
    let mut delivery =
        super::prepare_fresh_archive_delivery(plan, home, admission, cancel, telemetry, decoded)
            .await?;
    if let Err(error) = delivery.finish_classification(telemetry).await {
        delivery.cancel_and_drain(telemetry).await;
        return Err(error);
    }
    Ok(delivery)
}

fn new_telemetry() -> JobTelemetry {
    new_telemetry_for_api_url("http://localhost:0")
}

fn new_telemetry_for_api_url(api_url: &str) -> JobTelemetry {
    JobTelemetry::new(api_url)
}

fn assert_op(ops: &[(String, bool, Option<String>)], action_type: &str, success: bool) {
    assert!(
        ops.iter()
            .any(|(key, op_success, _)| key == action_type && *op_success == success),
        "expected {action_type} success={success} in {ops:?}"
    );
}

fn assert_op_error(
    ops: &[(String, bool, Option<String>)],
    action_type: &str,
    expected_error: &str,
) {
    let error = ops
        .iter()
        .find(|(key, _, _)| key == action_type)
        .and_then(|(_, _, error)| error.as_deref());
    assert_eq!(
        error,
        Some(expected_error),
        "expected {action_type} error {expected_error:?} in {ops:?}"
    );
}

fn assert_no_op(ops: &[(String, bool, Option<String>)], action_type: &str) {
    assert!(
        !ops.iter().any(|(key, _, _)| key == action_type),
        "expected no {action_type} in {ops:?}"
    );
}

fn op_count(ops: &[(String, bool, Option<String>)], action_type: &str) -> usize {
    ops.iter().filter(|(key, _, _)| key == action_type).count()
}

fn assert_op_count(ops: &[(String, bool, Option<String>)], action_type: &str, expected: usize) {
    assert_eq!(
        op_count(ops, action_type),
        expected,
        "expected {expected} {action_type} ops in {ops:?}"
    );
}

fn assert_bounded_outcome(
    ops: &[(String, bool, Option<String>, Option<String>)],
    action_type: &str,
    success: bool,
    outcome: &str,
    reason: Option<&str>,
) {
    assert!(
        ops.iter()
            .any(|(action, op_success, op_outcome, op_reason)| {
                action == action_type
                    && *op_success == success
                    && op_outcome.as_deref() == Some(outcome)
                    && op_reason.as_deref() == reason
            }),
        "expected {action_type} success={success} outcome={outcome:?} reason={reason:?} in {ops:?}"
    );
}

fn bounded_outcome_count(
    ops: &[(String, bool, Option<String>, Option<String>)],
    action_type: &str,
) -> usize {
    ops.iter()
        .filter(|(action, _, _, _)| action == action_type)
        .count()
}

#[test]
fn count_bucket_outcome_uses_stable_ranges() {
    for (count, expected) in [
        (0, "0"),
        (1, "1"),
        (2, "2"),
        (3, "3_4"),
        (4, "3_4"),
        (5, "5_8"),
        (8, "5_8"),
        (9, "9_16"),
        (16, "9_16"),
        (17, "17_plus"),
    ] {
        assert_eq!(count_bucket_outcome(count), expected);
    }
}

fn op_duration_ms(ops: &[(String, u64, bool, Option<String>)], action_type: &str) -> u64 {
    ops.iter()
        .find(|(key, _, _, _)| key == action_type)
        .map(|(_, duration_ms, _, _)| *duration_ms)
        .unwrap_or_else(|| panic!("expected {action_type} in {ops:?}"))
}

async fn select_background_fill(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> DeferredBackgroundFill {
    populate_cache(plan, sandbox, home, telemetry)
        .await
        .unwrap()
        .expect("cold cache entry should select a background fill")
}

async fn populate_cache_through_background(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Vec<SandboxOpRecord>> {
    let Some(deferred) = populate_cache(plan, sandbox, home, telemetry).await? else {
        return Ok(Vec::new());
    };
    let records = deferred.run().await;
    if records.iter().any(|record| {
        matches!(
            record.action_type,
            STORAGE_CACHE_BACKGROUND_FILL_FILLED | STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED
        )
    }) {
        let deferred = populate_cache(plan, sandbox, home, telemetry).await?;
        assert!(
            deferred.is_none(),
            "successful background fill should produce a later warm hit"
        );
    }
    Ok(records)
}

async fn populate_cache_through_fresh_delivery(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<DeferredBackgroundFill>> {
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut delivery =
        prepare_fresh_archive_delivery(plan, home, &admission, &cancel, telemetry, None).await?;
    populate_cache_with_fresh_delivery(plan, sandbox, home, telemetry, Some(&mut delivery), None)
        .await
}

fn assert_background_op(records: &[SandboxOpRecord], action_type: &str, success: bool) {
    assert!(
        records
            .iter()
            .any(|record| { record.action_type == action_type && record.success == success }),
        "expected {action_type} success={success} in {records:?}"
    );
}

fn assert_background_op_count(records: &[SandboxOpRecord], action_type: &str, expected: usize) {
    let actual = records
        .iter()
        .filter(|record| record.action_type == action_type)
        .count();
    assert_eq!(
        actual, expected,
        "expected {expected} {action_type} records in {records:?}"
    );
}

fn home_at(temp: &tempfile::TempDir) -> HomePaths {
    HomePaths::with_root(temp.path().to_path_buf())
}

fn storage_entry(mount_path: String, url: String, name: &str, version: &str) -> StorageEntry {
    StorageEntry {
        name: name.to_string(),
        mount_path,
        archive_url: url,
        vas_storage_name: name.to_string(),
        vas_version_id: version.to_string(),
        archive_size: None,
    }
}

fn storage_entry_with_archive_size(
    mount_path: String,
    url: String,
    name: &str,
    version: &str,
    archive_size: Option<u64>,
) -> StorageEntry {
    let mut entry = storage_entry(mount_path, url, name, version);
    entry.archive_size = archive_size;
    entry
}

fn artifact_entry(mount_path: String, url: String, name: &str, version: &str) -> ArtifactEntry {
    ArtifactEntry {
        mount_path,
        archive_url: Some(url),
        vas_storage_name: name.to_string(),
        vas_storage_id: format!("{name}-id"),
        vas_version_id: version.to_string(),
        empty: None,
        missing_root_policy: None,
        archive_size: None,
    }
}

fn plan_from_entries(
    storages: Vec<StorageEntry>,
    artifacts: Vec<ArtifactEntry>,
    previous: Option<&StorageFingerprints>,
) -> StoragePlan {
    build_storage_plan(
        &StorageManifest {
            storages,
            artifacts,
        },
        previous,
    )
    .unwrap()
}

fn fresh_storage_plan(url: String, name: &str, version: &str) -> StoragePlan {
    plan_from_entries(
        vec![storage_entry(format!("/mnt/{name}"), url, name, version)],
        Vec::new(),
        None,
    )
}

fn fresh_storage_plan_with_archive_size(
    url: String,
    name: &str,
    version: &str,
    archive_size: u64,
) -> StoragePlan {
    plan_from_entries(
        vec![storage_entry_with_archive_size(
            format!("/mnt/{name}"),
            url,
            name,
            version,
            Some(archive_size),
        )],
        Vec::new(),
        None,
    )
}

fn fresh_duplicate_storage_plan(
    first_url: String,
    second_url: String,
    name: &str,
    version: &str,
) -> StoragePlan {
    plan_from_entries(
        vec![
            storage_entry("/mnt/duplicate-a".into(), first_url, name, version),
            storage_entry("/mnt/duplicate-b".into(), second_url, name, version),
        ],
        Vec::new(),
        None,
    )
}

fn fresh_artifact_plan(url: String, name: &str, version: &str) -> StoragePlan {
    plan_from_entries(
        Vec::new(),
        vec![artifact_entry(
            format!("/mnt/artifact-{name}"),
            url,
            name,
            version,
        )],
        None,
    )
}

fn storage_archive_url(plan: &StoragePlan, index: usize) -> Option<&str> {
    plan.archive_source_url_for_test(ArchiveHandle::storage(index))
}

fn artifact_archive_url(plan: &StoragePlan, index: usize) -> Option<&str> {
    plan.archive_source_url_for_test(ArchiveHandle::artifact(index))
}

fn tarball_bytes() -> Vec<u8> {
    tarball_with_contents(b"storage cache test file\n")
}

fn tarball_with_contents(content: &[u8]) -> Vec<u8> {
    tarball_with_compression(content, flate2::Compression::default())
}

fn tarball_with_compression(content: &[u8], compression: flate2::Compression) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let encoder = flate2::write::GzEncoder::new(&mut bytes, compression);
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "file.txt", content)
            .unwrap();
        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();
    }
    bytes
}

fn write_cached_archive(home: &HomePaths, name: &str, version: &str, bytes: &[u8]) {
    let cache_dir = home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join("archive.tar.gz"), bytes).unwrap();
}

fn write_storage_lock(home: &HomePaths, name: &str, version: &str) {
    drop(lock::open_lock_file(&home.storage_lock(name, version)).unwrap());
}

#[tokio::test]
async fn decoded_hit_survives_restart_and_compressed_eviction_while_archive_lock_is_busy() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("decoded-hit");
    let cache = decoded::DecodedCache::new(home.clone());
    let mount = temp.path().join("guest-mount");
    let entry = storage_entry(
        mount.to_str().unwrap().into(),
        "https://storage.example/immutable.tar.gz".into(),
        "name",
        "v1",
    );
    write_cached_archive(&home, "name", "v1", &tarball_bytes());
    write_storage_lock(&home, "name", "v1");
    cache.warm_from_archive("name", "v1").await.unwrap();
    cache.shutdown().await;
    let cache = decoded::DecodedCache::new(home.clone());

    // Extracted files survive owner restart and compressed-cache GC.
    // Holding the archive lock proves the hit never reopens the archive.
    std::fs::remove_file(home.storage_cache_dir("name", "v1").join("archive.tar.gz")).unwrap();
    let writer = lock::acquire(home.storage_lock("name", "v1"))
        .await
        .unwrap();
    let mut hit = plan_from_entries(vec![entry.clone()], Vec::new(), None);
    assert!(
        populate_cache_with_fresh_delivery(
            &mut hit,
            &sandbox,
            &home,
            &mut new_telemetry(),
            None,
            Some(&cache),
        )
        .await
        .unwrap()
        .is_none()
    );
    let files = hit.take_decoded();
    assert_eq!(files.len(), 1);
    cache.shutdown().await;
    let manifest = serde_json::to_vec(&hit.into_guest_manifest()).unwrap();
    let input = guest_contracts::storage_files::encode_input(
        &manifest,
        &[(files[0].0.as_str(), &files[0].1.files)],
    )
    .unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(&input));
    assert_eq!(
        std::fs::read(mount.join("file.txt")).unwrap(),
        b"storage cache test file\n"
    );
    assert_eq!(
        std::fs::metadata(mount.join("file.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    drop(writer);
}

#[tokio::test]
async fn decoded_lookup_misses_do_not_alias_names_or_versions() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("decoded-identity");
    let cache = decoded::DecodedCache::new(home.clone());
    write_cached_archive(&home, "name", "v1", &tarball_bytes());
    write_storage_lock(&home, "name", "v1");
    cache.warm_from_archive("name", "v1").await.unwrap();
    let mut fill = fresh_storage_plan("https://storage.example/a".into(), "name", "v1");
    populate_cache_with_fresh_delivery(
        &mut fill,
        &sandbox,
        &home,
        &mut new_telemetry(),
        None,
        Some(&cache),
    )
    .await
    .unwrap();
    for (name, version) in [("name", "v2"), ("other", "v1")] {
        let url = "https://storage.example/selected";
        let mut plan = fresh_storage_plan(url.into(), name, version);
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut new_telemetry(),
            None,
            Some(&cache),
        )
        .await
        .unwrap();
        assert!(deferred.is_some());
        assert!(plan.take_decoded().is_empty());
        assert_eq!(storage_archive_url(&plan, 0), Some(url));
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn artifact_delivery_reads_validated_decoded_entries_and_rejects_corruption() {
    for corrupt in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("decoded-artifact");
        let warming_cache = decoded::DecodedCache::new(home.clone());
        write_cached_archive(&home, "name", "v1", &tarball_bytes());
        write_storage_lock(&home, "name", "v1");
        warming_cache.warm_from_archive("name", "v1").await.unwrap();
        warming_cache.shutdown().await;
        std::fs::remove_file(home.storage_cache_dir("name", "v1").join("archive.tar.gz")).unwrap();
        if corrupt {
            let entry = home
                .storages_dir()
                .join(short_digest("name"))
                .join(format!("decoded-v2-{}", short_digest("v1")));
            std::fs::write(entry.join("index.json"), b"{").unwrap();
        }
        let cache = decoded::DecodedCache::new(home.clone());
        let mut plan = fresh_artifact_plan(
            "https://storage.example/artifact.tar.gz".into(),
            "name",
            "v1",
        );
        let mut telemetry = new_telemetry();
        let result = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            None,
            Some(&cache),
        )
        .await;
        if corrupt {
            assert!(result.is_err());
        } else {
            assert!(result.unwrap().is_none());
            let files = plan.take_decoded();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].0, "/mnt/artifact-name");
            assert_eq!(files[0].1.files[0].content, b"storage cache test file\n");
            assert_op(
                &telemetry.pending_ops_snapshot(),
                STORAGE_CACHE_ARTIFACT_DECODED,
                true,
            );
        }
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn conflicting_artifact_decoded_hit_reports_bounded_ineligibility() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    write_cached_archive(&home, "artifact", "v1", &tarball_bytes());
    write_storage_lock(&home, "artifact", "v1");
    cache.warm_from_archive("artifact", "v1").await.unwrap();
    let mut plan = plan_from_entries(
        vec![storage_entry(
            "/mnt/artifact-artifact/child".into(),
            "https://storage.example/other.tar.gz".into(),
            "other",
            "v1",
        )],
        vec![artifact_entry(
            "/mnt/artifact-artifact".into(),
            "https://storage.example/artifact.tar.gz".into(),
            "artifact",
            "v1",
        )],
        None,
    );
    let mut groups = group_targets(collect_targets(plan.cache_candidates()));
    let mut telemetry = new_telemetry();

    prepare_decoded_storage(&mut plan, &mut groups, &cache, &mut telemetry)
        .await
        .unwrap();

    assert!(plan.take_decoded().is_empty());
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_ARTIFACT_DECODED_INELIGIBLE,
        true,
    );
    cache.shutdown().await;
}

#[tokio::test]
async fn ready_decoded_files_preserve_mount_and_manifest_admission() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("decoded-admission");
    let cache = decoded::DecodedCache::new(home.clone());
    write_cached_archive(&home, "name", "v1", &tarball_bytes());
    write_storage_lock(&home, "name", "v1");
    cache.warm_from_archive("name", "v1").await.unwrap();
    let url = "https://storage.example/a";
    let mut fill = fresh_storage_plan(url.into(), "name", "v1");
    populate_cache_with_fresh_delivery(
        &mut fill,
        &sandbox,
        &home,
        &mut new_telemetry(),
        None,
        Some(&cache),
    )
    .await
    .unwrap();
    let long_url = format!(
        "{url}?{}",
        "a".repeat(guest_contracts::storage_files::MAX_MANIFEST_BYTES)
    );
    let plans = [
        plan_from_entries(
            vec![storage_entry(
                "/mnt/parent".into(),
                url.into(),
                "name",
                "v1",
            )],
            vec![artifact_entry(
                "/mnt/parent/child".into(),
                url.into(),
                "name",
                "v1",
            )],
            None,
        ),
        fresh_storage_plan(long_url, "name", "v1"),
    ];
    for mut plan in plans {
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut new_telemetry(),
            None,
            Some(&cache),
        )
        .await
        .unwrap();
        assert!(deferred.is_none(), "validated contents need no warming");
        assert!(plan.take_decoded().is_empty());
        assert!(
            storage_archive_url(&plan, 0)
                .unwrap()
                .starts_with("file://")
        );
    }
    cache.shutdown().await;
}

struct SamePathConcurrentWriteDetectingSandbox {
    inner: MockSandbox,
    gate: MockLifecycleGate,
    active_paths: Mutex<HashSet<String>>,
}

impl SamePathConcurrentWriteDetectingSandbox {
    fn new(id: impl Into<String>) -> Self {
        let inner = MockSandbox::new(id);
        let gate = MockLifecycleGate::new();
        inner.set_write_file_lifecycle_gate(gate.clone());
        Self {
            inner,
            gate,
            active_paths: Mutex::new(HashSet::new()),
        }
    }

    fn gate(&self) -> MockLifecycleGate {
        self.gate.clone()
    }

    fn write_file_calls(&self) -> Vec<sandbox_mock::WriteFileCall> {
        self.inner.write_file_calls()
    }
}

#[async_trait]
impl Sandbox for SamePathConcurrentWriteDetectingSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn host_process_pid(&self) -> Option<u32> {
        self.inner.host_process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(
        &self,
        request: &sandbox::ExecRequest<'_>,
    ) -> sandbox::Result<sandbox::ExecResult> {
        self.inner.exec(request).await
    }

    async fn exec_with_diagnostic_label(
        &self,
        request: &sandbox::ExecRequest<'_>,
        label: &'static str,
    ) -> sandbox::Result<sandbox::ExecResult> {
        self.inner.exec_with_diagnostic_label(request, label).await
    }

    async fn apply_storage_manifest(
        &self,
        request: &sandbox::StorageManifestRequest<'_>,
    ) -> sandbox::Result<sandbox::ExecResult> {
        self.inner.apply_storage_manifest(request).await
    }

    async fn restore_guest_state(
        &self,
        request: &sandbox::GuestStateRestoreRequest<'_>,
    ) -> sandbox::Result<sandbox::ExecResult> {
        self.inner.restore_guest_state(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: sandbox::CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        self.inner.copy_file(path, host_path, options).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        {
            let mut active_paths = self.active_paths.lock().unwrap_or_else(|e| e.into_inner());
            if !active_paths.insert(path.to_string()) {
                return Err(SandboxError::Operation {
                    operation: SandboxOperation::WriteFile,
                    reason: SandboxOperationReason::Other,
                    message: format!("concurrent write_file to {path}"),
                });
            }
        }

        let result = self.inner.write_file(path, content).await;
        self.active_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(path);
        result
    }

    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        compression: sandbox::FileCompression,
    ) -> sandbox::Result<Option<sandbox::FileWriteMeasurements>> {
        self.inner
            .write_file_with_compression(path, content, compression)
            .await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_private_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &sandbox::StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn start_agent_process(
        &self,
        request: &sandbox::StartAgentProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestAgentProcessHandle> {
        self.inner.start_agent_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<sandbox::ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

async fn raw_http_url(response: Vec<u8>) -> (String, RawHttpTestServer) {
    raw_http_sequence_url(vec![response]).await
}

async fn raw_http_sequence_url(responses: Vec<Vec<u8>>) -> (String, RawHttpTestServer) {
    let server =
        RawHttpTestServer::spawn(responses.into_iter().map(RawHttpAction::Respond).collect()).await;
    (format!("{}/archive.tar.gz", server.url()), server)
}

struct GatedArchiveServer {
    url: String,
    requests: tokio::sync::mpsc::Receiver<usize>,
    paths: Arc<Mutex<Vec<String>>>,
    release: Arc<Semaphore>,
    max_active: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn gated_archive_server(body: Vec<u8>, connections: usize) -> GatedArchiveServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (request_tx, request_rx) = tokio::sync::mpsc::channel(connections);
    let release = Arc::new(Semaphore::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let paths = Arc::new(Mutex::new(Vec::new()));
    let task_paths = Arc::clone(&paths);
    let task_release = Arc::clone(&release);
    let task_active = Arc::clone(&active);
    let task_max_active = Arc::clone(&max_active);
    let task = tokio::spawn(async move {
        let mut handlers = JoinSet::new();
        for index in 0..connections {
            let (mut socket, _) = listener.accept().await?;
            let body = body.clone();
            let request_tx = request_tx.clone();
            let release = Arc::clone(&task_release);
            let active = Arc::clone(&task_active);
            let max_active = Arc::clone(&task_max_active);
            let paths = Arc::clone(&task_paths);
            handlers.spawn(async move {
                let request = read_http_request(&mut socket).await?;
                paths
                    .lock()
                    .unwrap()
                    .push(request.split_whitespace().nth(1).unwrap().to_string());
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(current, Ordering::SeqCst);
                request_tx.send(index).await.map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "request receiver dropped")
                })?;
                let permit = release.acquire_owned().await.map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "release semaphore closed")
                })?;
                // Each permit releases one response, without unblocking the next handler.
                permit.forget();
                socket.write_all(&http_response("200 OK", &body)).await?;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok::<(), io::Error>(())
            });
        }
        while let Some(result) = handlers.join_next().await {
            result.map_err(|error| io::Error::other(error.to_string()))??;
        }
        Ok(())
    });
    GatedArchiveServer {
        url: format!("http://{addr}/archive.tar.gz"),
        requests: request_rx,
        paths,
        release,
        max_active,
        task,
    }
}

async fn telemetry_capture_server(expected_requests: usize) -> (String, RawHttpTestServer) {
    let server = RawHttpTestServer::spawn(
        (0..expected_requests)
            .map(|_| RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)))
            .collect(),
    )
    .await;
    (server.url(), server)
}

async fn await_raw_http_sequence(server: RawHttpTestServer) {
    server.assert_finished().await;
}

async fn wait_cached_archive(home: &HomePaths, name: &str, version: &str) -> Vec<u8> {
    let lock_path = home.storage_lock(name, version);
    let path = home.storage_cache_dir(name, version).join("archive.tar.gz");
    let _reader = tokio::time::timeout(Duration::from_secs(5), lock::acquire_shared(lock_path))
        .await
        .expect("background fill should release cache lock")
        .expect("cache lock should be readable");
    fs::read(&path)
        .await
        .unwrap_or_else(|e| panic!("failed to read cached archive {}: {e}", path.display()))
}

fn partial_content_response(total: usize) -> Vec<u8> {
    format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{total}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx"
        )
        .into_bytes()
}

fn background_fill_group(
    url: String,
    name: &str,
    version: &str,
    archive_size: Option<u64>,
) -> CacheTargetGroup {
    CacheTargetGroup {
        decoded_ready_observed: false,
        representative: CacheTarget {
            handle: ArchiveHandle::storage(0),
            name: name.to_string(),
            version: version.to_string(),
            archive_url: url,
            archive_size,
        },
        additional_targets: Vec::new(),
        archive_size,
    }
}

#[tokio::test]
async fn fresh_delivery_records_empty_scan_summary() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let mut plan = plan_from_entries(Vec::new(), Vec::new(), None);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut telemetry = new_telemetry();

    let delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();

    assert!(delivery.apply.is_empty());
    let ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        true,
        "0",
        Some("prepared"),
    );
    assert_bounded_outcome(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "none",
        None,
    );
    assert_eq!(
        bounded_outcome_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS),
        1
    );
    assert_eq!(
        bounded_outcome_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX),
        0
    );
    assert_eq!(
        bounded_outcome_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX_UNKNOWN),
        0
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn fresh_delivery_only_needs_ca_certificates_for_admitted_misses() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    fs::create_dir_all(home.ca_dir()).await.unwrap();
    let certificate = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert_file = home.ca_dir().join("test-ca-cert.pem");
    fs::write(&cert_file, certificate.cert.pem()).await.unwrap();
    let empty_cert_dir = temp.path().join("empty-certs");
    fs::create_dir(&empty_cert_dir).await.unwrap();

    crate::test_fixtures::ignored_child::run_ignored_child_test(
        "storage_cache::tests::fresh_delivery_missing_ca_child",
        ("VM0_TEST_FRESH_DELIVERY_MISSING_CA", "1"),
        &[
            ("SSL_CERT_FILE", Some(cert_file.to_str().unwrap())),
            ("SSL_CERT_DIR", Some(empty_cert_dir.to_str().unwrap())),
        ],
        Duration::from_secs(30),
    )
    .await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "runs in an isolated process with its own CA certificate files"]
async fn fresh_delivery_missing_ca_child() {
    if !crate::test_fixtures::ignored_child::ignored_child_test_env_guard_enabled((
        "VM0_TEST_FRESH_DELIVERY_MISSING_CA",
        "1",
    )) {
        return;
    }

    // Initialize unrelated telemetry before making this child's CA store
    // unavailable. Changing a private file needs no process-wide env mutation.
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/archive.tar.gz");
            then.status(200).body(body.clone());
        })
        .await;
    let cert_file = std::env::var_os("SSL_CERT_FILE").unwrap();
    let certificates = fs::read(&cert_file).await.unwrap();
    fs::write(&cert_file, b"").await.unwrap();

    for case in [
        "empty",
        "warm",
        "decoded-only",
        "oversized",
        "lock-busy",
        "capacity",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let storages = (0..if case == "empty" { 0 } else { 2 })
            .map(|index| {
                let name = format!("{case}-{index}");
                if matches!(case, "warm" | "decoded-only") {
                    write_cached_archive(&home, &name, "v1", &body);
                }
                storage_entry_with_archive_size(
                    format!("/mnt/{name}"),
                    server.url("/archive.tar.gz"),
                    &name,
                    "v1",
                    Some(if case == "oversized" {
                        CACHE_MAX_SIZE + 1
                    } else {
                        body.len() as u64
                    }),
                )
            })
            .collect();
        let mut plan = plan_from_entries(storages, Vec::new(), None);
        let decoded = (case == "decoded-only").then(|| decoded::DecodedCache::new(home.clone()));
        if let Some(cache) = &decoded {
            for index in 0..2 {
                let name = format!("decoded-only-{index}");
                write_storage_lock(&home, &name, "v1");
                cache.warm_from_archive(&name, "v1").await.unwrap();
                fs::remove_file(home.storage_cache_dir(&name, "v1").join("archive.tar.gz"))
                    .await
                    .unwrap();
            }
        }
        let mut writers = Vec::new();
        if case == "lock-busy" {
            for index in 0..2 {
                writers.push(
                    lock::acquire(home.storage_lock(&format!("{case}-{index}"), "v1"))
                        .await
                        .unwrap(),
                );
            }
        }
        let held_capacity = (case == "capacity").then(|| {
            Arc::clone(&admission.permits)
                .try_acquire_many_owned(FRESH_DELIVERY_RUNNER_LIMIT as u32)
                .unwrap()
        });

        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            decoded.as_ref(),
        )
        .await
        .unwrap_or_else(|error| panic!("{case} should not need a client: {error}"));
        if case == "warm" {
            let sandbox = MockSandbox::new("test");
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await
            .unwrap();
            assert!(deferred.is_none());
            let batches = sandbox.write_files_calls();
            let files: Vec<_> = batches.iter().flat_map(|batch| &batch.files).collect();
            assert_eq!(files.len(), 2);
            for index in 0..2 {
                let path = guest_archive_path(&format!("warm-{index}"), "v1");
                assert!(
                    files
                        .iter()
                        .any(|file| file.path == path && file.content == body)
                );
                assert_eq!(
                    storage_archive_url(&plan, index),
                    Some(format!("file://{path}").as_str())
                );
            }
        }
        if let Some(cache) = &decoded {
            let sandbox = MockSandbox::new("decoded-only");
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                Some(&mut delivery),
                Some(cache),
            )
            .await
            .unwrap();
            assert!(deferred.is_none());
            assert!(sandbox.write_files_calls().is_empty());
            let files = plan.take_decoded();
            assert_eq!(files.len(), 2);
            for (index, (mount, cached)) in files.iter().enumerate() {
                assert_eq!(mount, &format!("/mnt/decoded-only-{index}"));
                assert_eq!(cached.files.len(), 1);
                assert_eq!(cached.files[0].path, "file.txt");
                assert_eq!(
                    cached.files[0].content,
                    b"storage cache test file\n".as_slice()
                );
            }
            cache.shutdown().await;
        }
        delivery.cancel_and_drain(&mut telemetry).await;
        drop(held_capacity);
        drop(writers);
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT,
            "{case} must not retain capacity"
        );
    }

    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut plan = fresh_storage_plan_with_archive_size(
        server.url("/archive.tar.gz"),
        "cold",
        "v1",
        body.len() as u64,
    );
    let error =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .err()
            .expect("an admitted miss still requires a valid client");
    assert!(
        error
            .to_string()
            .contains("build runner-owned archive client")
    );
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    assert!(!home.storage_cache_dir("cold", "v1").exists());
    get.assert_calls_async(0).await;

    // Restoring the CA store makes the same archive eligible again. A leaked
    // writer lock would skip this fetch; a cached failed client would fail it.
    fs::write(&cert_file, certificates).await.unwrap();
    let mut delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();
    let sandbox = MockSandbox::new("test");
    assert!(
        populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            Some(&mut delivery),
            None,
        )
        .await
        .unwrap()
        .is_none()
    );
    get.assert_calls_async(1).await;
    assert_eq!(
        fs::read(home.storage_cache_dir("cold", "v1").join("archive.tar.gz"))
            .await
            .unwrap(),
        body
    );
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn fresh_delivery_downloads_known_archive_once_and_stages_it() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-known.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let name = "fresh-known";
    let version = "v1";
    let mut plan = fresh_storage_plan_with_archive_size(
        server.url("/fresh-known.tar.gz"),
        name,
        version,
        body.len() as u64,
    );

    let deferred =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

    assert!(deferred.is_none());
    get.assert_calls_async(1).await;
    assert_eq!(
        storage_archive_url(&plan, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    assert_eq!(
        fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz"))
            .await
            .unwrap(),
        body
    );
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_COMPLETE, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_STAGED, true);
    assert_no_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY);
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        true,
        "1",
        Some("prepared"),
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "none",
        None,
    );
}

#[tokio::test]
async fn fresh_delivery_uses_response_size_when_stored_archive_size_is_stale() {
    // Both archives contain file.txt with identical contents, but gzip
    // compression changes the wire size without changing the logical version.
    let compressed = tarball_bytes();
    let uncompressed =
        tarball_with_compression(b"storage cache test file\n", flate2::Compression::none());
    assert!(compressed.len() < uncompressed.len());
    let compressed_size = compressed.len() as u64;
    let uncompressed_size = uncompressed.len() as u64;
    for (case, body, stored_size) in [
        ("larger", compressed, uncompressed_size),
        ("smaller", uncompressed, compressed_size),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new(case);
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/stale-size.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let name = format!("stale-{case}");
        let version = "v1";
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url("/stale-size.tar.gz"),
            &name,
            version,
            stored_size,
        );

        assert!(
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap()
                .is_none()
        );
        get.assert_calls_async(1).await;
        assert_eq!(
            storage_archive_url(&plan, 0),
            Some(format!("file://{}", guest_archive_path(&name, version)).as_str())
        );
        assert_eq!(
            fs::read(
                home.storage_cache_dir(&name, version)
                    .join("archive.tar.gz")
            )
            .await
            .unwrap(),
            body
        );
        assert_eq!(sandbox.write_files_calls().len(), 1);
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SIZE_RESPONSE, true);
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_STAGED, true);
    }
}

#[tokio::test]
async fn fresh_delivery_retains_runner_capacity_until_guest_staging_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = Arc::new(MockSandbox::new("test"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-capacity.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut plan = fresh_storage_plan_with_archive_size(
        server.url("/fresh-capacity.tar.gz"),
        "fresh-capacity",
        "v1",
        body.len() as u64,
    );
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();
    let task = tokio::spawn({
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox);
        async move {
            populate_cache_with_fresh_delivery(
                &mut plan,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await
        }
    });

    gate.wait_entered(1, Duration::from_secs(5))
        .await
        .expect("fresh archive should reach guest staging");
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1,
        "published bytes must retain runner capacity while guest staging is blocked"
    );

    gate.release_one();
    assert!(task.await.unwrap().unwrap().is_none());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    get.assert_calls_async(1).await;
}

#[tokio::test]
async fn fresh_delivery_unknown_size_uses_one_response_for_duplicate_targets() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let first = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-duplicate-a.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let second = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-duplicate-b.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let name = "fresh-duplicate";
    let version = "v1";
    let mut plan = fresh_duplicate_storage_plan(
        server.url("/fresh-duplicate-a.tar.gz"),
        server.url("/fresh-duplicate-b.tar.gz"),
        name,
        version,
    );

    let deferred =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

    assert!(deferred.is_none());
    first.assert_calls_async(1).await;
    second.assert_calls_async(0).await;
    let staged_url = format!("file://{}", guest_archive_path(name, version));
    assert_eq!(storage_archive_url(&plan, 0), Some(staged_url.as_str()));
    assert_eq!(storage_archive_url(&plan, 1), Some(staged_url.as_str()));
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].content, body);
    assert_eq!(
        fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz"))
            .await
            .unwrap(),
        body
    );
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_FRESH_DELIVERY_SIZE_RESPONSE,
        true,
    );
}

#[tokio::test]
async fn fresh_delivery_unknown_size_is_bounded_to_the_original_candidate_prefix() {
    for prefix_count in [FRESH_DELIVERY_SCAN_LIMIT - 1, FRESH_DELIVERY_SCAN_LIMIT] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("unknown-prefix");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/unknown.tar.gz");
                then.status(200).body(body.clone());
            })
            .await;
        let mut storages = (0..prefix_count)
            .map(|index| {
                let name = format!("warm-{index}");
                write_cached_archive(&home, &name, "v1", &body);
                storage_entry_with_archive_size(
                    format!("/mnt/warm-{index}"),
                    server.url(format!("/warm-{index}.tar.gz")),
                    &name,
                    "v1",
                    Some(body.len() as u64),
                )
            })
            .collect::<Vec<_>>();
        let original = server.url("/unknown.tar.gz");
        storages.push(storage_entry(
            "/mnt/unknown".into(),
            original.clone(),
            "unknown",
            "v1",
        ));
        let mut plan = plan_from_entries(storages, Vec::new(), None);

        let deferred =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        let eligible = prefix_count < FRESH_DELIVERY_SCAN_LIMIT;
        assert_eq!(deferred.is_none(), eligible);
        drop(deferred);
        get.assert_calls_async(usize::from(eligible)).await;
        let expected = if eligible {
            format!("file://{}", guest_archive_path("unknown", "v1"))
        } else {
            original
        };
        assert_eq!(
            storage_archive_url(&plan, prefix_count),
            Some(expected.as_str())
        );
        let staged = sandbox.write_files_calls();
        let unknown = staged
            .iter()
            .flat_map(|batch| &batch.files)
            .find(|file| file.path == guest_archive_path("unknown", "v1"));
        assert_eq!(
            unknown.map(|file| file.content.as_slice()),
            eligible.then_some(body.as_slice())
        );
    }
}

#[tokio::test]
async fn fresh_delivery_unknown_size_requires_a_bounded_response_length() {
    for (headers, reason) in [
        ("".to_string(), "response-size-missing"),
        ("Content-Length: 0\r\n".to_string(), "response-size-zero"),
        (
            format!("Content-Length: {}\r\n", CACHE_MAX_SIZE + 1),
            "response-size-oversized",
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new(reason);
        let mut telemetry = new_telemetry();
        let response = format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n");
        let (url, server_task) = raw_http_url(response.into_bytes()).await;
        let mut plan = fresh_storage_plan(url.clone(), "unknown-length", "v1");

        let result =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await;

        server_task.assert_finished().await;
        assert!(matches!(result, Err(RunnerError::Internal(_))), "{reason}");
        assert_eq!(storage_archive_url(&plan, 0), Some(url.as_str()));
        assert!(sandbox.write_files_calls().is_empty());
        assert!(
            !home
                .storage_cache_dir("unknown-length", "v1")
                .join("archive.tar.gz")
                .exists()
        );
        assert_op_error(
            &telemetry.pending_ops_snapshot(),
            STORAGE_CACHE_FRESH_DELIVERY_FAILED,
            reason,
        );
    }
}

#[tokio::test]
async fn fresh_delivery_releases_warm_entry_for_bounded_revalidation() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "fresh-warm";
    let version = "v1";
    let body = tarball_bytes();
    write_cached_archive(&home, name, version, &body);
    let mut plan = fresh_storage_plan_with_archive_size(
        "https://storage.example/unused.tar.gz".into(),
        name,
        version,
        body.len() as u64,
    );

    let deferred =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

    assert!(deferred.is_none());
    assert_eq!(
        storage_archive_url(&plan, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_WARM, true);
    assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED);
    assert_op(&ops, STORAGE_CACHE_HIT_READ, true);
}

#[tokio::test]
async fn fresh_delivery_handles_artifact_downloads_through_the_same_owner() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-artifact.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let name = "fresh-artifact";
    let version = "v1";
    let mut entry = artifact_entry(
        "/mnt/artifact".into(),
        server.url("/fresh-artifact.tar.gz"),
        name,
        version,
    );
    entry.archive_size = Some(body.len() as u64);
    let mut plan = plan_from_entries(Vec::new(), vec![entry], None);

    let deferred =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

    assert!(deferred.is_none());
    get.assert_calls_async(1).await;
    assert_eq!(
        artifact_archive_url(&plan, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_STAGED, true);
}

#[tokio::test]
async fn fresh_delivery_rejects_unsolicited_partial_content() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-partial.tar.gz")
                .header_missing("range");
            then.status(206).body(tarball_bytes());
        })
        .await;
    let original = server.url("/fresh-partial.tar.gz");
    let mut plan = fresh_storage_plan_with_archive_size(
        original.clone(),
        "fresh-partial",
        "v1",
        tarball_bytes().len() as u64,
    );

    let result =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await;

    assert!(matches!(result, Err(RunnerError::Internal(_))));
    get.assert_calls_async(1).await;
    assert_eq!(storage_archive_url(&plan, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir("fresh-partial", "v1")
            .join("archive.tar.gz")
            .exists()
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_FRESH_DELIVERY_FAILED, "http-status");
    assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED);
}

#[tokio::test]
async fn fresh_delivery_does_not_follow_redirects() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let redirect = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-redirect.tar.gz")
                .header_missing("range");
            then.status(302)
                .header("location", "/redirect-target.tar.gz");
        })
        .await;
    let target = server
        .mock_async(|when, then| {
            when.method(GET).path("/redirect-target.tar.gz");
            then.status(200).body(body.clone());
        })
        .await;
    let original = server.url("/fresh-redirect.tar.gz");
    let mut plan = fresh_storage_plan_with_archive_size(
        original.clone(),
        "fresh-redirect",
        "v1",
        body.len() as u64,
    );

    let result =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await;

    assert!(matches!(result, Err(RunnerError::Internal(_))));
    redirect.assert_calls_async(1).await;
    target.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&plan, 0), Some(original.as_str()));
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_FRESH_DELIVERY_FAILED, "http-status");
    assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST, 1);
}

#[tokio::test]
async fn fresh_delivery_known_size_rejects_short_and_long_chunked_bodies() {
    for (case, delivered) in [
        ("short", b"abc".as_slice()),
        ("long", b"abcdefg".as_slice()),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new(case);
        let mut telemetry = new_telemetry();
        let mut response =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        response.extend_from_slice(format!("{:x}\r\n", delivered.len()).as_bytes());
        response.extend_from_slice(delivered);
        response.extend_from_slice(b"\r\n0\r\n\r\n");
        let (url, server_task) = raw_http_url(response).await;
        let mut plan =
            fresh_storage_plan_with_archive_size(url.clone(), &format!("fresh-{case}"), "v1", 5);

        let result =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await;

        server_task.assert_finished().await;
        assert!(matches!(result, Err(RunnerError::Internal(_))));
        assert_eq!(storage_archive_url(&plan, 0), Some(url.as_str()));
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_FAILED,
            "body-size-mismatch",
        );
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED);
    }
}

#[tokio::test]
async fn fresh_delivery_cancellation_releases_lock_and_runner_capacity() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/fresh-cancel.tar.gz")
                .header_missing("range");
            then.status(200)
                .delay(Duration::from_secs(5))
                .body(tarball_bytes());
        })
        .await;
    let name = "fresh-cancel";
    let version = "v1";
    let mut plan = fresh_storage_plan_with_archive_size(
        server.url("/fresh-cancel.tar.gz"),
        name,
        version,
        tarball_bytes().len() as u64,
    );
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if get.calls_async().await == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fresh GET should start before cancellation");
    tokio::time::timeout(
        Duration::from_secs(1),
        delivery.cancel_and_drain(&mut telemetry),
    )
    .await
    .expect("cancellation should drain promptly");

    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    match lock::try_acquire_or_busy(home.storage_lock(name, version))
        .await
        .unwrap()
    {
        lock::TryLock::Acquired(_) => {}
        lock::TryLock::Busy => panic!("cancelled delivery must release its cache lock"),
    }
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_CANCELLED, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_DRAINED, true);
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        true,
        "1",
        Some("prepared"),
    );
}

#[tokio::test]
async fn fresh_delivery_cancellation_drains_started_publication() {
    let admission = FreshArchiveDeliveryAdmission::new();
    let permit = admission.try_reserve(1).unwrap();
    let mut telemetry = new_telemetry();
    let plan = fresh_storage_plan(
        "https://storage.example/publication.tar.gz".to_string(),
        "fresh-publication",
        "v1",
    );
    let group = group_targets(collect_targets(plan.cache_candidates()))
        .into_iter()
        .next()
        .unwrap();
    let completed = Arc::new(Mutex::new(false));
    let task_completed = Arc::clone(&completed);
    let publication_cancel = CancellationToken::new();
    let release_after_cancel = publication_cancel.clone();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut delivery = FreshArchiveDelivery {
        cancel: publication_cancel,
        phase_records: FreshArchivePhaseRecords::default(),
        classification: JoinSet::new(),
        groups: None,
        apply: Vec::new(),
        fetches: JoinSet::new(),
        publications: JoinSet::new(),
    };
    let phase_records = delivery.phase_records.clone();
    delivery.publications.spawn(async move {
        let phase =
            FreshArchivePhaseGuard::new(&phase_records, STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION);
        entered_tx.send(()).unwrap();
        release_rx.await.unwrap();
        *task_completed.lock().unwrap() = true;
        phase.finish(Ok(()));
        FreshArchivePublicationTaskResult {
            group,
            result: Ok(FreshArchivePublished {
                bytes: Bytes::from_static(b"complete"),
                permit,
            }),
        }
    });

    entered_rx.await.unwrap();
    let release = async move {
        release_after_cancel.cancelled().await;
        release_tx.send(()).unwrap();
    };
    tokio::join!(delivery.cancel_and_drain(&mut telemetry), release);

    assert!(*completed.lock().unwrap());
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_CANCELLED, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_DRAINED, true);
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION, true);
    assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION, 1);
    delivery.cancel_and_drain(&mut telemetry).await;
    assert_op_count(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION,
        1,
    );
    admission.shutdown().await;
}

#[tokio::test]
async fn fresh_delivery_known_oversized_archive_issues_no_request() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/fresh-oversized.tar.gz");
            then.status(200).body(tarball_bytes());
        })
        .await;
    let original = server.url("/fresh-oversized.tar.gz");
    let mut plan = fresh_storage_plan_with_archive_size(
        original.clone(),
        "fresh-oversized",
        "v1",
        CACHE_MAX_SIZE + 1,
    );

    let _deferred =
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

    get.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&plan, 0), Some(original.as_str()));
    assert!(sandbox.write_files_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_OVERSIZED, true);
    assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED);
}

#[tokio::test]
async fn fresh_delivery_lock_contention_keeps_guest_ownership_without_a_request() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/fresh-lock-busy.tar.gz");
            then.status(200).body(tarball_bytes());
        })
        .await;
    let name = "fresh-lock-busy";
    let version = "v1";
    let mut plan = fresh_storage_plan_with_archive_size(
        server.url("/fresh-lock-busy.tar.gz"),
        name,
        version,
        tarball_bytes().len() as u64,
    );
    let writer = match lock::try_acquire_or_busy(home.storage_lock(name, version))
        .await
        .unwrap()
    {
        lock::TryLock::Acquired(writer) => writer,
        lock::TryLock::Busy => panic!("test must acquire the cache writer"),
    };
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();

    let delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();

    assert!(delivery.apply.is_empty());
    get.assert_calls_async(0).await;
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_LOCK_BUSY, true);
    assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED);
    drop(delivery);
    drop(writer);
}

#[tokio::test]
async fn fresh_delivery_scan_summary_marks_preparation_failure() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    fs::write(home.locks_dir(), b"not a directory")
        .await
        .unwrap();
    let mut plan = fresh_storage_plan_with_archive_size(
        "https://example.invalid/prepare-failure.tar.gz".to_string(),
        "prepare-failure",
        "v1",
        1,
    );
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut telemetry = new_telemetry();

    let error =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .err()
            .unwrap();

    assert!(error.to_string().contains("lock dir"));
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        false,
        "1",
        Some("prepare_failed"),
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        false,
        "none",
        None,
    );
}

#[tokio::test]
async fn fresh_delivery_reaches_later_misses_after_warm_prefix() {
    const WARM_PREFIX_COUNT: usize = 48;

    fn scan_fixture_plan(base_url: &str, body_size: u64) -> StoragePlan {
        let storages = (0..WARM_PREFIX_COUNT + 5)
            .map(|index| {
                storage_entry_with_archive_size(
                    format!("/mnt/scan-{index}"),
                    format!("{base_url}/scan-{index}.tar.gz"),
                    &format!("scan-{index}"),
                    "v1",
                    Some(body_size),
                )
            })
            .collect();
        plan_from_entries(storages, Vec::new(), None)
    }

    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let mut gets = Vec::new();
    for index in WARM_PREFIX_COUNT..WARM_PREFIX_COUNT + 5 {
        gets.push(
            server
                .mock_async(|when, then| {
                    when.method(GET)
                        .path(format!("/scan-{index}.tar.gz"))
                        .header_missing("range");
                    then.status(200).body(body.clone());
                })
                .await,
        );
    }

    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    for index in 0..WARM_PREFIX_COUNT {
        let cache_dir = home.storage_cache_dir(&format!("scan-{index}"), "v1");
        fs::create_dir_all(&cache_dir).await.unwrap();
        fs::write(cache_dir.join("archive.tar.gz"), &body)
            .await
            .unwrap();
    }
    let mut plan = scan_fixture_plan(&server.base_url(), body.len() as u64);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut telemetry = new_telemetry();
    let mut delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();

    assert_eq!(delivery.apply.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
    let sandbox = MockSandbox::new("test");
    let deferred = populate_cache_with_fresh_delivery(
        &mut plan,
        &sandbox,
        &home,
        &mut telemetry,
        Some(&mut delivery),
        None,
    )
    .await
    .unwrap();

    assert!(
        deferred.is_some(),
        "the fifth eligible group should remain deferred background work"
    );
    drop(deferred);
    for get in gets.iter().take(FRESH_DELIVERY_PER_RUN_LIMIT) {
        get.assert_calls_async(1).await;
    }
    gets[FRESH_DELIVERY_PER_RUN_LIMIT]
        .assert_calls_async(0)
        .await;
    for index in WARM_PREFIX_COUNT..WARM_PREFIX_COUNT + FRESH_DELIVERY_PER_RUN_LIMIT {
        assert!(
            storage_archive_url(&plan, index).is_some_and(|url| url.starts_with("file://")),
            "scan fixture entry {index} should use the staged archive"
        );
    }
    let untouched_index = WARM_PREFIX_COUNT + FRESH_DELIVERY_PER_RUN_LIMIT;
    let untouched_url = server.url(format!("/scan-{untouched_index}.tar.gz"));
    assert_eq!(
        storage_archive_url(&plan, untouched_index),
        Some(untouched_url.as_str())
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_WARM, WARM_PREFIX_COUNT);
    assert_op_count(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_ADMITTED,
        FRESH_DELIVERY_PER_RUN_LIMIT,
    );
    assert_op_count(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST,
        FRESH_DELIVERY_PER_RUN_LIMIT,
    );
    assert_op_count(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_COMPLETE,
        FRESH_DELIVERY_PER_RUN_LIMIT,
    );
    assert_op_count(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED,
        FRESH_DELIVERY_PER_RUN_LIMIT,
    );
    assert_op_count(
        &ops,
        STORAGE_CACHE_FRESH_DELIVERY_STAGED,
        FRESH_DELIVERY_PER_RUN_LIMIT,
    );
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        true,
        "17_plus",
        Some("prepared"),
    );
    assert_eq!(
        bounded_outcome_count(&outcome_ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX),
        0
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "per_run",
        None,
    );
}

#[tokio::test]
async fn fresh_delivery_expanded_misses_require_complete_admission() {
    for case in [
        "complete",
        "capacity",
        "overflow",
        "writer",
        "unknown",
        "oversized",
        "unkeyed",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let cold_get = server
            .mock_async(|when, then| {
                when.method(GET).path_includes("/expanded-");
                then.status(200).body(body.clone());
            })
            .await;
        let mut storages = (0..98)
            .map(|index| {
                let name = format!("warm-{index}");
                write_cached_archive(&home, &name, "v1", &body);
                storage_entry_with_archive_size(
                    format!("/warm/{index}"),
                    server.url(format!("/warm-{index}")),
                    &name,
                    "v1",
                    Some(body.len() as u64),
                )
            })
            .collect::<Vec<_>>();
        let cold_count = if case == "overflow" { 5 } else { 4 };
        for index in 0..cold_count {
            let size = match (case, index) {
                ("unknown", 3) => None,
                ("oversized", 3) => Some(CACHE_MAX_SIZE + 1),
                _ => Some(body.len() as u64),
            };
            storages.push(storage_entry_with_archive_size(
                format!("/cold/{index}"),
                server.url(format!("/expanded-{index}")),
                &if case == "unkeyed" && index == 3 {
                    String::new()
                } else {
                    format!("expanded-{index}")
                },
                "v1",
                size,
            ));
        }
        let mut plan = plan_from_entries(storages, Vec::new(), None);
        let admission = FreshArchiveDeliveryAdmission::new();
        let held = if case == "capacity" {
            Some(
                Arc::clone(&admission.permits)
                    .try_acquire_many_owned(5)
                    .unwrap(),
            )
        } else {
            None
        };
        let writer = if case == "writer" {
            Some(
                lock::acquire(home.storage_lock("expanded-3", "v1"))
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        let mut telemetry = new_telemetry();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &CancellationToken::new(),
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let sandbox = MockSandbox::new(case);
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            Some(&mut delivery),
            None,
        )
        .await
        .unwrap();
        let admitted = case == "complete";
        cold_get
            .assert_calls_async(if admitted { 4 } else { 0 })
            .await;
        for index in 0..cold_count {
            let expected = if admitted {
                format!(
                    "file://{}",
                    guest_archive_path(&format!("expanded-{index}"), "v1")
                )
            } else {
                server.url(format!("/expanded-{index}"))
            };
            assert_eq!(
                storage_archive_url(&plan, 98 + index),
                Some(expected.as_str()),
                "{case}"
            );
            let batches = sandbox.write_files_calls();
            let staged = batches
                .iter()
                .flat_map(|batch| &batch.files)
                .find(|file| file.path == guest_archive_path(&format!("expanded-{index}"), "v1"));
            assert_eq!(
                staged.map(|file| file.content.as_slice()),
                admitted.then_some(body.as_slice()),
                "{case}"
            );
        }
        drop(deferred);
        delivery.cancel_and_drain(&mut telemetry).await;
        drop(writer);
        drop(held);
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT,
            "{case}"
        );
    }
}

#[tokio::test]
async fn fresh_delivery_concurrent_expanded_sets_keep_whole_request_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let mut warm = Vec::new();
    for index in 0..98 {
        let name = format!("shared-warm-{index}");
        write_cached_archive(&home, &name, "v1", &body);
        warm.push(storage_entry_with_archive_size(
            format!("/warm/{index}"),
            server.url(format!("/warm-{index}")),
            &name,
            "v1",
            Some(body.len() as u64),
        ));
    }
    let mut gets = Vec::new();
    for lane in 0..4 {
        gets.push(
            server
                .mock_async(|when, then| {
                    when.method(GET).path_includes(format!("/lane-{lane}-"));
                    then.status(200).body(body.clone());
                })
                .await,
        );
    }
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut preparations = Vec::new();
    for lane in 0..4 {
        let mut entries = warm.clone();
        for index in 0..4 {
            let name = format!("lane-{lane}-{index}");
            entries.push(storage_entry_with_archive_size(
                format!("/cold/{index}"),
                server.url(format!("/{name}")),
                &name,
                "v1",
                Some(body.len() as u64),
            ));
        }
        let home = &home;
        let admission = &admission;
        preparations.push(async move {
            let mut plan = plan_from_entries(entries, Vec::new(), None);
            let mut telemetry = new_telemetry();
            let delivery = prepare_fresh_archive_delivery(
                &mut plan,
                home,
                admission,
                &CancellationToken::new(),
                &mut telemetry,
                None,
            )
            .await
            .unwrap();
            (lane, plan, telemetry, delivery)
        });
    }
    // Every preparation completes while all admitted requests are still
    // held before Guest staging, so no lane can borrow released capacity.
    let prepared = futures_util::future::join_all(preparations).await;
    let mut admitted_lanes = 0;
    for (lane, mut plan, mut telemetry, mut delivery) in prepared {
        let sandbox = MockSandbox::new("concurrent-expanded");
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            Some(&mut delivery),
            None,
        )
        .await
        .unwrap();
        let staged = (98..102)
            .filter(|&index| {
                storage_archive_url(&plan, index).is_some_and(|url| url.starts_with("file://"))
            })
            .count();
        assert!(
            staged == 0 || staged == 4,
            "lane {lane} has a partial set: {staged}"
        );
        gets[lane].assert_calls_async(staged).await;
        if staged == 4 {
            admitted_lanes += 1;
        }
        let batches = sandbox.write_files_calls();
        for index in 0..4 {
            let name = format!("lane-{lane}-{index}");
            let file = batches
                .iter()
                .flat_map(|batch| &batch.files)
                .find(|file| file.path == guest_archive_path(&name, "v1"));
            assert_eq!(
                file.map(|file| file.content.as_slice()),
                (staged == 4).then_some(body.as_slice())
            );
        }
        drop(deferred);
        delivery.cancel_and_drain(&mut telemetry).await;
    }
    assert_eq!(admitted_lanes, 2);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn fresh_delivery_runner_capacity_keeps_late_misses_on_ordinary_source() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let mut telemetry = new_telemetry();
    let storages = (0..=FRESH_DELIVERY_SCAN_LIMIT)
        .map(|index| {
            storage_entry_with_archive_size(
                format!("/mnt/saturated-{index}"),
                format!("https://example.invalid/saturated-{index}.tar.gz"),
                &format!("saturated-{index}"),
                "v1",
                Some(1),
            )
        })
        .collect();
    let mut plan = plan_from_entries(storages, Vec::new(), None);
    let admission = FreshArchiveDeliveryAdmission::new();
    let held_permits = (0..FRESH_DELIVERY_RUNNER_LIMIT)
        .map(|_| Arc::clone(&admission.permits).try_acquire_owned().unwrap())
        .collect::<Vec<_>>();
    let cancel = CancellationToken::new();

    let delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();

    assert!(delivery.apply.is_empty());
    assert!(
        !home
            .storage_lock(&format!("saturated-{FRESH_DELIVERY_SCAN_LIMIT}"), "v1")
            .exists(),
        "a saturated runner must not acquire another archive writer"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(
        ops.iter()
            .filter(|(action, _, error)| {
                action == STORAGE_CACHE_FRESH_DELIVERY_CAPACITY
                    && error.as_deref() == Some("runner-wide")
            })
            .count(),
        FRESH_DELIVERY_SCAN_LIMIT
    );
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "runner_wide",
        None,
    );
    assert_eq!(
        bounded_outcome_count(&outcome_ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP),
        1
    );
    drop(held_permits);
}

#[tokio::test]
async fn fresh_delivery_scan_summary_buckets_unknown_suffix_sizes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET);
            then.status(200).body(tarball_bytes());
        })
        .await;
    let mut storages = (0..FRESH_DELIVERY_SCAN_LIMIT)
        .map(|index| {
            storage_entry_with_archive_size(
                format!("/mnt/unknown-prefix-{index}"),
                server.url(format!("/unknown-prefix-{index}.tar.gz")),
                &format!("unknown-prefix-{index}"),
                "v1",
                Some(CACHE_MAX_SIZE + 1),
            )
        })
        .collect::<Vec<_>>();
    storages.push(storage_entry_with_archive_size(
        "/mnt/known-suffix".to_string(),
        server.url("/known-suffix.tar.gz"),
        "known-suffix",
        "v1",
        Some(1),
    ));
    storages.push(storage_entry_with_archive_size(
        "/mnt/unknown-suffix".to_string(),
        server.url("/unknown-suffix.tar.gz"),
        "unknown-suffix",
        "v1",
        None,
    ));
    storages.push(storage_entry_with_archive_size(
        "/mnt/conflicting-suffix-a".to_string(),
        server.url("/conflicting-suffix.tar.gz"),
        "conflicting-suffix",
        "v1",
        Some(1),
    ));
    storages.push(storage_entry_with_archive_size(
        "/mnt/conflicting-suffix-b".to_string(),
        server.url("/conflicting-suffix.tar.gz"),
        "conflicting-suffix",
        "v1",
        Some(2),
    ));
    let mut plan = plan_from_entries(storages, Vec::new(), None);
    let admission = FreshArchiveDeliveryAdmission::new();
    let held_permits = Arc::clone(&admission.permits)
        .try_acquire_many_owned(FRESH_DELIVERY_RUNNER_LIMIT as u32)
        .unwrap();
    let cancel = CancellationToken::new();

    let delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();

    assert!(delivery.apply.is_empty());
    get.assert_calls_async(0).await;
    drop(held_permits);
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX,
        true,
        "3_4",
        Some("1"),
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX_UNKNOWN,
        true,
        "2",
        None,
    );
}

#[tokio::test]
async fn fresh_delivery_enforces_per_run_and_runner_wide_admission() {
    fn plan_for(
        base_url: &str,
        prefix: &str,
        start: usize,
        count: usize,
        body_size: u64,
    ) -> StoragePlan {
        let storages = (start..start + count)
            .map(|index| {
                storage_entry_with_archive_size(
                    format!("/mnt/{prefix}-{index}"),
                    format!("{base_url}/{prefix}-{index}.tar.gz"),
                    &format!("{prefix}-{index}"),
                    "v1",
                    Some(body_size),
                )
            })
            .collect();
        plan_from_entries(storages, Vec::new(), None)
    }

    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let body = tarball_bytes();
    let body_size = body.len() as u64;
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let _get = server
        .mock_async(|when, then| {
            when.method(GET).header_missing("range");
            then.status(200)
                .delay(Duration::from_secs(5))
                .body(body.clone());
        })
        .await;
    let mut first_plan = plan_for(&server.base_url(), "first", 0, 5, body_size);
    let mut second_plan = plan_for(&server.base_url(), "second", 5, 4, body_size);
    let mut third_plan = plan_for(&server.base_url(), "third", 9, 1, body_size);

    let mut first = prepare_fresh_archive_delivery(
        &mut first_plan,
        &home,
        &admission,
        &cancel,
        &mut telemetry,
        None,
    )
    .await
    .unwrap();
    let mut second = prepare_fresh_archive_delivery(
        &mut second_plan,
        &home,
        &admission,
        &cancel,
        &mut telemetry,
        None,
    )
    .await
    .unwrap();
    let mut third = prepare_fresh_archive_delivery(
        &mut third_plan,
        &home,
        &admission,
        &cancel,
        &mut telemetry,
        None,
    )
    .await
    .unwrap();

    assert_eq!(first.apply.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
    assert_eq!(second.apply.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
    assert!(third.apply.is_empty());
    assert_eq!(admission.permits.available_permits(), 0);
    let ops = telemetry.pending_ops_snapshot();
    assert!(ops.iter().any(|(action, _, error)| {
        action == STORAGE_CACHE_FRESH_DELIVERY_CAPACITY && error.as_deref() == Some("per-run")
    }));
    assert!(ops.iter().any(|(action, _, error)| {
        action == STORAGE_CACHE_FRESH_DELIVERY_CAPACITY && error.as_deref() == Some("runner-wide")
    }));
    let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        true,
        "5_8",
        Some("prepared"),
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
        true,
        "1",
        Some("prepared"),
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "per_run",
        None,
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "runner_wide",
        None,
    );
    assert_bounded_outcome(
        &outcome_ops,
        STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
        true,
        "none",
        None,
    );
    first.cancel_and_drain(&mut telemetry).await;
    second.cancel_and_drain(&mut telemetry).await;
    third.cancel_and_drain(&mut telemetry).await;
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn hit_path_reads_from_disk_and_rewrites_url() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    // Pre-populate the cache to simulate a hit.
    let name = "seed-skill-foo";
    let version = "v1";
    let cache_dir = home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

    // Give populate_cache an R2-looking URL — it should never be called.
    let mut manifest = fresh_storage_plan(
        "https://r2.example.com/never-called.tar.gz".to_string(),
        name,
        version,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();
    assert!(records.is_empty());

    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
        "expected storage_cache_hit in {ops:?}"
    );
    assert_op(&ops, STORAGE_CACHE_PROCESS_GROUP, true);
    assert_op(&ops, STORAGE_CACHE_LOCK_WAIT, true);
    assert_op(&ops, STORAGE_CACHE_HIT_READ, true);
    assert_op_count(&ops, STORAGE_CACHE_PROCESS_GROUP, 1);
    assert_op_count(&ops, STORAGE_CACHE_LOCK_WAIT, 2);
    assert_op_count(&ops, STORAGE_CACHE_HIT_READ, 1);
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
}

#[tokio::test]
async fn production_warm_hit_returns_no_deferred_fill() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "production-warm-hit";
    let version = "v1";
    write_cached_archive(&home, name, version, &tarball_bytes());
    let mut manifest = fresh_storage_plan(
        "https://r2.example.com/never-called.tar.gz".into(),
        name,
        version,
    );

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_none());
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    assert_eq!(sandbox.write_files_calls().len(), 1);
    let ops = telemetry.pending_ops_snapshot();
    assert_no_op(&ops, "storage_cache_background_fill_deferred_count_1");
    assert_no_op(&ops, "storage_cache_background_fill_scheduled_count_1");
}

#[tokio::test]
async fn guarded_hit_path_reads_from_disk_and_rewrites_url() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let name = "guarded-hit";
    let version = "v1";
    write_cached_archive(&home, name, version, &tarball_bytes());
    write_storage_lock(&home, name, version);
    let mut manifest = fresh_storage_plan(
        "https://r2.example.com/never-called.tar.gz".into(),
        name,
        version,
    );

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_none());

    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, "storage_cache_hit", true);
    assert_op(&ops, "storage_cache_passthrough_hit_count_1", true);
    assert_op(&ops, "storage_cache_passthrough_miss_count_0", true);
}

#[tokio::test]
async fn guarded_archive_without_lock_recreates_lock_and_hits() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "guarded-missing-lock";
    let version = "v1";
    let original = "https://r2.example.com/recreate-lock.tar.gz".to_string();
    write_cached_archive(&home, name, version, &tarball_bytes());
    let lock_path = home.storage_lock(name, version);
    assert!(!lock_path.exists());
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_none());

    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    assert!(lock_path.exists());
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, "storage_cache_hit", true);
    assert_no_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH);
}

#[tokio::test]
async fn guarded_miss_passthrough_keeps_url_without_http_or_cache_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (hit_tx, mut hit_rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let _ = hit_tx.send(());
            let _ = socket
                .write_all(&http_response("500 Internal Server Error", b""))
                .await;
        }
    });
    let name = "guarded-miss";
    let version = "v1";
    let original = format!("http://{addr}/archive.tar.gz");
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_some());

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        hit_rx.try_recv().is_err(),
        "guarded miss should not contact the archive URL"
    );
    server_task.abort();
    let _ = server_task.await;
    assert!(!home.storage_cache_dir(name, version).exists());
    assert!(!home.storage_lock(name, version).exists());
    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.write_files_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
    assert_op(&ops, "storage_cache_passthrough_miss_count_1", true);
    assert_op(&ops, "storage_cache_passthrough_hit_count_0", true);
    assert_no_op(&ops, "storage_cache_skipped_head_failed");
}

#[tokio::test]
async fn miss_passthrough_defers_cache_fill_until_started() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let body = tarball_bytes();
    let expected_body = body.clone();
    let (allow_tx, allow_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: allow_rx,
            response: partial_content_response(body.len()),
        },
        RawHttpAction::Respond(http_response("200 OK", &body)),
    ])
    .await;
    let original = format!("{}/archive.tar.gz", server.url());
    let name = "background-miss";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap()
        .expect("cold miss should return deferred cache fill");

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(matches!(
        server.try_next_request(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.write_files_calls().is_empty());

    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
    assert_op(&ops, "storage_cache_background_fill_deferred_count_1", true);
    assert_no_op(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_no_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY);

    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    deferred.start(&coordinator, &mut telemetry);
    server
        .next_request("started background fill archive request")
        .await;
    allow_tx.send(()).unwrap();
    server.assert_finished().await;
    assert_eq!(
        wait_cached_archive(&home, name, version).await,
        expected_body
    );

    let ops = telemetry.pending_ops_snapshot();
    assert_op(
        &ops,
        "storage_cache_background_fill_scheduled_count_1",
        true,
    );
    assert_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY, true);
    coordinator.shutdown().await;
}

#[tokio::test]
async fn dropped_deferred_fill_starts_no_http_or_cache_work() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (request_tx, mut request_rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let _ = request_tx.send(());
            let _ = socket
                .write_all(&http_response("500 Internal Server Error", b""))
                .await;
        }
    });
    let name = "dropped-background-miss";
    let version = "v1";
    let original = format!("http://{addr}/archive.tar.gz");
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap()
        .expect("cold miss should return deferred cache fill");
    drop(deferred);
    tokio::task::yield_now().await;

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(matches!(
        request_rx.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert!(!home.storage_cache_dir(name, version).exists());
    assert!(!home.storage_lock(name, version).exists());
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, "storage_cache_background_fill_deferred_count_1", true);
    assert_no_op(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_no_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY);

    server_task.abort();
    let _ = server_task.await;
}

#[tokio::test]
async fn background_fill_reports_filled_outcome_batch() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let (archive_url, archive_server) = raw_http_sequence_url(vec![
        partial_content_response(body.len()),
        http_response("200 OK", &body),
    ])
    .await;
    let telemetry_server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let telemetry_api_url = telemetry_server.url();
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry_for_api_url(&telemetry_api_url);
    let name = "background-report";
    let version = "v1";
    let mut plan = fresh_storage_plan(archive_url, name, version);
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();

    select_background_fill(&mut plan, &sandbox, &home, &mut telemetry)
        .await
        .start(&coordinator, &mut telemetry);

    await_raw_http_sequence(archive_server).await;
    assert_eq!(wait_cached_archive(&home, name, version).await, body);
    let requests = telemetry_server.assert_finished_with_requests().await;
    let request = &requests[0];
    assert!(request.contains(r#""action_type":"storage_cache_background_fill_filled""#));
    assert!(request.contains(r#""action_type":"storage_cache_background_fill_size_lt_64_kib""#));
    assert!(!request.contains(name));
    assert!(!request.contains(version));
    assert!(!request.contains("archive.tar.gz"));
    coordinator.shutdown().await;
}

#[tokio::test]
async fn bounded_maintenance_progresses_past_decoded_and_already_retired_hits() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("maintenance-progress");
    let cache = decoded::DecodedCache::new(home.clone());
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET);
            then.status(500);
        })
        .await;
    let entries = (0..3)
        .map(|index| {
            let name = format!("maintenance-progress-{index}");
            write_cached_archive(&home, &name, "v1", &tarball_bytes());
            write_storage_lock(&home, &name, "v1");
            storage_entry(
                format!("/mnt/progress-{index}"),
                server.url("/unused"),
                &name,
                "v1",
            )
        })
        .collect::<Vec<_>>();
    cache
        .warm_from_archive("maintenance-progress-0", "v1")
        .await
        .unwrap();
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
    // Two fill operations and three retirements must progress through one
    // queue slot. Already decoded/retired prefixes cannot starve later keys.
    for _ in 0..5 {
        let mut plan = plan_from_entries(entries.clone(), Vec::new(), None);
        let mut telemetry = new_telemetry();
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            None,
            Some(&cache),
        )
        .await
        .unwrap();
        drop(plan);
        let Some(deferred) = deferred else {
            break;
        };
        deferred.start(&coordinator, &mut telemetry);
        coordinator.wait_idle_for_test().await;
    }
    coordinator.shutdown().await;
    for index in 0..3 {
        let name = format!("maintenance-progress-{index}");
        assert!(cache.get_ready(&name, "v1").await.unwrap().is_some());
        assert!(
            !home
                .storage_cache_dir(&name, "v1")
                .join("archive.tar.gz")
                .exists()
        );
    }
    get.assert_calls_async(0).await;
    cache.shutdown().await;
}

#[tokio::test]
async fn queued_archive_demand_takes_precedence_over_retirement_in_either_order() {
    for retirement_first in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let bytes = tarball_bytes();
        write_cached_archive(&home, "queued", "v1", &bytes);
        write_storage_lock(&home, "queued", "v1");
        let cache = decoded::DecodedCache::new(home.clone());
        cache.warm_from_archive("queued", "v1").await.unwrap();
        let mut server = gated_archive_server(bytes.clone(), 1).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
        let reporter = new_telemetry().reporter();
        assert_eq!(
            coordinator.submit(
                background_fill_group(server.url.clone(), "active", "v1", Some(bytes.len() as u64)),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None),
            ),
            BackgroundFillAdmission::Accepted
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let group =
            background_fill_group(server.url.clone(), "queued", "v1", Some(bytes.len() as u64));
        let mut actions = [
            BackgroundFillAction::Fill(None),
            BackgroundFillAction::RetireArchive(cache.clone()),
        ];
        if retirement_first {
            actions.reverse();
        }
        for (index, action) in actions.into_iter().enumerate() {
            assert_eq!(
                coordinator.submit(group.clone(), home.clone(), reporter.clone(), action),
                if index == 0 {
                    BackgroundFillAdmission::Accepted
                } else {
                    BackgroundFillAdmission::Deduplicated
                }
            );
        }
        server.release.add_permits(1);
        coordinator.wait_idle_for_test().await;
        coordinator.shutdown().await;
        cache.shutdown().await;
        server.task.await.unwrap().unwrap();
        assert_eq!(
            std::fs::read(
                home.storage_cache_dir("queued", "v1")
                    .join("archive.tar.gz")
            )
            .unwrap(),
            bytes
        );
    }
}

#[tokio::test]
async fn background_fill_reserves_admission_for_a_miss_after_other_runs_maintenance() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let bytes = tarball_bytes();
    let cache = decoded::DecodedCache::new(home.clone());
    let mut server = gated_archive_server(bytes.clone(), 5).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    let other_run = coordinator.clone();
    let reporter = new_telemetry().reporter();

    for index in 0..4 {
        assert_eq!(
            coordinator.submit(
                background_fill_group(
                    server.url.clone(),
                    &format!("reservation-active-{index}"),
                    "v1",
                    Some(bytes.len() as u64),
                ),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None),
            ),
            BackgroundFillAdmission::Accepted
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
    }
    let mut admitted_maintenance = Vec::new();
    for index in 0..32 {
        let name = format!("reservation-maintenance-{index}");
        write_cached_archive(&home, &name, "v1", &bytes);
        write_storage_lock(&home, &name, "v1");
        cache.warm_from_archive(&name, "v1").await.unwrap();
        if coordinator.submit(
            background_fill_group(server.url.clone(), &name, "v1", Some(bytes.len() as u64)),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::RetireArchive(cache.clone()),
        ) == BackgroundFillAdmission::Accepted
        {
            admitted_maintenance.push(name);
        }
    }
    let missing_admission = other_run.submit(
        background_fill_group(
            server.url.clone(),
            "reservation-missing",
            "v1",
            Some(bytes.len() as u64),
        ),
        home.clone(),
        reporter,
        BackgroundFillAction::Fill(None),
    );
    server.release.add_permits(5);
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("accepted background operations should finish after release");
    coordinator.shutdown().await;
    cache.shutdown().await;
    if missing_admission == BackgroundFillAdmission::Accepted {
        join_raw_http_task(server.task, "released background archive requests")
            .await
            .unwrap();
    } else {
        server.task.abort();
        let _ = server.task.await;
    }

    assert_eq!(missing_admission, BackgroundFillAdmission::Accepted);
    assert_eq!(
        std::fs::read(
            home.storage_cache_dir("reservation-missing", "v1")
                .join("archive.tar.gz")
        )
        .unwrap(),
        bytes
    );
    assert_eq!(admitted_maintenance.len(), 28);
    let mut retired = 0;
    for name in admitted_maintenance {
        let path = home.storage_cache_dir(&name, "v1").join("archive.tar.gz");
        if path.exists() {
            // The decoded worker/lock budget can legitimately report busy.
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        } else {
            retired += 1;
        }
    }
    assert!(retired > 0, "maintenance must also make useful progress");
    assert!(server.max_active.load(Ordering::SeqCst) <= 4);
}

#[tokio::test]
async fn background_fill_concurrent_runs_share_class_and_total_bounds() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let bytes = tarball_bytes();
    let cache = decoded::DecodedCache::new(home.clone());
    let mut server = gated_archive_server(bytes.clone(), 36).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    let reporter = new_telemetry().reporter();
    for index in 0..4 {
        assert_eq!(
            coordinator.submit(
                background_fill_group(
                    server.url.clone(),
                    &format!("active-{index}"),
                    "v1",
                    Some(bytes.len() as u64)
                ),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Accepted
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
    }
    // OS threads race the synchronous admission boundary used by distinct
    // executor runs, while all active network operations remain gated.
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let mut submitters = Vec::new();
    for missing in [false, true] {
        let coordinator = coordinator.clone();
        let home = home.clone();
        let reporter = reporter.clone();
        let cache = cache.clone();
        let barrier = Arc::clone(&barrier);
        let url = server.url.clone();
        let size = bytes.len() as u64;
        submitters.push(std::thread::spawn(move || {
            barrier.wait();
            let mut accepted = Vec::new();
            for index in 0..40 {
                let name = format!("concurrent-{missing}-{index}");
                let action = if missing {
                    BackgroundFillAction::Fill(None)
                } else {
                    BackgroundFillAction::WarmDecoded(cache.clone())
                };
                if coordinator.submit(
                    background_fill_group(url.clone(), &name, "v1", Some(size)),
                    home.clone(),
                    reporter.clone(),
                    action,
                ) == BackgroundFillAdmission::Accepted
                {
                    accepted.push(name);
                }
            }
            accepted
        }));
    }
    let accepted = submitters
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    server.release.add_permits(36);
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("accepted background operations should finish after release");
    coordinator.shutdown().await;
    join_raw_http_task(server.task, "released background archive requests")
        .await
        .unwrap();
    assert_eq!(accepted.iter().map(Vec::len).sum::<usize>(), 32);
    for class in accepted {
        assert!((4..=28).contains(&class.len()));
        for name in class {
            assert_eq!(
                std::fs::read(home.storage_cache_dir(&name, "v1").join("archive.tar.gz")).unwrap(),
                bytes
            );
        }
    }
    assert!(server.max_active.load(Ordering::SeqCst) <= 4);
    cache.shutdown().await;
}

#[tokio::test]
async fn background_fill_worker_failure_releases_capacity_for_missing_work() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let bytes = tarball_bytes();
    let cache = decoded::DecodedCache::new(home.clone());
    write_cached_archive(&home, "failed-warm", "v1", &bytes);
    write_storage_lock(&home, "failed-warm", "v1");
    cache.shutdown().await;
    let (archive_url, archive_server) = raw_http_url(http_response("200 OK", &bytes)).await;
    let (telemetry_url, telemetry_server) = telemetry_capture_server(2).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
    let reporter = new_telemetry_for_api_url(&telemetry_url).reporter();
    assert_eq!(
        coordinator.submit(
            background_fill_group(
                archive_url.clone(),
                "failed-warm",
                "v1",
                Some(bytes.len() as u64)
            ),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::WarmDecoded(cache)
        ),
        BackgroundFillAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("accepted background operations should finish after release");
    assert_eq!(
        coordinator.submit(
            background_fill_group(archive_url, "after-failure", "v1", Some(bytes.len() as u64)),
            home.clone(),
            reporter,
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("accepted background operations should finish after release");
    coordinator.shutdown().await;
    archive_server.assert_finished().await;
    let reports = telemetry_server.assert_finished_with_requests().await;
    assert!(
        reports
            .iter()
            .any(|r| r.contains("storage_cache_background_fill_failed"))
    );
    assert!(
        reports
            .iter()
            .any(|r| r.contains("storage_cache_background_fill_filled"))
    );
    assert_eq!(
        std::fs::read(
            home.storage_cache_dir("after-failure", "v1")
                .join("archive.tar.gz")
        )
        .unwrap(),
        bytes
    );
}

#[tokio::test]
async fn background_fill_reserves_maintenance_and_bounds_mixed_admission() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let bytes = tarball_bytes();
    let cache = decoded::DecodedCache::new(home.clone());
    let mut server = gated_archive_server(bytes.clone(), 5).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
    let reporter = new_telemetry().reporter();
    let group = |name: &str| {
        background_fill_group(server.url.clone(), name, "v1", Some(bytes.len() as u64))
    };
    assert_eq!(
        coordinator.submit(
            group("active"),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
        .await
        .unwrap()
        .unwrap();
    for index in 0..3 {
        assert_eq!(
            coordinator.submit(
                group(&format!("missing-{index}")),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Accepted
        );
    }
    assert_eq!(
        coordinator.submit(
            group("excess-missing"),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::QueueSaturated
    );
    assert_eq!(
        coordinator.submit(
            group("maintenance"),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::WarmDecoded(cache.clone())
        ),
        BackgroundFillAdmission::Accepted
    );
    assert_eq!(
        coordinator.submit(
            group("excess-maintenance"),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::WarmDecoded(cache.clone())
        ),
        BackgroundFillAdmission::QueueSaturated
    );
    // Promotion at capacity retains the accepted owner and decoded work,
    // even though all four queued keys now have missing demand.
    assert_eq!(
        coordinator.submit(
            group("maintenance"),
            home.clone(),
            reporter,
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Deduplicated
    );
    server.release.add_permits(5);
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("accepted background operations should finish after release");
    coordinator.shutdown().await;
    join_raw_http_task(server.task, "released background archive requests")
        .await
        .unwrap();
    assert!(
        cache
            .get_ready("maintenance", "v1")
            .await
            .unwrap()
            .is_some()
    );
    for name in ["excess-missing", "excess-maintenance"] {
        assert!(
            !home
                .storage_cache_dir(name, "v1")
                .join("archive.tar.gz")
                .exists()
        );
    }
    for index in 0..3 {
        assert_eq!(
            std::fs::read(
                home.storage_cache_dir(&format!("missing-{index}"), "v1")
                    .join("archive.tar.gz")
            )
            .unwrap(),
            bytes
        );
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn background_fill_serves_warming_and_retirement_during_missing_demand() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let bytes = tarball_bytes();
    let cache = decoded::DecodedCache::new(home.clone());
    let mut server = gated_archive_server(bytes.clone(), 15).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 32).unwrap();
    let reporter = new_telemetry().reporter();
    let group = |name: &str| {
        background_fill_group(
            server.url.replace("archive.tar.gz", name),
            name,
            "v1",
            Some(bytes.len() as u64),
        )
    };
    assert_eq!(
        coordinator.submit(
            group("anchor"),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
        .await
        .unwrap()
        .unwrap();

    // Warming observations can become stale before execution. These two
    // missing sources must still download and publish decoded files.
    for name in ["warm-0", "retire", "warm-1"] {
        let action = if name == "retire" {
            write_cached_archive(&home, name, "v1", &bytes);
            write_storage_lock(&home, name, "v1");
            cache.warm_from_archive(name, "v1").await.unwrap();
            BackgroundFillAction::RetireArchive(cache.clone())
        } else {
            BackgroundFillAction::WarmDecoded(cache.clone())
        };
        assert_eq!(
            coordinator.submit(group(name), home.clone(), reporter.clone(), action),
            BackgroundFillAdmission::Accepted
        );
    }
    for index in 0..12 {
        assert_eq!(
            coordinator.submit(
                group(&format!("cold-{index}")),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Accepted
        );
    }
    for _ in 0..14 {
        server.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
    }
    server.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("accepted background operations should finish after release");
    coordinator.shutdown().await;
    join_raw_http_task(server.task, "released background archive requests")
        .await
        .unwrap();

    let paths = server.paths.lock().unwrap().clone();
    assert_eq!(&paths[..4], ["/anchor", "/cold-0", "/cold-1", "/warm-0"]);
    assert_eq!(
        paths[10], "/warm-1",
        "retirement also receives its FIFO maintenance turn"
    );
    assert!(
        !home
            .storage_cache_dir("retire", "v1")
            .join("archive.tar.gz")
            .exists()
    );
    for name in ["warm-0", "warm-1"] {
        assert!(cache.get_ready(name, "v1").await.unwrap().is_some());
    }
    for index in 0..12 {
        assert_eq!(
            std::fs::read(
                home.storage_cache_dir(&format!("cold-{index}"), "v1")
                    .join("archive.tar.gz")
            )
            .unwrap(),
            bytes
        );
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn background_fill_promotes_queued_warming_without_losing_decoded_demand() {
    for missing_first in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let bytes = tarball_bytes();
        let cache = decoded::DecodedCache::new(home.clone());
        let mut server = gated_archive_server(bytes.clone(), 3).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
        let reporter = new_telemetry().reporter();
        let group = |name: &str| {
            background_fill_group(
                server.url.replace("archive.tar.gz", name),
                name,
                "v1",
                Some(bytes.len() as u64),
            )
        };
        assert_eq!(
            coordinator.submit(
                group("anchor"),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Accepted
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator.submit(
                group("older-warming"),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::WarmDecoded(cache.clone())
            ),
            BackgroundFillAdmission::Accepted
        );
        let mut actions = [
            BackgroundFillAction::WarmDecoded(cache.clone()),
            BackgroundFillAction::Fill(None),
        ];
        if missing_first {
            actions.reverse();
        }
        for (index, action) in actions.into_iter().enumerate() {
            assert_eq!(
                coordinator.submit(group("promoted"), home.clone(), reporter.clone(), action),
                if index == 0 {
                    BackgroundFillAdmission::Accepted
                } else {
                    BackgroundFillAdmission::Deduplicated
                }
            );
        }
        assert_eq!(
            coordinator.submit(
                group("promoted"),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::RetireArchive(cache.clone())
            ),
            BackgroundFillAdmission::Deduplicated
        );
        server.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .unwrap()
            .unwrap();
        // Active duplicate demand cannot spawn another request or retire a
        // source while its accepted atomic operation is running.
        assert_eq!(
            coordinator.submit(
                group("promoted"),
                home.clone(),
                reporter,
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Deduplicated
        );
        server.release.add_permits(2);
        tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
            .await
            .expect("accepted background operations should finish after release");
        coordinator.shutdown().await;
        join_raw_http_task(server.task, "released background archive requests")
            .await
            .unwrap();
        assert_eq!(
            server.paths.lock().unwrap().as_slice(),
            ["/anchor", "/promoted", "/older-warming"]
        );
        assert!(cache.get_ready("promoted", "v1").await.unwrap().is_some());
        assert_eq!(
            std::fs::read(
                home.storage_cache_dir("promoted", "v1")
                    .join("archive.tar.gz")
            )
            .unwrap(),
            bytes
        );
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn background_fill_coordinator_bounds_distinct_keys_globally() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = b"background-fill-body".to_vec();
    let mut server = gated_archive_server(body.clone(), 3).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(2, 6).unwrap();
    let reporter = new_telemetry().reporter();

    for (name, version) in [("global-a", "v1"), ("global-b", "v1"), ("global-c", "v1")] {
        assert_eq!(
            coordinator.submit(
                background_fill_group(server.url.clone(), name, version, Some(body.len() as u64),),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None),
            ),
            BackgroundFillAdmission::Accepted
        );
    }

    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .expect("two admitted workers should reach the archive server")
            .expect("archive request channel should remain open");
    }
    // A supervisor checkpoint observes the third key's admission decision even if
    // an over-admitted worker has not reached its HTTP handler yet.
    let (complete, completed) = oneshot::channel();
    let (active_workers, pending_keys) = tokio::time::timeout(Duration::from_secs(5), async {
        coordinator
            .lifecycle
            .inner
            .commands
            .send(BackgroundFillCommand::Checkpoint(complete))
            .await
            .expect("supervisor command channel should remain open");
        completed
            .await
            .expect("supervisor should acknowledge the checkpoint")
    })
    .await
    .expect("supervisor should process all three starts while responses are held");

    server.release.add_permits(1);
    let third_request = tokio::time::timeout(Duration::from_secs(5), server.requests.recv()).await;
    server.release.add_permits(2);
    join_raw_http_task(server.task, "archive server after all workers are released")
        .await
        .expect("archive server should not fail");
    tokio::time::timeout(Duration::from_secs(5), coordinator.shutdown())
        .await
        .expect("coordinator should drain all admitted workers");

    // Assert only after draining, so a failing admission oracle also joins its work.
    assert_eq!(
        (active_workers, pending_keys),
        (2, 1),
        "the third key must remain queued while both active responses are held"
    );
    third_request
        .expect("the third worker should start after one slot is released")
        .expect("archive request channel should remain open");
    assert_eq!(server.max_active.load(Ordering::SeqCst), 2);
    for name in ["global-a", "global-b", "global-c"] {
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, "v1").join("archive.tar.gz")).unwrap(),
            body
        );
    }
}

#[tokio::test]
async fn background_fill_coordinator_deduplicates_same_key_and_reports_subscribers() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let (archive_url, archive_server) =
        raw_http_sequence_url(vec![http_response("200 OK", &body)]).await;
    let (telemetry_url, telemetry_server) = telemetry_capture_server(2).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
    let first_reporter = new_telemetry_for_api_url(&telemetry_url).reporter();
    let second_reporter = new_telemetry_for_api_url(&telemetry_url).reporter();
    let group = background_fill_group(archive_url, "deduplicated", "v1", Some(body.len() as u64));

    assert_eq!(
        coordinator.submit(
            group.clone(),
            home.clone(),
            first_reporter,
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Accepted
    );
    assert_eq!(
        coordinator.submit(
            group,
            home.clone(),
            second_reporter,
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Deduplicated
    );

    await_raw_http_sequence(archive_server).await;
    assert_eq!(wait_cached_archive(&home, "deduplicated", "v1").await, body);
    coordinator.shutdown().await;

    let reports = telemetry_server.assert_finished_with_requests().await;
    assert_eq!(reports.len(), 2);
    assert!(reports.iter().all(|request| {
        request.contains(r#""action_type":"storage_cache_background_fill_filled""#)
    }));
}

#[tokio::test]
async fn background_fill_coordinator_saturates_queue_without_starting_excess_work() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = b"queue-body".to_vec();
    let mut server = gated_archive_server(body.clone(), 3).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
    let first_reporter = new_telemetry().reporter();
    let first_group = background_fill_group(
        server.url.clone(),
        "queue-active",
        "v1",
        Some(body.len() as u64),
    );
    assert_eq!(
        coordinator.submit(
            first_group,
            home.clone(),
            first_reporter,
            BackgroundFillAction::Fill(None)
        ),
        BackgroundFillAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
        .await
        .expect("the active queue test worker should reach the archive server")
        .expect("archive request channel should remain open");

    let mut telemetry = new_telemetry();
    DeferredBackgroundFill {
        groups: vec![
            background_fill_group(
                server.url.clone(),
                "queue-waiting",
                "v1",
                Some(body.len() as u64),
            ),
            background_fill_group(
                server.url.clone(),
                "queue-rejected",
                "v1",
                Some(body.len() as u64),
            ),
        ]
        .into_iter()
        .map(|group| (group, BackgroundFillAction::Fill(None)))
        .collect(),
        home: home.clone(),
        selected_at: Instant::now(),
    }
    .start(&coordinator, &mut telemetry);

    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_QUEUE_SATURATED, true);
    assert_op(
        &ops,
        "storage_cache_background_fill_scheduled_count_1",
        true,
    );
    assert!(matches!(
        server.requests.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    server.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
        .await
        .expect("the admitted queued key should start after the active key completes")
        .expect("archive request channel should remain open");
    server.release.add_permits(1);
    assert_eq!(
        wait_cached_archive(&home, "queue-waiting", "v1").await,
        body
    );
    server.task.abort();
    let _ = server.task.await;
    assert!(!home.storage_cache_dir("queue-rejected", "v1").exists());
    coordinator.shutdown().await;
}

#[tokio::test]
async fn background_fill_coordinator_cancels_queued_work_during_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let mut server = gated_archive_server(body.clone(), 1).await;
    let (telemetry_url, telemetry_server) = telemetry_capture_server(2).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
    let reporter = new_telemetry_for_api_url(&telemetry_url).reporter();

    assert_eq!(
        coordinator.submit(
            background_fill_group(
                server.url.clone(),
                "shutdown-active",
                "v1",
                Some(body.len() as u64),
            ),
            home.clone(),
            reporter.clone(),
            BackgroundFillAction::Fill(None),
        ),
        BackgroundFillAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
        .await
        .expect("active shutdown worker should reach the archive server")
        .expect("archive request channel should remain open");
    assert_eq!(
        coordinator.submit(
            background_fill_group(
                server.url.clone(),
                "shutdown-queued",
                "v1",
                Some(body.len() as u64),
            ),
            home.clone(),
            reporter,
            BackgroundFillAction::Fill(None),
        ),
        BackgroundFillAdmission::Accepted
    );

    let first_coordinator = coordinator.clone();
    let mut first_shutdown = Box::pin(first_coordinator.shutdown());
    let first_pending = futures_util::poll!(first_shutdown.as_mut()).is_pending();
    let admission_closed = coordinator.is_closed_for_test();

    let concurrent_coordinator = coordinator.clone();
    let mut concurrent_shutdown = Box::pin(concurrent_coordinator.shutdown());
    let concurrent_pending = futures_util::poll!(concurrent_shutdown.as_mut()).is_pending();
    drop(first_shutdown);
    drop(concurrent_shutdown);

    let mut replacement_shutdown = Box::pin(coordinator.shutdown());
    let replacement_pending = futures_util::poll!(replacement_shutdown.as_mut()).is_pending();
    server.release.add_permits(1);
    // A prematurely completed future must not be polled again during cleanup.
    if replacement_pending {
        tokio::time::timeout(Duration::from_secs(5), replacement_shutdown)
            .await
            .expect("replacement shutdown should join the original accepted work");
    }
    join_raw_http_task(server.task, "active archive server during shutdown")
        .await
        .expect("archive server should not fail");
    assert_eq!(
        wait_cached_archive(&home, "shutdown-active", "v1").await,
        body
    );
    assert!(!home.storage_cache_dir("shutdown-queued", "v1").exists());

    let reports = telemetry_server.assert_finished_with_requests().await;
    assert!(reports.iter().any(|request| {
        request.contains(r#""action_type":"storage_cache_background_fill_filled""#)
    }));
    assert!(reports.iter().any(|request| {
        request.contains(r#""action_type":"storage_cache_background_fill_shutdown_cancelled""#)
    }));
    // Drain real publication and reports before asserting the held-state observations.
    assert!(
        admission_closed,
        "shutdown must close admissions before waiting"
    );
    assert_eq!(
        (first_pending, concurrent_pending, replacement_pending),
        (true, true, true),
        "every shutdown observer must wait for the original held archive work"
    );
}

#[test]
fn background_fill_report_uses_fixed_outcome_and_size_actions() {
    let filled = BackgroundFillReport::from_outcome(
        BackgroundFillOutcome::Filled { size: 70 * 1024 },
        Duration::from_millis(12),
    )
    .into_records();
    assert_eq!(filled.len(), 2);
    assert_background_op_count(&filled, STORAGE_CACHE_BACKGROUND_FILL_FILLED, 1);
    assert_eq!(filled[0].action_type, STORAGE_CACHE_BACKGROUND_FILL_FILLED);
    assert_eq!(filled[0].duration, Duration::from_millis(12));
    assert!(filled[0].success);
    assert_eq!(
        filled[1].action_type,
        "storage_cache_background_fill_size_64_256_kib"
    );

    let busy =
        BackgroundFillReport::from_outcome(BackgroundFillOutcome::Busy, Duration::from_millis(5))
            .into_records();
    assert_eq!(busy.len(), 1);
    assert_eq!(busy[0].action_type, STORAGE_CACHE_BACKGROUND_FILL_BUSY);

    let failed = BackgroundFillReport::from_outcome(
        BackgroundFillOutcome::Unavailable,
        Duration::from_millis(6),
    )
    .into_records();
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed[0].action_type,
        STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE
    );

    let failed = BackgroundFillReport::failed(Duration::from_millis(7)).into_records();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].action_type, STORAGE_CACHE_BACKGROUND_FILL_FAILED);
    assert!(!failed[0].success);
    assert_eq!(
        failed[0].error,
        Some(STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR)
    );
}

#[tokio::test]
async fn background_fill_skips_busy_cache_lock_without_http() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "background-busy";
    let version = "v1";
    let mut plan = fresh_storage_plan(
        "http://127.0.0.1:9/archive.tar.gz".to_string(),
        name,
        version,
    );
    let deferred = select_background_fill(&mut plan, &sandbox, &home, &mut telemetry).await;
    let _writer = lock::acquire(home.storage_lock(name, version))
        .await
        .unwrap();

    let records = deferred.run().await;

    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_BUSY, true);
    assert!(!home.storage_cache_dir(name, version).exists());
}

#[tokio::test]
async fn background_fill_observes_cache_written_after_selection() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "background-already-cached";
    let version = "v1";
    let mut plan = fresh_storage_plan(
        "http://127.0.0.1:9/archive.tar.gz".to_string(),
        name,
        version,
    );
    let deferred = select_background_fill(&mut plan, &sandbox, &home, &mut telemetry).await;
    let body = tarball_bytes();
    write_cached_archive(&home, name, version, &body);

    let records = deferred.run().await;

    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED, true);
    assert_background_op(
        &records,
        "storage_cache_background_fill_size_lt_64_kib",
        true,
    );
    let later = populate_cache(&mut plan, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();
    assert!(later.is_none());
    assert_eq!(
        storage_archive_url(&plan, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
}

#[tokio::test]
async fn background_fill_preserves_failed_outcome() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let mut plan = fresh_storage_plan(
        "http://127.0.0.1:9/archive.tar.gz".to_string(),
        "background-failed",
        "v1",
    );

    let records = select_background_fill(&mut plan, &sandbox, &home, &mut telemetry)
        .await
        .run()
        .await;

    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn guarded_missing_archive_with_existing_lock_removes_orphan_lock() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "guarded-orphan-lock";
    let version = "v1";
    let original = "https://r2.example.com/orphan-lock.tar.gz".to_string();
    write_storage_lock(&home, name, version);
    let lock_path = home.storage_lock(name, version);
    assert!(lock_path.exists());
    assert!(!home.storage_cache_dir(name, version).exists());
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_some());

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(!lock_path.exists());
    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.write_files_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
    assert_no_op(&ops, "storage_cache_hit");
}

#[tokio::test]
async fn guarded_missing_archive_keeps_lock_when_another_reader_holds_it() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "guarded-orphan-lock-shared";
    let version = "v1";
    let original = "https://r2.example.com/orphan-lock-shared.tar.gz".to_string();
    let lock_path = home.storage_lock(name, version);
    let _other_reader = lock::acquire_shared(lock_path.clone()).await.unwrap();
    assert!(lock_path.exists());
    assert!(!home.storage_cache_dir(name, version).exists());
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_some());

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        lock_path.exists(),
        "cleanup must not remove a lock while another reader still holds it"
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.write_files_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
    assert_no_op(&ops, "storage_cache_hit");
}

#[tokio::test]
async fn guarded_empty_and_oversized_cached_archives_passthrough_without_eviction() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let empty_name = "guarded-empty";
    let oversized_name = "guarded-oversized";
    let version = "v1";
    let empty_dir = home.storage_cache_dir(empty_name, version);
    std::fs::create_dir_all(&empty_dir).unwrap();
    std::fs::write(empty_dir.join("archive.tar.gz"), b"").unwrap();
    write_storage_lock(&home, empty_name, version);
    let oversized_dir = home.storage_cache_dir(oversized_name, version);
    std::fs::create_dir_all(&oversized_dir).unwrap();
    let oversized_file = std::fs::File::create(oversized_dir.join("archive.tar.gz")).unwrap();
    oversized_file.set_len(CACHE_MAX_SIZE + 1).unwrap();
    write_storage_lock(&home, oversized_name, version);
    let empty_url = "https://r2.example.com/empty.tar.gz".to_string();
    let oversized_url = "https://r2.example.com/oversized.tar.gz".to_string();
    let mut manifest = plan_from_entries(
        vec![
            storage_entry("/mnt/empty".into(), empty_url.clone(), empty_name, version),
            storage_entry(
                "/mnt/oversized".into(),
                oversized_url.clone(),
                oversized_name,
                version,
            ),
        ],
        Vec::new(),
        None,
    );

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_some());

    assert_eq!(storage_archive_url(&manifest, 0), Some(empty_url.as_str()));
    assert_eq!(
        storage_archive_url(&manifest, 1),
        Some(oversized_url.as_str())
    );
    assert!(empty_dir.join("archive.tar.gz").exists());
    assert!(oversized_dir.join("archive.tar.gz").exists());
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, "storage_cache_passthrough_miss_count_2", true);
    assert_op_count(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, 2);
    assert_no_op(&ops, "storage_cache_skipped_over_size");
}

#[tokio::test]
async fn guarded_same_key_duplicate_misses_preserve_each_original_url() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "guarded-duplicate";
    let version = "v1";
    let first_url = "https://r2.example.com/first.tar.gz".to_string();
    let second_url = "https://mirror.example.com/second.tar.gz".to_string();
    let mut manifest =
        fresh_duplicate_storage_plan(first_url.clone(), second_url.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_some());

    assert_eq!(storage_archive_url(&manifest, 0), Some(first_url.as_str()));
    assert_eq!(storage_archive_url(&manifest, 1), Some(second_url.as_str()));
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, "storage_cache_passthrough_miss_count_2", true);
    assert_op_count(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, 2);
}

#[tokio::test]
async fn guarded_artifact_miss_passthrough_keeps_url() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "guarded-artifact";
    let version = "v1";
    let original = "https://r2.example.com/artifact.tar.gz".to_string();
    let mut manifest = fresh_artifact_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_some());

    assert_eq!(artifact_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(!home.storage_cache_dir(name, version).exists());
    assert!(!home.storage_lock(name, version).exists());
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, true);
    assert_op(&ops, STORAGE_CACHE_ARTIFACT_MISS_PASSTHROUGH, true);
}

#[tokio::test]
async fn guarded_lock_busy_passthrough_does_not_wait_for_writer() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let name = "guarded-busy";
    let version = "v1";
    let original = "https://r2.example.com/busy.tar.gz".to_string();
    let _writer = lock::acquire(home.storage_lock(name, version))
        .await
        .unwrap();
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_none());

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH, true);
    assert_op(&ops, "storage_cache_passthrough_lock_busy_count_1", true);
    assert_no_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH);
}

#[tokio::test]
async fn guarded_artifact_lock_busy_passthrough_does_not_wait_for_writer() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("artifact-busy");
    let mut telemetry = new_telemetry();
    let name = "guarded-artifact-busy";
    let version = "v1";
    let original = "https://r2.example.com/artifact-busy.tar.gz".to_string();
    let _writer = lock::acquire(home.storage_lock(name, version))
        .await
        .unwrap();
    let mut manifest = fresh_artifact_plan(original.clone(), name, version);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_none());
    assert_eq!(artifact_archive_url(&manifest, 0), Some(original.as_str()));
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH, true);
    assert_op(&ops, STORAGE_CACHE_ARTIFACT_LOCK_BUSY_PASSTHROUGH, true);
    assert_no_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH);
}

#[tokio::test]
async fn warm_hits_are_staged_in_one_guest_batch() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let body = tarball_bytes();
    let first_name = "warm-batch-a";
    let second_name = "warm-batch-b";
    let version = "v1";
    write_cached_archive(&home, first_name, version, &body);
    write_cached_archive(&home, second_name, version, &body);

    let mut manifest = plan_from_entries(
        vec![
            storage_entry(
                "/mnt/a".into(),
                "https://r2.example.com/a.tar.gz".into(),
                first_name,
                version,
            ),
            storage_entry(
                "/mnt/b".into(),
                "https://r2.example.com/b.tar.gz".into(),
                second_name,
                version,
            ),
        ],
        Vec::new(),
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();
    assert!(records.is_empty());

    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 2);
    let staged_paths = batches[0]
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<HashSet<_>>();
    assert_eq!(
        staged_paths,
        HashSet::from([
            guest_archive_path(first_name, version),
            guest_archive_path(second_name, version),
        ])
    );
    assert_eq!(sandbox.write_file_calls().len(), 2);
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, true);
    assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, true);
    let ops_with_duration = telemetry.pending_ops_with_duration_snapshot();
    assert_eq!(
        op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_TOTAL),
        op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_BATCH_WRITE),
        "pure batch staging total should equal the batch guest write duration in {ops_with_duration:?}"
    );
}

#[tokio::test]
async fn warm_hit_batch_stage_failure_records_failed_staging_telemetry() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
    let mut telemetry = new_telemetry();

    let name = "warm-batch-fail";
    let version = "v1";
    let original = "https://r2.example.com/fail.tar.gz".to_string();
    write_cached_archive(&home, name, version, &tarball_bytes());
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let err = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap_err();

    assert!(err.to_string().contains("vsock write failed"), "got: {err}");
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));

    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
    assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
    assert_op_error(
        &ops,
        STORAGE_CACHE_STAGE_BATCH_WRITE,
        STORAGE_CACHE_STAGE_FAILED,
    );
    assert_op_error(&ops, STORAGE_CACHE_STAGE_TOTAL, STORAGE_CACHE_STAGE_FAILED);
    assert_no_op(&ops, "storage_cache_hit");
}

#[tokio::test]
async fn miss_path_downloads_and_populates_cache() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/archive.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/archive.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let original = server.url("/archive.tar.gz");
    let name = "seed-skill-bar";
    let version = "v2";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let deferred = select_background_fill(&mut manifest, &sandbox, &home, &mut telemetry).await;

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(sandbox.write_files_calls().is_empty());
    assert!(!home.storage_cache_dir(name, version).exists());

    let records = deferred.run().await;

    probe.assert_async().await;
    get.assert_async().await;
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    assert_background_op(
        &records,
        "storage_cache_background_fill_size_lt_64_kib",
        true,
    );

    let final_path = home.storage_cache_dir(name, version).join("archive.tar.gz");
    assert!(final_path.exists(), "cache file must exist after miss");
    assert_eq!(std::fs::read(&final_path).unwrap(), body);

    let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert!(deferred.is_none());
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );

    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, true);
    assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, true);
    let ops_with_duration = telemetry.pending_ops_with_duration_snapshot();
    assert_eq!(
        op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_TOTAL),
        op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_BATCH_WRITE),
        "single-entry batch staging total should equal the guest write duration in {ops_with_duration:?}"
    );
    assert_op(&ops, STORAGE_CACHE_PROCESS_GROUP, true);
    assert_op(&ops, STORAGE_CACHE_LOCK_WAIT, true);
    assert_op_count(&ops, STORAGE_CACHE_PROCESS_GROUP, 2);
    assert_op_count(&ops, STORAGE_CACHE_LOCK_WAIT, 2);
    assert_op_count(&ops, STORAGE_CACHE_HIT_READ, 1);
}

#[tokio::test]
async fn cold_artifact_fill_warms_decoded_cache_for_the_next_plan() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("artifact-cold-fill");
    let cache = decoded::DecodedCache::new(home.clone());
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/artifact.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/artifact.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let source = server.url("/artifact.tar.gz");
    let name = "cold-artifact";
    let version = "v1";
    let mut first = fresh_artifact_plan(source.clone(), name, version);

    let deferred = populate_cache_with_fresh_delivery(
        &mut first,
        &sandbox,
        &home,
        &mut telemetry,
        None,
        Some(&cache),
    )
    .await
    .unwrap()
    .expect("cold artifact should schedule a background fill");
    let records = deferred.run().await;
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    probe.assert_calls_async(1).await;
    get.assert_calls_async(1).await;
    assert!(cache.get_ready(name, version).await.unwrap().is_some());

    let mut second = fresh_artifact_plan(source, name, version);
    let deferred = populate_cache_with_fresh_delivery(
        &mut second,
        &sandbox,
        &home,
        &mut telemetry,
        None,
        Some(&cache),
    )
    .await
    .unwrap();
    assert!(
        deferred.is_some(),
        "decoded use should schedule archive retirement"
    );
    let files = second.take_decoded();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "/mnt/artifact-cold-artifact");
    assert_eq!(files[0].1.files[0].content, b"storage cache test file\n");
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_ARTIFACT_DECODED,
        true,
    );
    cache.shutdown().await;
}

#[tokio::test]
async fn known_archive_size_downloads_without_range_probe() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/known-size.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/known-size.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let original = server.url("/known-size.tar.gz");
    let name = "known-size";
    let version = "v1";
    let mut manifest = plan_from_entries(
        vec![storage_entry_with_archive_size(
            format!("/mnt/{name}"),
            original,
            name,
            version,
            Some(body.len() as u64),
        )],
        Vec::new(),
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_calls_async(0).await;
    get.assert_async().await;
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
        body
    );
}

#[tokio::test]
async fn probe_http_error_preserves_original_url() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/forbidden.tar.gz")
                .header("range", "bytes=0-0");
            then.status(403);
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/forbidden.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let original = server.url("/forbidden.tar.gz");
    let name = "probe-client-error";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_calls_async(1).await;
    full.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn probe_invalid_url_is_sanitized() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let original = "not-a-url".to_string();
    let name = "probe-builder-error";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn full_download_http_error_is_sanitized() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/download-forbidden.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/download-forbidden.tar.gz")
                .header_missing("range");
            then.status(403);
        })
        .await;

    let original = format!(
        "{}?X-Amz-Signature=secret&X-Amz-Credential=credential",
        server.url("/download-forbidden.tar.gz")
    );
    let name = "download-client-error";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    full.assert_calls_async(1).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    let http = Client::builder().build().unwrap();
    let reason = download_tarball(&http, &original, Some(body.len() as u64), CACHE_MAX_SIZE)
        .await
        .err()
        .expect("403 download should fail")
        .to_string();
    full.assert_calls_async(2).await;
    assert!(reason.contains("403"), "expected 403 in reason: {reason}");
    assert!(
        !reason.contains("X-Amz-Signature")
            && !reason.contains("secret")
            && !reason.contains("credential")
            && !reason.contains("/download-forbidden.tar.gz"),
        "telemetry error must not include presigned URL details: {reason}"
    );
}

#[tokio::test]
async fn cold_fill_later_warm_batch_stage_failure_records_telemetry() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("batch write failed")));
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/archive.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/archive.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let original = server.url("/archive.tar.gz");
    let name = "later-warm-stage-fail";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let err = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap_err();

    probe.assert_async().await;
    get.assert_async().await;
    assert!(err.to_string().contains("batch write failed"), "got: {err}");
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
        body
    );

    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
    assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
    assert_op_error(
        &ops,
        STORAGE_CACHE_STAGE_BATCH_WRITE,
        STORAGE_CACHE_STAGE_FAILED,
    );
    assert_op_error(&ops, STORAGE_CACHE_STAGE_TOTAL, STORAGE_CACHE_STAGE_FAILED);
}

#[tokio::test]
async fn legacy_over_size_entry_probes_then_passthrough() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let too_big = CACHE_MAX_SIZE + 1;
    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/legacy-big.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{too_big}"))
                .body(b"x");
        })
        .await;
    let unexpected_full_get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/legacy-big.tar.gz")
                .header_missing("range");
            then.status(200);
        })
        .await;

    let original = server.url("/legacy-big.tar.gz");
    let name = "legacy-user-volume";
    let version = "v9";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    unexpected_full_get.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(!home.storage_cache_dir(name, version).exists());

    let ops = telemetry.pending_ops_snapshot();
    assert_no_op(&ops, STORAGE_CACHE_STAGE_TOTAL);
    assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_SKIPPED, true);
}

#[tokio::test]
async fn known_over_size_entry_is_passthrough_without_http() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let too_big = CACHE_MAX_SIZE + 1;
    let unexpected_get = server
        .mock_async(|when, then| {
            when.method(GET).path("/big.tar.gz");
            then.status(200);
        })
        .await;

    let original = server.url("/big.tar.gz");
    let name = "user-volume";
    let version = "v9";
    let mut manifest = plan_from_entries(
        vec![storage_entry_with_archive_size(
            format!("/mnt/{name}"),
            original.clone(),
            name,
            version,
            Some(too_big),
        )],
        Vec::new(),
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    unexpected_get.assert_calls_async(0).await;

    // archive_url untouched.
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    // Cache dir must not exist.
    assert!(!home.storage_cache_dir(name, version).exists());

    let ops = telemetry.pending_ops_snapshot();
    assert_no_op(&ops, STORAGE_CACHE_STAGE_TOTAL);
    assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_SKIPPED, true);
}

#[tokio::test]
async fn full_download_over_probe_limit_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("unexpected archive write")));
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/lying-body.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{CACHE_MAX_SIZE}"))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/lying-body.tar.gz")
                .header_missing("range");
            then.status(200)
                .body(vec![b'x'; (CACHE_MAX_SIZE + 1) as usize]);
        })
        .await;

    let original = server.url("/lying-body.tar.gz");
    let name = "lying-body";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    get.assert_async().await;
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FAILED, false);
    assert_eq!(
        records[0].error,
        Some(STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR)
    );
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert!(
        sandbox.write_file("/tmp/sentinel", b"x").await.is_err(),
        "queued write_file error should remain if archive write was not attempted"
    );
}

#[tokio::test]
async fn empty_full_download_is_passthrough_without_cache_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/empty-body.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", "bytes 0-0/1")
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/empty-body.tar.gz")
                .header_missing("range");
            then.status(200).body(Vec::<u8>::new());
        })
        .await;

    let original = server.url("/empty-body.tar.gz");
    let name = "empty-body";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    get.assert_async().await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn non_tar_full_download_is_cached_as_opaque_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = b"not a valid tar.gz".to_vec();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/invalid-body.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/invalid-body.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let original = server.url("/invalid-body.tar.gz");
    let name = "invalid-body";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    get.assert_async().await;
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
        body
    );
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, guest_archive_path(name, version));
    assert_eq!(writes[0].content, body);
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
}

#[tokio::test]
async fn known_size_mismatch_is_passthrough_without_cache_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();
    let expected_size = body.len() as u64 + 1;

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/short-body.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{expected_size}"))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/short-body.tar.gz")
                .header_missing("range");
            then.status(200).body(body);
        })
        .await;

    let original = server.url("/short-body.tar.gz");
    let name = "short-body";
    let version = "v1";
    let mut manifest = plan_from_entries(
        vec![storage_entry_with_archive_size(
            format!("/mnt/{name}"),
            original.clone(),
            name,
            version,
            Some(expected_size),
        )],
        Vec::new(),
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_calls_async(0).await;
    get.assert_async().await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn longer_full_download_within_limit_is_passthrough_without_cache_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/long-body.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", "bytes 0-0/1")
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/long-body.tar.gz")
                .header_missing("range");
            then.status(200).body(body);
        })
        .await;

    let original = server.url("/long-body.tar.gz");
    let name = "long-body";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    get.assert_async().await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn reused_storage_is_not_touched() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let previous = StorageFingerprints {
        storages: HashMap::from([("/mnt/foo".into(), StorageFingerprint::new("foo", "v1"))]),
        artifacts: HashMap::new(),
    };
    let mut manifest = plan_from_entries(
        vec![storage_entry(
            "/mnt/foo".into(),
            "https://r2.example.com/unused.tar.gz".into(),
            "foo",
            "v1",
        )],
        Vec::new(),
        Some(&previous),
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();
    assert!(records.is_empty());

    assert!(storage_archive_url(&manifest, 0).is_none());
    assert!(manifest.cache_candidates().is_empty());
    // No telemetry emitted — no eligible targets.
    assert!(telemetry.pending_ops_snapshot().is_empty());
}

#[tokio::test]
async fn missing_content_key_is_passthrough() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    // Entry without usable vas_storage_name / vas_version_id passes through.
    let mut manifest = fresh_storage_plan("https://r2.example.com/legacy.tar.gz".into(), "", "");

    populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    // archive_url untouched.
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some("https://r2.example.com/legacy.tar.gz")
    );
}

#[tokio::test]
async fn version_transition_cannot_serve_prev_bytes() {
    // Correctness claim: (name, v1) and (name, v2) live in different
    // directories. A warmed cache for v2 can never serve v1 bytes
    // regardless of reused sandbox state.
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let name = "rolling-skill";
    let v2_bytes = tarball_bytes();
    let v2_dir = home.storage_cache_dir(name, "v2");
    std::fs::create_dir_all(&v2_dir).unwrap();
    std::fs::write(v2_dir.join("archive.tar.gz"), &v2_bytes).unwrap();

    // If a stale v1 tarball exists, it's under a different cache key and
    // is unreachable via (name, v2).
    let v1_bytes = b"STALE-V1-BYTES";
    let v1_dir = home.storage_cache_dir(name, "v1");
    std::fs::create_dir_all(&v1_dir).unwrap();
    std::fs::write(v1_dir.join("archive.tar.gz"), v1_bytes).unwrap();

    let mut manifest =
        fresh_storage_plan("https://r2.example.com/ignored.tar.gz".into(), name, "v2");

    populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, "v2")).as_str())
    );
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, guest_archive_path(name, "v2"));
    assert_eq!(writes[0].content, v2_bytes);
    assert_ne!(writes[0].content, v1_bytes);

    // v2 cache retained; v1 cache untouched (only a GC branch would evict it).
    assert_eq!(
        std::fs::read(v2_dir.join("archive.tar.gz")).unwrap(),
        v2_bytes
    );
    assert_eq!(
        std::fs::read(v1_dir.join("archive.tar.gz")).unwrap(),
        v1_bytes
    );
}

#[tokio::test]
async fn oversized_disk_hit_is_evicted_and_revalidated() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let name = "oversized-hit";
    let version = "v1";
    let cache_dir = home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&cache_dir).unwrap();
    let archive = std::fs::File::create(cache_dir.join("archive.tar.gz")).unwrap();
    archive.set_len(CACHE_MAX_SIZE + 1).unwrap();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/revalidated.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/revalidated.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let url = server.url("/revalidated.tar.gz");
    let mut manifest = fresh_storage_plan(url, name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    get.assert_async().await;
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
        body
    );
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "over-size");
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
}

#[tokio::test]
async fn empty_disk_hit_is_evicted_and_revalidated() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let name = "empty-hit";
    let version = "v1";
    let cache_dir = home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join("archive.tar.gz"), b"").unwrap();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/empty-revalidated.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/empty-revalidated.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let url = server.url("/empty-revalidated.tar.gz");
    let mut manifest = fresh_storage_plan(url, name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    get.assert_async().await;
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
        body
    );
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "empty");
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
}

#[tokio::test]
async fn non_tar_disk_hit_is_staged_without_revalidation() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = b"not a valid tar.gz".to_vec();

    let name = "non-tar-hit";
    let version = "v1";
    let cache_dir = home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join("archive.tar.gz"), &body).unwrap();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/should-not-revalidate.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/should-not-revalidate.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let url = server.url("/should-not-revalidate.tar.gz");
    let mut manifest = fresh_storage_plan(url, name, version);

    populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_calls_async(0).await;
    get.assert_calls_async(0).await;
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
        body
    );
    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
    assert_eq!(batches[0].files[0].content, body);
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
        "expected cache hit in {ops:?}"
    );
}

#[tokio::test]
async fn artifacts_are_cached_too() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let name = "build-artifact";
    let version = "build-42";
    let cache_dir = home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

    let mut manifest = fresh_artifact_plan(
        "https://r2.example.com/ignored.tar.gz".into(),
        name,
        version,
    );

    populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    assert_eq!(
        artifact_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_ARTIFACT_ARCHIVE_HIT,
        true,
    );
}

#[tokio::test]
async fn probe_200_ignored_range_uses_content_length_without_reading_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let advertised_size = CACHE_MAX_SIZE + 1;

    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let mut request = [0u8; 1024];
        let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
        socket
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {advertised_size}\r\n\r\n").as_bytes(),
            )
            .await?;
        let _ = release_rx.await;
        Ok::<(), std::io::Error>(())
    });

    let http = Client::builder().build().unwrap();
    let result = tokio::time::timeout(
        HEAD_TIMEOUT + Duration::from_secs(1),
        probe_size(&http, &format!("http://{addr}/range-ignored.tar.gz")),
    )
    .await
    .expect("probe must return after headers without waiting for the body")
    .unwrap();

    let _ = release_tx.send(());
    join_raw_http_task(server_task, "ignored range probe server")
        .await
        .unwrap();
    assert_eq!(result, SizeProbe::Known(advertised_size));
}

#[tokio::test]
async fn probe_200_rejects_malformed_content_length() {
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: +7\r\n\r\n".to_vec();
    let (url, handle) = raw_http_url(response).await;

    let http = Client::builder().build().unwrap();
    let result = probe_size(&http, &url).await;

    handle.assert_finished().await;
    match result {
        Ok(SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader)) => {}
        Err(err) => assert!(err.to_string().contains("probe GET"), "got: {err}"),
        other => panic!("malformed Content-Length must not become a known size: {other:?}"),
    }
}

#[tokio::test]
async fn probe_200_malformed_content_length_is_passthrough() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: +7\r\n\r\n".to_vec();
    let (original, handle) = raw_http_url(response).await;
    let name = "malformed-length";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    handle.assert_finished().await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn probe_200_zero_content_length_is_passthrough() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/zero-length.tar.gz")
                .header("range", "bytes=0-0");
            then.status(200).header("content-length", "0");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/zero-length.tar.gz")
                .header_missing("range");
            then.status(200).body(tarball_bytes());
        })
        .await;

    let original = server.url("/zero-length.tar.gz");
    let name = "zero-length";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    full.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn probe_non_ok_success_status_is_passthrough() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/no-content.tar.gz")
                .header("range", "bytes=0-0");
            then.status(204).header("content-length", "0");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/no-content.tar.gz")
                .header_missing("range");
            then.status(200).body(tarball_bytes());
        })
        .await;

    let original = server.url("/no-content.tar.gz");
    let name = "no-content";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    full.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn probe_206_uses_content_range_without_reading_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let total_size = CACHE_MAX_SIZE;

    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let mut request = [0u8; 1024];
        let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
        socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{total_size}\r\nContent-Length: {}\r\n\r\n",
                        CACHE_MAX_SIZE + 1
                    )
                    .as_bytes(),
                )
                .await?;
        let _ = release_rx.await;
        Ok::<(), std::io::Error>(())
    });

    let http = Client::builder().build().unwrap();
    let result = tokio::time::timeout(
        HEAD_TIMEOUT + Duration::from_secs(1),
        probe_size(&http, &format!("http://{addr}/partial.tar.gz")),
    )
    .await
    .expect("probe must return after Content-Range without waiting for the body")
    .unwrap();

    let _ = release_tx.send(());
    join_raw_http_task(server_task, "partial content probe server")
        .await
        .unwrap();
    assert_eq!(result, SizeProbe::Known(total_size));
}

#[test]
fn staging_dir_is_sibling() {
    let d = PathBuf::from("/var/lib/vm0-runner/storages/foo/v1");
    let s = staging_dir(&d);
    assert_eq!(s, PathBuf::from("/var/lib/vm0-runner/storages/foo/v1.tmp"));
    // Same parent → atomic rename.
    assert_eq!(s.parent(), d.parent());
}

#[tokio::test]
async fn write_to_cache_rename_error_cleans_staging() {
    let temp = tempfile::tempdir().unwrap();
    let cache_dir = temp.path().join("storages").join("name").join("version");
    let parent = cache_dir.parent().unwrap();
    fs::create_dir_all(parent).await.unwrap();
    fs::write(&cache_dir, b"not-a-cache-dir").await.unwrap();

    let staging = staging_dir(&cache_dir);

    let err = write_to_cache(&cache_dir, b"archive bytes")
        .await
        .unwrap_err();

    assert!(err.to_string().contains("rename"), "got: {err}");
    assert!(
        !staging.exists(),
        "failed cache write must not leave staging dir"
    );
    assert_eq!(fs::read(&cache_dir).await.unwrap(), b"not-a-cache-dir");
}

#[test]
fn initial_body_capacity_uses_bounded_hints() {
    assert_eq!(initial_body_capacity(Some(5), Some(6), 10), 5);
    assert_eq!(initial_body_capacity(Some(11), Some(6), 10), 6);
    assert_eq!(initial_body_capacity(Some(11), Some(12), 10), 10);
    assert_eq!(
        initial_body_capacity(None, None, 128 * 1024),
        BODY_BUFFER_FALLBACK_CAPACITY
    );
}

#[test]
fn limited_body_allows_exact_limit() {
    let mut body = BoundedArchiveBody::new(0, 6);

    let first = body.append(b"abcd").unwrap();
    let second = body.append(b"ef").unwrap();

    assert_eq!(first, None);
    assert_eq!(second, None);
    assert_eq!(body.len().unwrap(), 6);
    assert_eq!(body.into_bytes().as_ref(), b"abcdef");
}

#[test]
fn limited_body_rejects_one_byte_over_limit() {
    let mut body = BoundedArchiveBody::new(0, 6);

    let first = body.append(b"abcd").unwrap();
    let second = body.append(b"efg").unwrap();

    assert_eq!(first, None);
    assert_eq!(second, Some(7));
    assert_eq!(
        body.len().unwrap(),
        4,
        "over-limit chunk must not advance accepted size"
    );
    assert_eq!(
        body.into_bytes().as_ref(),
        b"abcd",
        "over-limit chunk must not be appended"
    );
}

#[tokio::test]
async fn download_rejects_advertised_content_length_over_limit() {
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/too-long.tar.gz");
            then.status(200).body(vec![0u8; 7]);
        })
        .await;
    let http = Client::builder().build().unwrap();

    let result = download_tarball(&http, &server.url("/too-long.tar.gz"), Some(6), 6)
        .await
        .unwrap();

    get.assert_async().await;
    match result {
        DownloadBody::Complete(bytes) => {
            panic!(
                "content-length over limit should be rejected, read {} bytes",
                bytes.len()
            )
        }
        DownloadBody::Empty => panic!("content-length over limit must not be empty"),
        DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
    }
}

#[tokio::test]
async fn download_accepts_stream_without_content_length_at_exact_limit() {
    let (url, server_task) = raw_http_url(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n2\r\nef\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
    let http = Client::builder().build().unwrap();

    let result = download_tarball(&http, &url, Some(1), 6).await.unwrap();
    server_task.assert_finished().await;

    match result {
        DownloadBody::Complete(bytes) => assert_eq!(bytes.as_ref(), b"abcdef"),
        DownloadBody::Empty => panic!("exact-limit stream must not be empty"),
        DownloadBody::OverSize { observed_size } => {
            panic!("exact-limit stream rejected at {observed_size} bytes")
        }
    }
}

#[tokio::test]
async fn download_rejects_stream_without_content_length_over_limit() {
    let (url, server_task) = raw_http_url(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n3\r\nefg\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
    let http = Client::builder().build().unwrap();

    let result = download_tarball(&http, &url, Some(6), 6).await.unwrap();
    server_task.assert_finished().await;

    match result {
        DownloadBody::Complete(bytes) => {
            panic!(
                "stream over limit should be rejected, read {} bytes",
                bytes.len()
            )
        }
        DownloadBody::Empty => panic!("stream over limit must not be empty"),
        DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
    }
}

#[tokio::test]
async fn cached_archive_read_rejects_one_byte_over_limit() {
    let temp = tempfile::tempdir().unwrap();
    let archive_path = temp.path().join("archive.tar.gz");
    fs::write(&archive_path, b"abcdefg").await.unwrap();

    let result = read_cached_archive(&archive_path, Some(7), 6)
        .await
        .unwrap();

    match result {
        DownloadBody::Complete(bytes) => {
            panic!(
                "cached file over limit should be rejected, read {} bytes",
                bytes.len()
            )
        }
        DownloadBody::Empty => panic!("cached file over limit must not be empty"),
        DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
    }
}

#[tokio::test]
async fn cached_archive_read_preserves_contents_with_stale_size_hints() {
    let temp = tempfile::tempdir().unwrap();
    let archive_path = temp.path().join("archive.tar.gz");
    for length in [0, 1, 4097, 131_073] {
        let content = (0..length).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        fs::write(&archive_path, &content).await.unwrap();
        for hint in [None, Some(0), Some(1), Some(length as u64)] {
            let result = read_cached_archive(&archive_path, hint, length as u64)
                .await
                .unwrap();
            match result {
                DownloadBody::Empty => assert!(content.is_empty()),
                DownloadBody::Complete(bytes) => assert_eq!(bytes.as_ref(), content),
                DownloadBody::OverSize { observed_size } => {
                    panic!("valid cached file rejected at {observed_size} bytes")
                }
            }
        }
        if length > 1 {
            let result = read_cached_archive(&archive_path, Some(1), length as u64 - 1)
                .await
                .unwrap();
            assert!(matches!(result, DownloadBody::OverSize { observed_size }
                    if observed_size == length as u64));
        }
    }
}

#[tokio::test]
async fn warmed_cache_hits_do_not_serialize_guest_writes_across_sandboxes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let name = "warm-shared";
    let version = "v1";
    write_cached_archive(&home, name, version, &tarball_bytes());

    let sandbox_a = Arc::new(MockSandbox::new("test-a"));
    let sandbox_b = Arc::new(MockSandbox::new("test-b"));
    let gate_a = MockLifecycleGate::new();
    let gate_b = MockLifecycleGate::new();
    sandbox_a.set_write_file_lifecycle_gate(gate_a.clone());
    sandbox_b.set_write_file_lifecycle_gate(gate_b.clone());

    let task_a = {
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox_a);
        tokio::spawn(async move {
            let mut manifest = fresh_storage_plan(
                "https://r2.example.com/ignored-a.tar.gz".to_string(),
                name,
                version,
            );
            let mut telemetry = new_telemetry();
            populate_cache_through_background(
                &mut manifest,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
            )
            .await
            .unwrap();
            manifest
        })
    };
    gate_a
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(
        !task_a.is_finished(),
        "first guest write should wait on its sandbox gate"
    );

    let task_b = {
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox_b);
        tokio::spawn(async move {
            let mut manifest = fresh_storage_plan(
                "https://r2.example.com/ignored-b.tar.gz".to_string(),
                name,
                version,
            );
            let mut telemetry = new_telemetry();
            populate_cache_through_background(
                &mut manifest,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
            )
            .await
            .unwrap();
            manifest
        })
    };
    gate_b
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();

    gate_b.release_one();
    let manifest_b = task_b.await.unwrap();
    gate_a.release_one();
    let manifest_a = task_a.await.unwrap();

    let expected = format!("file://{}", guest_archive_path(name, version));
    assert_eq!(storage_archive_url(&manifest_a, 0), Some(expected.as_str()));
    assert_eq!(storage_archive_url(&manifest_b, 0), Some(expected.as_str()));
}

#[tokio::test]
async fn multi_group_background_fill_precedes_later_warm_staging() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = Arc::new(MockSandbox::new("test"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());

    let ready_name = "ready-stages-while-cold-in-flight";
    let cold_name = "cold-continues-while-stage-blocked";
    let version = "v1";

    let ready_body = tarball_bytes();
    let cold_body = tarball_bytes();
    let ready_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ready_addr = ready_listener.local_addr().unwrap();
    let cold_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cold_addr = cold_listener.local_addr().unwrap();
    let (allow_ready_tx, allow_ready_rx) = tokio::sync::oneshot::channel::<()>();
    let (cold_probe_seen_tx, cold_probe_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_cold_probe_tx, release_cold_probe_rx) = tokio::sync::oneshot::channel::<()>();
    let (cold_full_seen_tx, cold_full_seen_rx) = tokio::sync::oneshot::channel::<()>();

    let ready_server_task = tokio::spawn(async move {
        let (mut probe_socket, _) = ready_listener.accept().await?;
        let probe_request = read_http_request(&mut probe_socket).await?;
        assert!(
            probe_request
                .to_ascii_lowercase()
                .contains("range: bytes=0-0"),
            "expected range probe, got {probe_request:?}"
        );
        let _ = allow_ready_rx.await;
        probe_socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                        ready_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
        drop(probe_socket);

        let (mut full_socket, _) = ready_listener.accept().await?;
        let full_request = read_http_request(&mut full_socket).await?;
        assert!(
            !full_request
                .to_ascii_lowercase()
                .contains("range: bytes=0-0"),
            "expected full download, got {full_request:?}"
        );
        full_socket
            .write_all(&http_response("200 OK", &ready_body))
            .await?;
        Ok::<(), std::io::Error>(())
    });

    let cold_server_task = tokio::spawn(async move {
        let (mut probe_socket, _) = cold_listener.accept().await?;
        let probe_request = read_http_request(&mut probe_socket).await?;
        assert!(
            probe_request
                .to_ascii_lowercase()
                .contains("range: bytes=0-0"),
            "expected range probe, got {probe_request:?}"
        );
        let _ = cold_probe_seen_tx.send(());
        let _ = release_cold_probe_rx.await;
        probe_socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                        cold_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
        drop(probe_socket);

        let (mut full_socket, _) = cold_listener.accept().await?;
        let full_request = read_http_request(&mut full_socket).await?;
        assert!(
            !full_request
                .to_ascii_lowercase()
                .contains("range: bytes=0-0"),
            "expected full download, got {full_request:?}"
        );
        full_socket
            .write_all(&http_response("200 OK", &cold_body))
            .await?;
        let _ = cold_full_seen_tx.send(());
        Ok::<(), std::io::Error>(())
    });

    let task = {
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox);
        tokio::spawn(async move {
            let mut manifest = plan_from_entries(
                vec![
                    storage_entry(
                        "/mnt/ready".into(),
                        format!("http://{ready_addr}/ready.tar.gz"),
                        ready_name,
                        version,
                    ),
                    storage_entry(
                        "/mnt/cold".into(),
                        format!("http://{cold_addr}/cold.tar.gz"),
                        cold_name,
                        version,
                    ),
                ],
                Vec::new(),
                None,
            );
            let mut telemetry = new_telemetry();
            populate_cache_through_background(
                &mut manifest,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
            )
            .await?;
            Ok::<StoragePlan, RunnerError>(manifest)
        })
    };

    tokio::time::timeout(Duration::from_secs(5), cold_probe_seen_rx)
        .await
        .expect("cold worker should start the probe")
        .unwrap();
    allow_ready_tx.send(()).unwrap();
    release_cold_probe_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), cold_full_seen_rx)
        .await
        .expect("both background fills should finish before later warm staging")
        .unwrap();

    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    gate.release_one();
    let manifest = task.await.unwrap().unwrap();
    join_raw_http_task(ready_server_task, "ready storage archive server")
        .await
        .unwrap();
    join_raw_http_task(cold_server_task, "cold storage archive server")
        .await
        .unwrap();

    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 2);

    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(ready_name, version)).as_str())
    );
    assert_eq!(
        storage_archive_url(&manifest, 1),
        Some(format!("file://{}", guest_archive_path(cold_name, version)).as_str())
    );
}

#[tokio::test]
async fn duplicate_same_key_targets_share_one_guest_path_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let name = "duplicate-key";
    let version = "v1";
    write_cached_archive(&home, name, version, &tarball_bytes());

    let sandbox = Arc::new(SamePathConcurrentWriteDetectingSandbox::new("test"));
    let gate = sandbox.gate();

    let task = {
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox);
        tokio::spawn(async move {
            let mut manifest = fresh_duplicate_storage_plan(
                "https://r2.example.com/duplicate-a.tar.gz".into(),
                "https://r2.example.com/duplicate-b.tar.gz".into(),
                name,
                version,
            );
            let mut telemetry = new_telemetry();
            populate_cache_through_background(
                &mut manifest,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
            )
            .await?;
            Ok::<StoragePlan, RunnerError>(manifest)
        })
    };

    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        sandbox.write_file_calls().len(),
        1,
        "duplicate same-key guest path write should be blocked in the sandbox"
    );

    gate.release_one();
    let manifest = task.await.unwrap().unwrap();
    assert_eq!(
        sandbox.write_file_calls().len(),
        1,
        "duplicate same-key targets should share one guest write"
    );

    let expected = format!("file://{}", guest_archive_path(name, version));
    assert_eq!(storage_archive_url(&manifest, 0), Some(expected.as_str()));
    assert_eq!(storage_archive_url(&manifest, 1), Some(expected.as_str()));
}

#[tokio::test]
async fn duplicate_conflicting_archive_sizes_fall_back_to_probe() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/duplicate-a.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/duplicate-a.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let unused_probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/duplicate-b.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let unused_full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/duplicate-b.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let name = "duplicate-miss";
    let version = "v1";
    let mut manifest = plan_from_entries(
        vec![
            storage_entry_with_archive_size(
                "/mnt/duplicate-a".into(),
                server.url("/duplicate-a.tar.gz"),
                name,
                version,
                Some(body.len() as u64),
            ),
            storage_entry_with_archive_size(
                "/mnt/duplicate-b".into(),
                server.url("/duplicate-b.tar.gz"),
                name,
                version,
                Some(body.len() as u64 + 1),
            ),
        ],
        Vec::new(),
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    full.assert_async().await;
    unused_probe.assert_calls_async(0).await;
    unused_full.assert_calls_async(0).await;
    assert_eq!(
        sandbox.write_file_calls().len(),
        1,
        "duplicate same-key cold miss should stage one guest archive"
    );

    let expected = format!("file://{}", guest_archive_path(name, version));
    assert_eq!(storage_archive_url(&manifest, 0), Some(expected.as_str()));
    assert_eq!(storage_archive_url(&manifest, 1), Some(expected.as_str()));

    assert_background_op_count(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, 1);
    let ops = telemetry.pending_ops_snapshot();
    assert_op_count(&ops, "storage_cache_hit", 2);
}

#[tokio::test]
async fn duplicate_equal_and_missing_archive_sizes_share_known_size() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/duplicate-known-a.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/duplicate-known-a.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let name = "duplicate-known-size";
    let version = "v1";
    let archive_size = body.len() as u64;
    let mut manifest = plan_from_entries(
        vec![
            storage_entry_with_archive_size(
                "/mnt/known-a".into(),
                server.url("/duplicate-known-a.tar.gz"),
                name,
                version,
                Some(archive_size),
            ),
            storage_entry_with_archive_size(
                "/mnt/known-b".into(),
                server.url("/duplicate-known-b.tar.gz"),
                name,
                version,
                None,
            ),
            storage_entry_with_archive_size(
                "/mnt/known-c".into(),
                server.url("/duplicate-known-c.tar.gz"),
                name,
                version,
                Some(archive_size),
            ),
        ],
        Vec::new(),
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_calls_async(0).await;
    full.assert_async().await;
    assert_eq!(
        sandbox.write_file_calls().len(),
        1,
        "duplicate entries should share one staged guest archive"
    );
    let expected = format!("file://{}", guest_archive_path(name, version));
    for index in 0..3 {
        assert_eq!(
            storage_archive_url(&manifest, index),
            Some(expected.as_str())
        );
    }
    assert_background_op_count(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, 1);
}

#[tokio::test]
async fn duplicate_storage_and_artifact_key_share_warmed_guest_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let name = "shared-storage-artifact";
    let version = "v1";
    write_cached_archive(&home, name, version, &tarball_bytes());

    let mut manifest = plan_from_entries(
        vec![storage_entry(
            "/mnt/storage".into(),
            "https://r2.example.com/storage.tar.gz".into(),
            name,
            version,
        )],
        vec![artifact_entry(
            "/mnt/artifact".into(),
            "https://r2.example.com/artifact.tar.gz".into(),
            name,
            version,
        )],
        None,
    );

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();
    assert!(records.is_empty());

    assert_eq!(
        sandbox.write_file_calls().len(),
        1,
        "storage and artifact targets with the same key should share one guest write"
    );
    let expected = format!("file://{}", guest_archive_path(name, version));
    assert_eq!(storage_archive_url(&manifest, 0), Some(expected.as_str()));
    assert_eq!(artifact_archive_url(&manifest, 0), Some(expected.as_str()));

    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(
        ops.iter()
            .filter(|(key, _, _)| key == "storage_cache_hit")
            .count(),
        2,
        "expected entry-level hit telemetry for both duplicate targets in {ops:?}"
    );
}

#[tokio::test]
async fn shared_version_distinct_names_get_distinct_guest_paths() {
    // Regression guard: two manifest entries that share `vasVersionId`
    // but differ in `vasStorageName` must resolve to distinct guest
    // `file://` URLs. Before the host/guest key symmetrization, both
    // entries collided on `{GUEST_STAGE_DIR}/{version}.tar.gz` and the
    // second `sandbox.write_file` clobbered the first.
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let version = "v1";
    let name_a = "storage-a";
    let name_b = "storage-b";
    for name in [name_a, name_b] {
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();
    }

    let mut manifest = plan_from_entries(
        vec![
            storage_entry(
                format!("/mnt/{name_a}"),
                "https://r2.example.com/ignored.tar.gz".into(),
                name_a,
                version,
            ),
            storage_entry(
                format!("/mnt/{name_b}"),
                "https://r2.example.com/ignored.tar.gz".into(),
                name_b,
                version,
            ),
        ],
        Vec::new(),
        None,
    );

    populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    let url_a = storage_archive_url(&manifest, 0).unwrap();
    let url_b = storage_archive_url(&manifest, 1).unwrap();
    assert_ne!(
        url_a, url_b,
        "same-version entries must get distinct guest URLs"
    );
    assert_eq!(
        url_a,
        format!("file://{}", guest_archive_path(name_a, version))
    );
    assert_eq!(
        url_b,
        format!("file://{}", guest_archive_path(name_b, version))
    );
}

#[tokio::test]
async fn empty_key_components_are_passthrough() {
    // Defensive guard: an artifact carries non-optional `String` keys,
    // so an empty value is serde-representable. Hashing an empty string
    // yields a fixed digest that every other empty-key entry would
    // collide on, so we skip these rather than letting them share a
    // cache slot.
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();

    let original = "https://r2.example.com/nameless.tar.gz".to_string();
    let mut manifest = fresh_artifact_plan(original.clone(), "", "");

    populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    // archive_url untouched — the entry was skipped entirely.
    assert_eq!(artifact_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(telemetry.pending_ops_snapshot().is_empty());
}

#[tokio::test]
async fn concurrent_populate_for_same_key_downloads_once() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox_a = MockSandbox::new("test-a");
    let sandbox_b = MockSandbox::new("test-b");
    let mut telemetry_a = new_telemetry();
    let mut telemetry_b = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/concurrent.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/concurrent.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let url = server.url("/concurrent.tar.gz");
    let name = "race-skill";
    let version = "v1";
    let mut manifest_a = fresh_storage_plan(url.clone(), name, version);
    let mut manifest_b = fresh_storage_plan(url.clone(), name, version);

    let deferred_a =
        select_background_fill(&mut manifest_a, &sandbox_a, &home, &mut telemetry_a).await;
    let deferred_b =
        select_background_fill(&mut manifest_b, &sandbox_b, &home, &mut telemetry_b).await;

    let (records_a, records_b) = tokio::join!(deferred_a.run(), deferred_b.run());

    let filled = records_a
        .iter()
        .chain(&records_b)
        .filter(|record| record.action_type == STORAGE_CACHE_BACKGROUND_FILL_FILLED)
        .count();
    let competing = records_a
        .iter()
        .chain(&records_b)
        .filter(|record| {
            matches!(
                record.action_type,
                STORAGE_CACHE_BACKGROUND_FILL_BUSY | STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED
            )
        })
        .count();
    assert_eq!(filled, 1, "exactly one background fill should win");
    assert_eq!(competing, 1, "the competing fill should not download");

    let later_a = populate_cache(&mut manifest_a, &sandbox_a, &home, &mut telemetry_a)
        .await
        .unwrap();
    let later_b = populate_cache(&mut manifest_b, &sandbox_b, &home, &mut telemetry_b)
        .await
        .unwrap();
    assert!(later_a.is_none());
    assert!(later_b.is_none());

    let expected = format!("file://{}", guest_archive_path(name, version));
    assert_eq!(storage_archive_url(&manifest_a, 0), Some(expected.as_str()));
    assert_eq!(storage_archive_url(&manifest_b, 0), Some(expected.as_str()));

    get.assert_calls_async(1).await;
    probe.assert_calls_async(1).await;
}

#[tokio::test]
async fn r2_style_head_rejected_probe_via_get_range_succeeds() {
    // Regression for #10842. R2 GET-presigned URLs 403 on HEAD (SigV4
    // binds the signature to the HTTP method). The probe must use
    // GET + Range: bytes=0-0 and parse Content-Range — never HEAD.
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let head_forbidden = server
        .mock_async(|when, then| {
            when.method(HEAD).path("/r2.tar.gz");
            then.status(403);
        })
        .await;
    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/r2.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(b"x");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET).path("/r2.tar.gz").header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let url = server.url("/r2.tar.gz");
    let name = "r2-skill";
    let version = "v1";
    let mut manifest = fresh_storage_plan(url, name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    head_forbidden.assert_calls_async(0).await;
    probe.assert_async().await;
    full.assert_async().await;

    assert_eq!(
        storage_archive_url(&manifest, 0),
        Some(format!("file://{}", guest_archive_path(name, version)).as_str())
    );
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
}

#[tokio::test]
async fn probe_206_without_content_range_is_passthrough() {
    // Server returns 206 but omits Content-Range entirely. Probe can't
    // extract a total, so the entry must stay passthrough.
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/nosize.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206).body(b"x");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/nosize.tar.gz")
                .header_missing("range");
            then.status(200).body(tarball_bytes());
        })
        .await;

    let original = server.url("/nosize.tar.gz");
    let name = "nosize";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    full.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn probe_wildcard_content_range_is_passthrough() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("test");
    let mut telemetry = new_telemetry();
    let server = MockServer::start_async().await;
    let body = tarball_bytes();

    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/wildcard.tar.gz")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", "bytes 0-0/*")
                .body(b"x");
        })
        .await;
    let full = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/wildcard.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;

    let original = server.url("/wildcard.tar.gz");
    let name = "wildcard";
    let version = "v1";
    let mut manifest = fresh_storage_plan(original.clone(), name, version);

    let records = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();

    probe.assert_async().await;
    full.assert_calls_async(0).await;
    assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
    assert!(
        !home
            .storage_cache_dir(name, version)
            .join("archive.tar.gz")
            .exists()
    );
    assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
}

#[tokio::test]
async fn probe_malformed_content_range_is_passthrough() {
    let cases = [
        ("bogus-no-slash", "no-slash"),
        ("bogus/7", "bogus-slash"),
        ("bytes */7", "wildcard-range"),
        ("bytes 1-0/7", "reversed-range"),
        ("bytes 0-1/7", "wrong-range"),
        ("items 0-0/7", "wrong-unit"),
        ("bytes 0-0/0", "empty-total"),
        ("bytes -0/7", "empty-start"),
        ("bytes 0-/7", "empty-end"),
        ("bytes 0-0/", "empty-size"),
        ("bytes 0-0/7/8", "extra-slash"),
        ("bytes 0-0/7 extra", "extra-token"),
        ("bytes 0-0/18446744073709551616", "overflow-total"),
        ("bytes +0-0/7", "plus-start"),
        ("bytes 0-+0/7", "plus-end"),
        ("bytes 0-0/+7", "plus-total"),
    ];

    for (content_range, slug) in cases {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let path = format!("/{slug}.tar.gz");
        let probe_path = path.clone();
        let full_path = path.clone();
        let probe_content_range = content_range.to_string();

        let probe = server
            .mock_async(move |when, then| {
                when.method(GET)
                    .path(probe_path.as_str())
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", probe_content_range)
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(move |when, then| {
                when.method(GET)
                    .path(full_path.as_str())
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url(path.as_str());
        let name = format!("garbage-{slug}");
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name.as_str(), version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(original.as_str()),
            "{content_range} must stay passthrough"
        );
        assert!(
            !home
                .storage_cache_dir(name.as_str(), version)
                .join("archive.tar.gz")
                .exists(),
            "{content_range} must not write a cache archive"
        );
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }
}
