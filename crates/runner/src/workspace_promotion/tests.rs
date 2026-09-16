use super::test_support::{
    TEST_WORKSPACE_IMAGE_SIZE_BYTES, WorkspacePromotionFixture, test_restored_session_identity,
};
use super::*;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, paths::CANONICAL_WORKING_DIR,
};
use async_trait::async_trait;
use guest_contracts::session_history_identity::{
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE, SessionHistorySidecarExportFailure,
    SessionHistorySidecarExportMetadata, SessionHistorySidecarExportTimings,
    SessionHistorySidecarIoErrorClass, SessionHistorySidecarRepresentation,
    SessionHistorySidecarResourceUsage,
};
use sandbox::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestAgentProcessHandle,
    GuestProcessHandle, ProcessExit, Sandbox, SandboxFactory, SandboxId, StartAgentProcessRequest,
    StartProcessRequest,
};
use sandbox_mock::{
    ExecMatcher, MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides,
};
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use crate::ids::RunId;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceImageCache, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest,
};

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

async fn mock_sandbox_with_overrides(
    sandbox_id: SandboxId,
    overrides: Arc<MockSandboxOverrides>,
) -> Box<dyn Sandbox> {
    let factory = MockSandboxFactory::with_overrides(overrides);
    factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox")
}

async fn prepare_and_publish_workspace_image(
    sandbox: &dyn Sandbox,
    promotion: WorkspaceImagePromotionContext,
) -> bool {
    match prepare_workspace_image_from_active_sandbox(sandbox, Some(promotion), "test").await {
        Some(prepared) => prepared.publish().await,
        None => false,
    }
}

struct PostCopyGateSandbox {
    inner: MockSandbox,
    copy_completed: Arc<tokio::sync::Barrier>,
    copy_release: Arc<tokio::sync::Notify>,
}

impl PostCopyGateSandbox {
    fn new(id: impl Into<String>) -> Self {
        Self {
            inner: MockSandbox::new(id),
            copy_completed: Arc::new(tokio::sync::Barrier::new(2)),
            copy_release: Arc::new(tokio::sync::Notify::new()),
        }
    }

    async fn wait_for_copy(&self) {
        self.copy_completed.wait().await;
    }

    fn release_copy(&self) {
        self.copy_release.notify_one();
    }
}

#[async_trait]
impl Sandbox for PostCopyGateSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
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

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn apply_storage_manifest(
        &self,
        request: &sandbox::StorageManifestRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        self.inner.apply_storage_manifest(request).await
    }

    async fn restore_guest_state(
        &self,
        request: &sandbox::GuestStateRestoreRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        self.inner.restore_guest_state(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<CopyFileResult> {
        let result = self.inner.copy_file(path, host_path, options).await;
        self.copy_completed.wait().await;
        self.copy_release.notified().await;
        result
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        compression: sandbox::FileCompression,
    ) -> sandbox::Result<()> {
        self.inner
            .write_file_with_compression(path, content, compression)
            .await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_private_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn start_agent_process(
        &self,
        request: &StartAgentProcessRequest<'_>,
    ) -> sandbox::Result<GuestAgentProcessHandle> {
        self.inner.start_agent_process(request).await
    }

    async fn wait_process(
        &self,
        handle: GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

struct PanicExecSandbox {
    id: String,
}

impl PanicExecSandbox {
    fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

#[async_trait]
impl Sandbox for PanicExecSandbox {
    fn id(&self) -> &str {
        &self.id
    }

    fn source_ip(&self) -> &str {
        "10.0.0.1"
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        Ok(sandbox::SandboxParkOutcome::Reusable)
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn exec(&self, _request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        panic!("simulated exec panic");
    }

    async fn apply_storage_manifest(
        &self,
        _request: &sandbox::StorageManifestRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        panic!("unused apply_storage_manifest");
    }

    async fn restore_guest_state(
        &self,
        _request: &sandbox::GuestStateRestoreRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        panic!("unused restore_guest_state");
    }

    async fn read_file(&self, _path: &str, _max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        Ok(None)
    }

    async fn copy_file(
        &self,
        _path: &str,
        _host_path: &std::path::Path,
        _options: CopyFileOptions,
    ) -> sandbox::Result<CopyFileResult> {
        panic!("unused copy_file");
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> sandbox::Result<()> {
        Ok(())
    }

    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        _compression: sandbox::FileCompression,
    ) -> sandbox::Result<()> {
        self.write_file(path, content).await
    }

    async fn write_private_file(&self, _path: &str, _content: &[u8]) -> sandbox::Result<()> {
        panic!("unused write_private_file");
    }

    async fn start_process(
        &self,
        _request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<GuestProcessHandle> {
        panic!("unused start_process");
    }

    async fn start_agent_process(
        &self,
        _request: &StartAgentProcessRequest<'_>,
    ) -> sandbox::Result<GuestAgentProcessHandle> {
        panic!("unused start_agent_process");
    }

    async fn wait_process(
        &self,
        _handle: GuestProcessHandle,
        _timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        panic!("unused wait_process");
    }
}

#[tokio::test]
async fn parked_workspace_promotion_unparks_and_freezes_before_publish() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-promote").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await
    .expect("workspace promotion should prepare");

    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(exec_calls[0].sudo);
    let freeze_command = &exec_calls[0].cmd;
    assert!(freeze_command.contains("workspace_dir='/home/user/workspace'"));
    assert!(freeze_command.contains("workspace_device='/dev/vdb'"));
    assert!(freeze_command.contains("refuse_workspace_symlink_path"));
    assert!(freeze_command.contains("mountpoint -q -- \"$workspace_dir\""));
    assert!(freeze_command.contains("exec 3< \"$workspace_dir\""));
    assert!(freeze_command.contains("mountpoint -d -- \"$workspace_fd_path\""));
    assert!(freeze_command.contains("workspace_fsfreeze_path='/usr/sbin/fsfreeze'"));
    assert!(
        freeze_command.contains("\"$workspace_fsfreeze_path\" --freeze \"$workspace_fd_path\"")
    );
    assert!(!freeze_command.contains("--unfreeze"));
    assert!(!freeze_command.contains("umount"));
    assert!(!freeze_command.contains("kill "));
    assert!(!freeze_command.contains("pkill"));
    assert!(!freeze_command.contains("killall"));
    assert!(
        fixture.cache.held_workspace_states().await.is_empty(),
        "a frozen image must not be published before the caller stops the sandbox"
    );

    let promoted = prepared.publish().await;

    assert!(promoted);
    let states = fixture.cache.held_workspace_states().await;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, fixture.reuse_key);
}

#[tokio::test]
async fn active_workspace_promotion_exports_session_history_sidecar() {
    let reuse_key = "thread:active-sidecar-promote";
    let session_id = "sess-active-sidecar-promote";
    let history = br#"{"type":"message","content":"cached"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    assert!(fixture.promotion.restored_session_identity().is_some());
    let sandbox = sandbox_mock::MockSandbox::new(fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: SessionHistorySidecarExportTimings {
            metadata_us: 101,
            resolve_us: 202,
            read_verify_us: 303,
            write_us: 404,
            total_us: 1010,
            read_verify_resources: Some(SessionHistorySidecarResourceUsage {
                user_cpu_us: 1,
                system_cpu_us: 2,
                minor_faults: 3,
                major_faults: 4,
                input_blocks: 5,
                output_blocks: 6,
                voluntary_context_switches: 7,
                involuntary_context_switches: 8,
            }),
            write_resources: Some(Default::default()),
        },
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));

    let (promoted, events) = capture_promotion_events(async {
        prepare_workspace_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
            .await
            .expect("workspace promotion should prepare")
            .publish()
            .await
    })
    .await;

    assert!(promoted);
    let export_event = captured_event(
        &events,
        "workspace image cache session history sidecar export completed",
    );
    assert_eq!(export_event.level, Level::INFO);
    for (field, expected) in [
        ("helper_metadata_us", 101),
        ("helper_resolve_us", 202),
        ("helper_read_verify_us", 303),
        ("helper_write_us", 404),
        ("helper_total_us", 1010),
        ("helper_read_verify_user_cpu_us", 1),
        ("helper_read_verify_system_cpu_us", 2),
        ("helper_read_verify_minor_faults", 3),
        ("helper_read_verify_major_faults", 4),
        ("helper_read_verify_input_blocks", 5),
        ("helper_read_verify_output_blocks", 6),
        ("helper_read_verify_voluntary_context_switches", 7),
        ("helper_read_verify_involuntary_context_switches", 8),
        ("helper_write_user_cpu_us", 0),
        ("helper_write_system_cpu_us", 0),
        ("helper_write_minor_faults", 0),
        ("helper_write_major_faults", 0),
        ("helper_write_input_blocks", 0),
        ("helper_write_output_blocks", 0),
        ("helper_write_voluntary_context_switches", 0),
        ("helper_write_involuntary_context_switches", 0),
        ("history_size_bytes", history.len() as u64),
        ("encoded_size", history.len() as u64),
    ] {
        assert_eq!(export_event.fields[field].parse::<u64>().unwrap(), expected);
    }
    for field in ["export_admission_ms", "export_exec_ms"] {
        export_event.fields[field].parse::<u64>().unwrap();
    }
    for stage in ["read_verify", "write"] {
        assert_eq!(
            export_event.fields[&format!("helper_{stage}_resources_available")],
            "true"
        );
    }
    let promotion_event = captured_event(&events, "workspace image cache promoted");
    assert_eq!(
        promotion_event
            .fields
            .get("transfer_mode")
            .map(String::as_str),
        Some("rename")
    );
    assert_eq!(
        promotion_event.fields.get("outcome").map(String::as_str),
        Some("promoted")
    );
    assert_eq!(
        promotion_event
            .fields
            .get("logical_image_size_bytes")
            .and_then(|value| value.parse::<u64>().ok()),
        Some(TEST_WORKSPACE_IMAGE_SIZE_BYTES)
    );
    for field in ["transfer_ms", "promotion_ms"] {
        promotion_event.fields[field]
            .parse::<u64>()
            .unwrap_or_else(|error| panic!("invalid {field}: {error}; event={promotion_event:#?}"));
    }
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 2);
    assert!(exec_calls[0].cmd.contains("export-session-history-sidecar"));
    assert_eq!(exec_calls[0].timeout, Duration::from_secs(30));
    assert_eq!(
        exec_calls[0].env_keys,
        vec![guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV]
    );
    assert!(exec_calls[1].sudo);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(copy_calls[0].path.ends_with("/session-history-sidecar"));
    assert_eq!(copy_calls[0].max_bytes, RESUME_SESSION_HISTORY_MAX_BYTES);
    let inspection = fixture.cache.inspect().await.unwrap();
    let entry = inspection.entries.first().unwrap();
    let entry_paths = fixture.cache.entry_paths(&entry.cache_key);
    assert_eq!(
        copy_calls[0].host_path.parent(),
        Some(entry_paths.entry_dir())
    );
    let sidecar_metadata_path = entry_paths.session_history_sidecar_metadata();
    if !sidecar_metadata_path.is_file() {
        let entries = std::fs::read_dir(entry_paths.entry_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        panic!("missing sidecar metadata; entries={entries:?}; events={events:#?}");
    }
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(sidecar_metadata_path).unwrap()).unwrap();
    assert!(persisted.get("timings").is_none());

    let lease = fixture
        .cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    let sidecar = lease
        .probe_session_history_sidecar(&restored_identity)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn successful_slow_sidecar_export_reports_timings_at_warn() {
    for (guest_duration_ms, expected_level) in [(4999, Level::INFO), (5000, Level::WARN)] {
        let history = b"cached history";
        let restored_identity = test_restored_session_identity("sess-export-timing", history);
        let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
            "thread:export-timing",
            Some(&restored_identity),
        )
        .await;
        let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
        let metadata = SessionHistorySidecarExportMetadata {
            representation: SessionHistorySidecarRepresentation::Raw,
            encoded_size: history.len() as u64,
            timings: SessionHistorySidecarExportTimings {
                metadata_us: 100,
                resolve_us: 200,
                read_verify_us: 3_000_000,
                write_us: 1_000_000,
                total_us: 4_000_300,
                read_verify_resources: None,
                write_resources: None,
            },
        };
        let mut result = ExecResult::new(0, serde_json::to_vec(&metadata).unwrap(), Vec::new());
        result.guest_duration_ms = Some(guest_duration_ms);
        sandbox.push_exec_result(Ok(result));
        sandbox.push_copy_file_result(Ok(history.to_vec()));

        let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
            &sandbox,
            fixture.promotion,
        ))
        .await;

        assert!(promoted, "slow success must still publish the sidecar");
        let event = captured_event(
            &events,
            "workspace image cache session history sidecar export completed",
        );
        assert_eq!(event.level, expected_level);
        assert_eq!(
            event.fields["guest_duration_ms"],
            guest_duration_ms.to_string()
        );
        assert_eq!(event.fields["helper_read_verify_us"], "3000000");
        assert_eq!(event.fields["helper_write_us"], "1000000");
        assert_eq!(event.fields["helper_total_us"], "4000300");
        for stage in ["read_verify", "write"] {
            assert_eq!(
                event.fields[&format!("helper_{stage}_resources_available")],
                "false"
            );
            for counter in [
                "user_cpu_us",
                "system_cpu_us",
                "minor_faults",
                "major_faults",
                "input_blocks",
                "output_blocks",
                "voluntary_context_switches",
                "involuntary_context_switches",
            ] {
                assert!(
                    !event
                        .fields
                        .contains_key(&format!("helper_{stage}_{counter}"))
                );
            }
        }
        assert_eq!(sandbox.copy_file_calls().len(), 1);
    }
}

#[tokio::test]
async fn session_history_sidecar_export_admission_queues_before_guest_exec() {
    let history = br#"{"type":"message","content":"bounded export"}"#;
    let first_identity = test_restored_session_identity("sess-export-first", history);
    let second_identity = test_restored_session_identity("sess-export-second", history);
    let first_fixture =
        WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
            "thread:export-first",
            Some(&first_identity),
            1,
        )
        .await;
    let second_fixture = WorkspacePromotionFixture::new_with_cache(
        Arc::clone(&first_fixture._dir),
        first_fixture.cache.clone(),
        "thread:export-second",
        Some(&second_identity),
    )
    .await;
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };

    let gate = MockLifecycleGate::new();
    let first_overrides = Arc::new(MockSandboxOverrides::new());
    first_overrides.set_exec_lifecycle_gate(gate.clone());
    let first_sandbox = Arc::new(MockSandbox::with_overrides(
        first_fixture.sandbox_id.to_string(),
        first_overrides,
    ));
    first_sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    first_sandbox.push_copy_file_result(Ok(history.to_vec()));

    let second_sandbox = MockSandbox::new(second_fixture.sandbox_id.to_string());
    second_sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    second_sandbox.push_copy_file_result(Ok(history.to_vec()));

    let first_promotion = first_fixture.promotion;
    let first_task_sandbox = Arc::clone(&first_sandbox);
    let first_task = tokio::spawn(async move {
        prepare_workspace_image_from_active_sandbox(
            first_task_sandbox.as_ref(),
            Some(first_promotion),
            "test",
        )
        .await
    });
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();

    let second = prepare_workspace_image_from_active_sandbox(
        &second_sandbox,
        Some(second_fixture.promotion),
        "test",
    );
    tokio::pin!(second);
    assert!(matches!(futures_util::poll!(&mut second), Poll::Pending));
    assert!(second_sandbox.exec_calls().is_empty());

    gate.release_many(10);
    let first_prepared = first_task
        .await
        .unwrap()
        .expect("first workspace promotion should prepare");
    let second_prepared = second
        .await
        .expect("queued workspace promotion should prepare");

    assert!(
        second_sandbox.exec_calls()[0]
            .cmd
            .contains("export-session-history-sidecar")
    );
    first_prepared.abandon("test").await;
    second_prepared.abandon("test").await;
}

#[tokio::test]
async fn session_history_sidecar_export_admission_releases_before_host_copy() {
    let history = br#"{"type":"message","content":"parallel copy"}"#;
    let first_identity = test_restored_session_identity("sess-copy-first", history);
    let second_identity = test_restored_session_identity("sess-copy-second", history);
    let first_fixture =
        WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
            "thread:copy-first",
            Some(&first_identity),
            1,
        )
        .await;
    let second_fixture = WorkspacePromotionFixture::new_with_cache(
        Arc::clone(&first_fixture._dir),
        first_fixture.cache.clone(),
        "thread:copy-second",
        Some(&second_identity),
    )
    .await;
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };

    let first_sandbox = Arc::new(PostCopyGateSandbox::new(
        first_fixture.sandbox_id.to_string(),
    ));
    first_sandbox.inner.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    first_sandbox
        .inner
        .push_copy_file_result(Ok(history.to_vec()));
    let second_sandbox = Arc::new(MockSandbox::new(second_fixture.sandbox_id.to_string()));
    second_sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    second_sandbox.push_copy_file_result(Ok(history.to_vec()));

    let first_promotion = first_fixture.promotion;
    let first_task_sandbox = Arc::clone(&first_sandbox);
    let first_task = tokio::spawn(async move {
        prepare_workspace_image_from_active_sandbox(
            first_task_sandbox.as_ref(),
            Some(first_promotion),
            "test",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), first_sandbox.wait_for_copy())
        .await
        .expect("first promotion should reach host copy");
    assert!(!first_task.is_finished());

    let second_promotion = second_fixture.promotion;
    let second_task_sandbox = Arc::clone(&second_sandbox);
    let second_task = tokio::spawn(async move {
        prepare_workspace_image_from_active_sandbox(
            second_task_sandbox.as_ref(),
            Some(second_promotion),
            "test",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while second_sandbox.exec_calls().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("second export should enter while first host copy is blocked");
    assert!(
        second_sandbox.exec_calls()[0]
            .cmd
            .contains("export-session-history-sidecar")
    );

    first_sandbox.release_copy();
    let first_prepared = first_task
        .await
        .unwrap()
        .expect("first workspace promotion should prepare");
    let second_prepared = second_task
        .await
        .unwrap()
        .expect("second workspace promotion should prepare");
    first_prepared.abandon("test").await;
    second_prepared.abandon("test").await;
}

#[tokio::test]
async fn session_history_sidecar_export_admission_releases_after_panic() {
    let history = br#"{"type":"message","content":"panic release"}"#;
    let first_identity = test_restored_session_identity("sess-panic-first", history);
    let second_identity = test_restored_session_identity("sess-panic-second", history);
    let first_fixture =
        WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
            "thread:panic-first",
            Some(&first_identity),
            1,
        )
        .await;
    let second_fixture = WorkspacePromotionFixture::new_with_cache(
        Arc::clone(&first_fixture._dir),
        first_fixture.cache.clone(),
        "thread:panic-second",
        Some(&second_identity),
    )
    .await;

    let first_prepared = prepare_workspace_image_from_active_sandbox(
        &PanicExecSandbox::new("panic-export"),
        Some(first_fixture.promotion),
        "test",
    )
    .await;
    assert!(first_prepared.is_none());

    let second_sandbox = MockSandbox::new(second_fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    second_sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    second_sandbox.push_copy_file_result(Ok(history.to_vec()));

    let second_prepared = tokio::time::timeout(
        Duration::from_secs(5),
        prepare_workspace_image_from_active_sandbox(
            &second_sandbox,
            Some(second_fixture.promotion),
            "test",
        ),
    )
    .await
    .expect("second promotion should not wait on leaked export admission")
    .expect("second workspace promotion should prepare");
    second_prepared.abandon("test").await;
}

#[tokio::test]
async fn active_workspace_promotion_rejects_invalid_sidecar_metadata() {
    for (name, stdout) in [
        ("malformed-json", b"not json".to_vec()),
        (
            "zero-size",
            serde_json::to_vec(&SessionHistorySidecarExportMetadata {
                timings: Default::default(),
                representation: SessionHistorySidecarRepresentation::Raw,
                encoded_size: 0,
            })
            .unwrap(),
        ),
        (
            "over-max",
            serde_json::to_vec(&SessionHistorySidecarExportMetadata {
                timings: Default::default(),
                representation: SessionHistorySidecarRepresentation::Raw,
                encoded_size: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
            })
            .unwrap(),
        ),
    ] {
        let reuse_key = format!("thread:invalid-sidecar-metadata-{name}");
        let session_id = format!("sess-invalid-sidecar-metadata-{name}");
        let history = br#"{"type":"message","content":"invalid"}"#;
        let restored_identity = test_restored_session_identity(&session_id, history);
        let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
            &reuse_key,
            Some(&restored_identity),
        )
        .await;
        let cache = fixture.cache.clone();
        let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
        sandbox.push_exec_result(Ok(ExecResult::new(0, stdout, Vec::new())));

        let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
            &sandbox,
            fixture.promotion,
        ))
        .await;

        assert!(promoted, "{name}");
        assert!(sandbox.copy_file_calls().is_empty(), "{name}");
        let exec_calls = sandbox.exec_calls();
        assert_eq!(exec_calls.len(), 2, "{name}");
        assert!(
            exec_calls[0].cmd.contains("export-session-history-sidecar"),
            "{name}"
        );
        assert!(exec_calls[1].sudo, "{name}");
        let event = captured_event(
            &events,
            "workspace image cache session history sidecar export returned invalid metadata",
        );
        assert!(
            event
                .fields
                .get("reason")
                .is_some_and(|reason| reason == "test"),
            "{name}: {event:#?}"
        );
        assert_sidecar_rejection_publishes_without_sidecar(
            &cache,
            &reuse_key,
            &restored_identity,
            name,
        )
        .await;
    }
}

#[tokio::test]
async fn active_workspace_promotion_discards_sidecar_source_on_copy_error() {
    let reuse_key = "thread:sidecar-copy-error";
    let session_id = "sess-sidecar-copy-error";
    let history = br#"{"type":"message","content":"copy error"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Err(sandbox::SandboxError::Operation {
        operation: sandbox::SandboxOperation::CopyFile,
        reason: sandbox::SandboxOperationReason::Other,
        message: "simulated copy failure".into(),
    }));

    let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
        &sandbox,
        fixture.promotion,
    ))
    .await;

    assert!(promoted);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(!copy_calls[0].host_path.exists());
    let event = captured_event(
        &events,
        "workspace image cache session history sidecar copy failed",
    );
    assert!(event.fields.contains_key("error"), "{event:#?}");
    assert_sidecar_rejection_publishes_without_sidecar(
        &cache,
        reuse_key,
        &restored_identity,
        "copy-error",
    )
    .await;
}

#[tokio::test]
async fn cancelled_workspace_promotion_preserves_session_history_sidecar() {
    let history = br#"{"type":"message","content":"cancelled"}"#;
    let identity = test_restored_session_identity("cancelled-session", history);
    let fixture = WorkspacePromotionFixture::new_with_terminal_status(
        "thread:cancelled-sidecar",
        Some(&identity),
        WorkspaceCacheTerminalStatus::Cancelled,
    )
    .await;
    let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&SessionHistorySidecarExportMetadata {
            timings: Default::default(),
            representation: SessionHistorySidecarRepresentation::Raw,
            encoded_size: history.len() as u64,
        })
        .unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));

    assert!(prepare_and_publish_workspace_image(&sandbox, fixture.promotion).await);
    let lease = fixture
        .cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(&fixture.reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    let sidecar = lease
        .probe_session_history_sidecar(&identity)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn workspace_promotion_classifies_cancelled_sidecar_admission_rejections() {
    use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};

    for (terminal_status, operation, host_io_failure) in [
        (
            WorkspaceCacheTerminalStatus::Cancelled,
            SandboxOperation::Exec,
            false,
        ),
        (
            WorkspaceCacheTerminalStatus::Cancelled,
            SandboxOperation::CopyFile,
            false,
        ),
        (
            WorkspaceCacheTerminalStatus::Cancelled,
            SandboxOperation::CopyFile,
            true,
        ),
        (
            WorkspaceCacheTerminalStatus::Success,
            SandboxOperation::Exec,
            false,
        ),
        (
            WorkspaceCacheTerminalStatus::Success,
            SandboxOperation::CopyFile,
            false,
        ),
    ] {
        let history = br#"{"type":"message","content":"sidecar"}"#;
        let identity = test_restored_session_identity("sidecar-admission", history);
        let fixture = WorkspacePromotionFixture::new_with_terminal_status(
            "thread:sidecar-admission",
            Some(&identity),
            terminal_status,
        )
        .await;
        let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
        let error = if host_io_failure {
            SandboxError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "host staging denied",
            ))
        } else {
            SandboxError::Operation {
                operation,
                reason: SandboxOperationReason::GuestConnectionUnavailable,
                message: "normal operation rejected".into(),
            }
        };
        let message = if operation == SandboxOperation::Exec {
            sandbox.push_exec_result(Err(error));
            "workspace image cache session history sidecar export errored"
        } else {
            sandbox.push_exec_result(Ok(ExecResult::new(
                0,
                serde_json::to_vec(&SessionHistorySidecarExportMetadata {
                    timings: Default::default(),
                    representation: SessionHistorySidecarRepresentation::Raw,
                    encoded_size: history.len() as u64,
                })
                .unwrap(),
                Vec::new(),
            )));
            sandbox.push_copy_file_result(Err(error));
            "workspace image cache session history sidecar copy failed"
        };
        if !host_io_failure {
            sandbox.push_exec_result(Err(SandboxError::Operation {
                operation: SandboxOperation::Exec,
                reason: SandboxOperationReason::GuestConnectionUnavailable,
                message: "normal operation rejected".into(),
            }));
        }
        let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
            &sandbox,
            fixture.promotion,
        ))
        .await;
        assert_eq!(promoted, host_io_failure);
        let expected_level =
            if terminal_status == WorkspaceCacheTerminalStatus::Cancelled && !host_io_failure {
                Level::INFO
            } else {
                Level::WARN
            };
        assert_eq!(captured_event(&events, message).level, expected_level);
        if !host_io_failure {
            assert_eq!(
                captured_event(
                    &events,
                    "workspace image cache promotion skipped because guest freeze failed"
                )
                .level,
                expected_level
            );
            assert!(fixture.cache.held_workspace_states().await.is_empty());
        }
        for copy in sandbox.copy_file_calls() {
            assert!(!copy.host_path.exists(), "failed copy must release staging");
        }
    }
}

#[tokio::test]
async fn active_workspace_promotion_discards_sidecar_source_on_copy_size_mismatch() {
    let reuse_key = "thread:sidecar-copy-size-mismatch";
    let session_id = "sess-sidecar-copy-size-mismatch";
    let history = br#"{"type":"message","content":"short copy"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64 + 1,
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));

    let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
        &sandbox,
        fixture.promotion,
    ))
    .await;

    assert!(promoted);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(!copy_calls[0].host_path.exists());
    let event = captured_event(
        &events,
        "workspace image cache session history sidecar copy size mismatch",
    );
    assert_eq!(event.level, Level::WARN);
    assert_eq!(
        captured_event(
            &events,
            "workspace image cache session history sidecar export completed",
        )
        .level,
        Level::INFO,
        "successful export timing must not hide subsequent copy failure"
    );
    let copied_bytes = history.len().to_string();
    let encoded_size = (history.len() as u64 + 1).to_string();
    assert_eq!(
        event.fields.get("copied_bytes").map(String::as_str),
        Some(copied_bytes.as_str()),
        "{event:#?}"
    );
    assert_eq!(
        event.fields.get("encoded_size").map(String::as_str),
        Some(encoded_size.as_str()),
        "{event:#?}"
    );
    assert_sidecar_rejection_publishes_without_sidecar(
        &cache,
        reuse_key,
        &restored_identity,
        "copy-size-mismatch",
    )
    .await;
}

async fn assert_sidecar_rejection_publishes_without_sidecar(
    cache: &WorkspaceImageCache,
    reuse_key: &str,
    restored_identity: &RestoredSessionIdentity,
    name: &str,
) {
    let inspection = cache.inspect().await.unwrap();
    let entry = inspection.entries.first().unwrap();
    let entry_paths = cache.entry_paths(&entry.cache_key);
    assert!(
        !entry_paths.session_history_sidecar_metadata().is_file(),
        "{name}"
    );
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit, "{name}");
    assert!(
        lease
            .probe_session_history_sidecar(restored_identity)
            .await
            .is_err(),
        "{name}"
    );
}

#[tokio::test]
async fn active_workspace_permission_failure_skips_cache_publication() {
    let fixture = WorkspacePromotionFixture::new("sess-active-permission-failure").await;
    let paths = crate::paths::RunnerPaths::new(fixture._dir.path().join("runner"));
    let active_image = paths.active_workspace_image(&fixture.sandbox_id);
    tokio::fs::set_permissions(&active_image, std::fs::Permissions::from_mode(0o660))
        .await
        .unwrap();
    let cache = fixture.cache.clone();
    let reuse_key = fixture.reuse_key.clone();
    let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());

    let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
        &sandbox,
        fixture.promotion,
    ))
    .await;

    assert!(!promoted);
    let event = captured_event(&events, "workspace image cache promotion failed");
    assert!(
        event
            .fields
            .get("error")
            .is_some_and(|error| error.contains("group/other writable"))
    );
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&cache, &reuse_key).await,
        WorkspaceCacheCheckoutResult::Miss
    );
}

#[tokio::test(flavor = "current_thread")]
async fn active_workspace_promotion_classifies_sidecar_export_failures() {
    let storage_full = serde_json::to_vec(&SessionHistorySidecarExportFailure {
        io_error_class: SessionHistorySidecarIoErrorClass::StorageFull,
    })
    .unwrap();
    let private_helper_output = b"/home/user/private/session.jsonl".to_vec();
    for (name, exit_code, stdout, expected_stage, expected_io_class) in [
        (
            "source-read",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
            Vec::new(),
            "source-history",
            "unknown",
        ),
        (
            "output-storage-full",
            SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE,
            storage_full,
            "output-write",
            "storage-full",
        ),
        (
            "output-malformed",
            SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE,
            private_helper_output.clone(),
            "output-write",
            "unknown",
        ),
    ] {
        let reuse_key = format!("thread:active-sidecar-{name}");
        let session_id = format!("sess-active-sidecar-{name}");
        let history = br#"{"type":"message","content":"failure"}"#;
        let restored_identity = test_restored_session_identity(&session_id, history);
        let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
            &reuse_key,
            Some(&restored_identity),
        )
        .await;
        let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
        sandbox.push_exec_result(Ok(ExecResult::new(exit_code, stdout, Vec::new())));

        let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
            &sandbox,
            fixture.promotion,
        ))
        .await;

        assert!(promoted, "{name}");
        assert!(sandbox.copy_file_calls().is_empty(), "{name}");
        let event = captured_event(
            &events,
            "workspace image cache session history sidecar export failed",
        );
        let expected_exit_code = exit_code.to_string();
        let expected_error =
            format!("session history sidecar export failed (exit code {exit_code})");
        assert_eq!(
            event.fields.get("helper_exit_code").map(String::as_str),
            Some(expected_exit_code.as_str()),
            "{name}: {event:#?}"
        );
        assert_eq!(
            event.fields.get("failure_stage").map(String::as_str),
            Some(expected_stage),
            "{name}: {event:#?}"
        );
        assert_eq!(
            event.fields.get("io_error_class").map(String::as_str),
            Some(expected_io_class),
            "{name}: {event:#?}"
        );
        assert_eq!(
            event.fields.get("error").map(String::as_str),
            Some(expected_error.as_str()),
            "{name}: {event:#?}"
        );
        assert!(
            event
                .fields
                .values()
                .all(|value| !value.contains("/home/user/private")),
            "{name}: {event:#?}"
        );
        let exec_calls = sandbox.exec_calls();
        assert_eq!(exec_calls.len(), 2, "{name}");
        assert!(exec_calls[0].expected_exit_codes.is_empty(), "{name}");
    }
}

#[tokio::test]
async fn session_history_sidecar_staging_is_protected_from_gc() {
    let reuse_key = "thread:late-sidecar-gc";
    let session_id = "sess-late-sidecar-gc";
    let history = br#"{"type":"message","content":"late cached"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let sandbox = PostCopyGateSandbox::new(fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.inner.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.inner.push_copy_file_result(Ok(history.to_vec()));

    let (promoted, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            prepare_and_publish_workspace_image(&sandbox, fixture.promotion),
            async {
                sandbox.wait_for_copy().await;
                let copy_calls = sandbox.inner.copy_file_calls();
                assert_eq!(copy_calls.len(), 1);
                let tmp_path = &copy_calls[0].host_path;
                let entry_dir = tmp_path.parent().unwrap();
                assert!(tmp_path.is_file());
                assert!(entry_dir.is_dir());
                assert_eq!(mode(entry_dir.parent().unwrap()), 0o700);
                assert_eq!(mode(entry_dir), 0o700);
                assert_eq!(mode(tmp_path), 0o600);

                let freed = cache.gc(false).await.unwrap();

                assert_eq!(freed, 0);
                assert!(tmp_path.is_file());
                assert!(entry_dir.is_dir());
                sandbox.release_copy();
            },
        )
    })
    .await
    .expect("sidecar promotion and GC interleaving must complete");

    assert!(promoted);
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    let sidecar = lease
        .probe_session_history_sidecar(&restored_identity)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn session_history_sidecar_staging_cleans_source_and_unlocks_when_cancelled() {
    let reuse_key = "thread:late-sidecar-cancelled";
    let session_id = "sess-late-sidecar-cancelled";
    let history = br#"{"type":"message","content":"cancelled"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let sandbox = Arc::new(PostCopyGateSandbox::new(fixture.sandbox_id.to_string()));
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.inner.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.inner.push_copy_file_result(Ok(history.to_vec()));
    let promotion = fixture.promotion;
    let promotion_sandbox = Arc::clone(&sandbox);
    let promotion_task = tokio::spawn(async move {
        prepare_and_publish_workspace_image(promotion_sandbox.as_ref(), promotion).await
    });

    tokio::time::timeout(Duration::from_secs(5), sandbox.wait_for_copy())
        .await
        .expect("sidecar host copy must complete before cancellation");
    let copy_calls = sandbox.inner.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    let tmp_path = copy_calls[0].host_path.clone();
    assert!(tmp_path.is_file());

    promotion_task.abort();
    let join_error = promotion_task
        .await
        .expect_err("cancelled promotion task must not complete normally");

    assert!(join_error.is_cancelled());
    assert!(!tmp_path.exists());
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn session_history_sidecar_staging_cleans_source_and_unlocks_after_freeze_failure() {
    let reuse_key = "thread:late-sidecar-freeze-failure";
    let session_id = "sess-late-sidecar-freeze-failure";
    let history = br#"{"type":"message","content":"freeze"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "\"$workspace_fsfreeze_path\" --freeze".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"not mounted".to_vec(),
    });
    let sandbox =
        MockSandbox::with_overrides(fixture.sandbox_id.to_string(), Arc::clone(&overrides));
    let export_metadata = SessionHistorySidecarExportMetadata {
        timings: Default::default(),
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));

    let promoted = prepare_and_publish_workspace_image(&sandbox, fixture.promotion).await;

    assert!(!promoted);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(!copy_calls[0].host_path.exists());
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_error_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-error").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_error_abandons_consumed_cache_hit() {
    let fixture = WorkspacePromotionFixture::new_from_cache_hit("sess-hit-unpark-error").await;
    let cache = fixture.cache.clone();
    let reuse_key = fixture.reuse_key.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&cache, &reuse_key).await,
        WorkspaceCacheCheckoutResult::Miss
    );
}

#[tokio::test(flavor = "current_thread")]
async fn parked_workspace_promotion_warning_hashes_and_classifies_reuse_key() {
    for (reuse_key, expected_kind) in [
        ("thread:sensitive-promotion-17975", "thread"),
        ("opaque-sensitive-promotion-17975", "other"),
    ] {
        let fixture = WorkspacePromotionFixture::new(reuse_key).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
            transition: sandbox::SandboxIdleTransition::Unpark,
            message: "simulated unpark failure".into(),
        }));
        let mut sandbox =
            mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

        let (prepared, events) =
            capture_promotion_events(prepare_workspace_image_from_parked_sandbox(
                sandbox.as_mut(),
                Some(fixture.promotion),
                "test",
            ))
            .await;

        assert!(prepared.is_none());
        let event = captured_event(
            &events,
            "workspace image cache promotion skipped because idle sandbox unpark failed",
        );
        assert_eq!(
            event
                .fields
                .get("reuse_key_fingerprint")
                .map(String::as_str),
            Some(crate::paths::short_digest(reuse_key).as_str())
        );
        assert_eq!(
            event.fields.get("reuse_key_kind").map(String::as_str),
            Some(expected_kind)
        );
        assert!(
            event
                .fields
                .values()
                .all(|value| !value.contains(reuse_key)),
            "workspace promotion logs must not contain the raw reuse key"
        );
    }
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-panic").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_panic("simulated unpark panic");
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_guest_freeze_failure_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-freeze-fail").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "\"$workspace_fsfreeze_path\" --freeze".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"not mounted".to_vec(),
    });
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let (prepared, events) = capture_promotion_events(prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    ))
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert_eq!(overrides.exec_calls().len(), 1);
    assert!(fixture.cache.held_workspace_states().await.is_empty());
    let event = captured_event(
        &events,
        "workspace image cache promotion skipped because guest freeze failed",
    );
    assert!(
        event
            .fields
            .get("error")
            .is_some_and(|error| error.contains("not mounted"))
    );
}

#[tokio::test]
async fn parked_workspace_promotion_guest_exec_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-exec-panic").await;
    let mut sandbox = PanicExecSandbox::new("parked-exec-panic");

    let prepared =
        prepare_workspace_image_from_parked_sandbox(&mut sandbox, Some(fixture.promotion), "test")
            .await;

    assert!(prepared.is_none());
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

async fn capture_promotion_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}
