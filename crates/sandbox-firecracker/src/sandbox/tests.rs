use super::*;
use crate::api::test_support::{MockFirecrackerApi, MockRequest, MockResponse};
use crate::config::{RateLimiterConfig, TokenBucketConfig};
use guest_control_proto::{
    Decoder, ExecControlStatus, HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_EXEC_CONTROL,
    MSG_EXEC_CONTROL_RESULT, MSG_MEMORY_SNAPSHOT, MSG_MEMORY_SNAPSHOT_RESULT, MSG_PING, MSG_PONG,
    MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MemorySnapshot, RawMessage,
};
use sandbox::ExecTermination;
use std::os::unix::fs::PermissionsExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::Instant;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

mod guest_connection_timing;
mod guest_rpc;
mod private_write_diagnostics;
mod process_exit;
mod process_timeout_logging;
mod process_write;

struct TestNormalOperationFence;

fn test_severe_memory_retention_diagnostics() -> SevereMemoryRetentionDiagnostics {
    SevereMemoryRetentionDiagnostics {
        requested_target_mib: 0,
        first_observed_target_mib: None,
        observed_target_mib: None,
        target_observed: false,
        first_actual_mib: None,
        actual_mib: None,
        max_actual_mib: None,
        deficit_mib: None,
        actual_delta_mib: None,
        elapsed_ms: 0,
        sample_count: 0,
        reported_free_memory_bytes: None,
        reported_available_memory_bytes: None,
        reported_total_memory_bytes: None,
        reported_swap_in_bytes: None,
        reported_swap_out_bytes: None,
        reported_major_faults: None,
        reported_minor_faults: None,
        reported_disk_caches_bytes: None,
        guest_memory_snapshot: None,
    }
}

fn test_severe_memory_retention_outcome() -> SandboxParkOutcome {
    SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention(
        Box::new(test_severe_memory_retention_diagnostics()),
    ))
}

fn expect_severe_memory_retention(outcome: SandboxParkOutcome) -> SevereMemoryRetentionDiagnostics {
    match outcome {
        SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention(
            diagnostics,
        )) => *diagnostics,
        other => panic!("expected severe memory retention, got {other:?}"),
    }
}

#[derive(Default)]
struct RecordingFinalExecParkObserver {
    records: Vec<(SandboxFinalExecParkStage, bool)>,
    substage_records: Vec<(
        SandboxFinalExecParkSubstage,
        bool,
        Option<SandboxFinalExecParkSubstageOutcome>,
    )>,
    substage_durations: Vec<(SandboxFinalExecParkSubstage, Duration)>,
}

impl SandboxFinalExecParkObserver for RecordingFinalExecParkObserver {
    fn record_stage(
        &mut self,
        stage: SandboxFinalExecParkStage,
        _duration: Duration,
        success: bool,
    ) {
        self.records.push((stage, success));
    }

    fn record_substage(
        &mut self,
        substage: SandboxFinalExecParkSubstage,
        duration: Duration,
        success: bool,
        outcome: Option<SandboxFinalExecParkSubstageOutcome>,
    ) {
        self.substage_records.push((substage, success, outcome));
        self.substage_durations.push((substage, duration));
    }
}

async fn park_with_ready_for_park<Q, QF, P, PF>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    quiesce_guest: Q,
    park_firecracker: P,
) -> sandbox::Result<()>
where
    Q: FnOnce() -> QF,
    QF: Future<Output = io::Result<()>>,
    P: FnOnce() -> PF,
    PF: Future<Output = sandbox::Result<()>>,
{
    super::park_with_ready_for_park(
        log_id,
        coordinator,
        || async { Ok(TestNormalOperationFence) },
        quiesce_guest,
        park_firecracker,
    )
    .await
    .map(drop)
}

async fn unpark_with_ready_for_operations<U, UF, R, RF>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    unpark_firecracker: U,
    resume_guest: R,
) -> sandbox::Result<()>
where
    U: FnOnce() -> UF,
    UF: Future<Output = sandbox::Result<()>>,
    R: FnOnce() -> RF,
    RF: Future<Output = io::Result<()>>,
{
    super::unpark_with_ready_for_operations(
        log_id,
        coordinator,
        unpark_firecracker,
        resume_guest,
        || {},
    )
    .await
}

struct ExecProcessControlFixture {
    host: Arc<GuestControlClient>,
    handle: guest_control_client::SupervisedExecHandle,
    guest: UnixStream,
    exec_seq: u32,
}

fn test_sandbox_with_state(state: SandboxState) -> FirecrackerSandbox {
    let id = sandbox::SandboxId::new_v4();
    let base_dir = std::env::temp_dir().join("sandbox-firecracker-operation-entrypoint-test");
    let (state_tx, _) = watch::channel(state);

    FirecrackerSandbox {
        config: sandbox::SandboxConfig {
            id,
            resources: test_resources(),
            device_rate_limits: None,
            workspace_drive: None,
        },
        factory_config: FirecrackerConfig {
            binary_path: base_dir.join("firecracker"),
            kernel_path: base_dir.join("vmlinux"),
            rootfs_path: base_dir.join("rootfs.ext4"),
            base_dir: base_dir.clone(),
            profile: "test".into(),
            proxy_port: None,
            dns_port: None,
            snapshot: None,
        },
        id: id.to_string(),
        sandbox_paths: SandboxPaths::new(base_dir.join("workspace")),
        sock_paths: SockPaths::new(base_dir.join("sock")),
        network: SandboxNetwork {
            info: NetnsLease::new_for_test("test-ns").into_info_for_test(),
            lease: None,
        },
        cow_device: None,
        device_rate_limits: None,
        runtime: SandboxRuntimeHandles::default(),
        process_group_pid: None,
        state: Arc::new(AtomicU8::new(state as u8)),
        state_publish_lock: Arc::new(Mutex::new(())),
        state_tx,
        guest: Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>)),
        park_coordinator: ParkCoordinator::new(),
        leak_tx: None,
        delete_workspace_on_leak_cleanup: true,
        destroyed: true,
        is_parked: false,
        park_outcome: None,
        park_memory_policy: ParkMemoryPolicy::Reclaim,
        park_fence: None,
        guest_rpc_endpoint: None,
        runtime_cancel: CancellationToken::new(),
        host_cpu_cgroup: None,
    }
}

async fn connect_mock_guest(vsock_path: &str) -> UnixStream {
    let listener_path = format!("{vsock_path}_{}", guest_control_proto::VSOCK_PORT);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match UnixStream::connect(&listener_path).await {
            Ok(stream) => return stream,
            Err(error) if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline => {
                tokio::task::yield_now().await;
            }
            Err(error) => panic!("connect mock guest: {error}"),
        }
    }
}

async fn read_vsock_message(stream: &mut UnixStream) -> RawMessage {
    let mut header = [0u8; HEADER_SIZE];
    stream.read_exact(&mut header).await.unwrap();

    let body_len = u32::from_be_bytes(header) as usize;
    assert!(
        (MIN_BODY_SIZE..=MAX_MESSAGE_SIZE).contains(&body_len),
        "invalid message body length: {body_len}",
    );

    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).await.unwrap();

    RawMessage {
        msg_type: body[0],
        seq: u32::from_be_bytes(body[1..MIN_BODY_SIZE].try_into().unwrap()),
        payload: body[MIN_BODY_SIZE..].to_vec(),
    }
}

async fn mock_vsock_handshake(stream: &mut UnixStream, decoder: &mut Decoder) {
    let ready = guest_control_proto::encode(MSG_READY, 0, &[]).unwrap();
    stream.write_all(&ready).await.unwrap();

    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).await.unwrap();
    let msgs = decoder.decode(&buf[..n]).unwrap();
    assert_eq!(msgs[0].msg_type, MSG_PING);

    let pong = guest_control_proto::encode(MSG_PONG, msgs[0].seq, &[]).unwrap();
    stream.write_all(&pong).await.unwrap();
}

async fn attach_mock_shutdown_guest(sandbox: &FirecrackerSandbox) -> UnixStream {
    let temp_dir = tempfile::tempdir().unwrap();
    let vsock_path = temp_dir
        .path()
        .join("shutdown")
        .to_string_lossy()
        .into_owned();
    let wait_vsock_path = vsock_path.clone();
    let host_task = tokio::spawn(async move {
        GuestControlClient::wait_for_connection(&wait_vsock_path, Duration::from_secs(5))
            .await
            .unwrap()
    });
    let mut guest = connect_mock_guest(&vsock_path).await;
    let mut decoder = Decoder::new();
    mock_vsock_handshake(&mut guest, &mut decoder).await;
    *sandbox.guest.lock().await = Some(Arc::new(host_task.await.unwrap()));
    guest
}

async fn connected_mock_guest() -> (
    Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    UnixStream,
) {
    let temp_dir = tempfile::tempdir().unwrap();
    let vsock_path = temp_dir
        .path()
        .join("memory-snapshot")
        .to_string_lossy()
        .into_owned();
    let wait_vsock_path = vsock_path.clone();
    let host_task = tokio::spawn(async move {
        GuestControlClient::wait_for_connection(&wait_vsock_path, Duration::from_secs(5))
            .await
            .unwrap()
    });
    let mut guest = connect_mock_guest(&vsock_path).await;
    let mut decoder = Decoder::new();
    mock_vsock_handshake(&mut guest, &mut decoder).await;
    let host = Arc::new(host_task.await.unwrap());

    (Arc::new(tokio::sync::Mutex::new(Some(host))), guest)
}

fn test_guest_memory_snapshot() -> MemorySnapshot {
    MemorySnapshot {
        mem_total_bytes: 1,
        mem_free_bytes: 2,
        mem_available_bytes: 3,
        buffers_bytes: 4,
        cached_bytes: 5,
        anon_pages_bytes: 6,
        mapped_bytes: 7,
        dirty_bytes: 8,
        writeback_bytes: 9,
        shmem_bytes: 10,
        slab_bytes: 11,
        slab_reclaimable_bytes: 12,
        slab_unreclaimable_bytes: 13,
        unevictable_bytes: 14,
        kernel_stack_bytes: 15,
        page_tables_bytes: 16,
        swap_total_bytes: 17,
        swap_free_bytes: 18,
    }
}

async fn setup_exec_process_control_fixture() -> ExecProcessControlFixture {
    let temp_dir = tempfile::tempdir().unwrap();
    let vsock_path = temp_dir
        .path()
        .join("exec-process-control")
        .to_string_lossy()
        .into_owned();
    let wait_vsock_path = vsock_path.clone();
    let host_task = tokio::spawn(async move {
        GuestControlClient::wait_for_connection(&wait_vsock_path, Duration::from_secs(5))
            .await
            .unwrap()
    });
    let mut guest = connect_mock_guest(&vsock_path).await;
    let mut decoder = Decoder::new();
    mock_vsock_handshake(&mut guest, &mut decoder).await;
    let host = Arc::new(host_task.await.unwrap());

    let start_host = Arc::clone(&host);
    let start_task = tokio::spawn(async move {
        start_host
            .start_supervised_exec(SupervisedExecRequest {
                timeout_is_expected: false,
                role: guest_control_proto::ExecProcessRole::Agent,
                timeout: ExecTimeoutPolicy::Duration { timeout_ms: 60_000 },
                command: "sleep 60",
                env: &[],
                sudo: false,
                label: "sleep 60",
                stdout: ExecOutputPolicy::Discard,
                stderr: ExecOutputPolicy::Discard,
                expected_exit_codes: &[],
                stdin_bytes: None,
                control: SupervisedExecControl::Enabled { sink: true },
                stream_queue_capacity: None,
                start_timeout: Duration::from_secs(5),
            })
            .await
            .unwrap()
    });
    let start = read_vsock_message(&mut guest).await;
    assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
    let decoded_start = guest_control_proto::decode_exec_start(&start.payload).unwrap();
    assert_eq!(
        decoded_start.lifecycle,
        guest_control_proto::ExecLifecyclePolicy::Supervised
    );
    assert!(matches!(
        decoded_start.control,
        guest_control_proto::ExecControlPolicy::Enabled { sink: true, .. }
    ));

    send_agent_started_and_ready(&mut guest, start.seq, 73).await;
    let handle = start_task.await.unwrap();

    ExecProcessControlFixture {
        host,
        handle,
        guest,
        exec_seq: start.seq,
    }
}

fn running_process_state() -> (Arc<AtomicU8>, watch::Sender<SandboxState>) {
    process_state(SandboxState::Running)
}

fn process_state(sandbox_state: SandboxState) -> (Arc<AtomicU8>, watch::Sender<SandboxState>) {
    let state = Arc::new(AtomicU8::new(sandbox_state as u8));
    let (state_tx, _state_rx) = watch::channel(sandbox_state);
    (state, state_tx)
}

fn state_after_first_read(next_state: SandboxState) -> impl Fn() -> SandboxState {
    let reads = std::sync::atomic::AtomicUsize::new(0);
    move || {
        if reads.fetch_add(1, Ordering::SeqCst) == 0 {
            SandboxState::Running
        } else {
            next_state
        }
    }
}

#[test]
fn process_control_stop_after_policy_check_keeps_policy_open() {
    let coordinator = ParkCoordinator::new();

    let error = match FirecrackerSandbox::begin_process_control(
        &coordinator,
        state_after_first_read(SandboxState::Stopped),
    ) {
        Ok(_) => panic!("expected process control boundary to reject stopped state"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        GuestOperationStartError::NotRunning {
            state: SandboxState::Stopped
        }
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[test]
fn process_control_crash_after_policy_check_keeps_policy_open() {
    let coordinator = ParkCoordinator::new();

    let error = match FirecrackerSandbox::begin_process_control(
        &coordinator,
        state_after_first_read(SandboxState::Crashed),
    ) {
        Ok(_) => panic!("expected process control boundary to reject crashed state"),
        Err(error) => error,
    };

    assert_eq!(error, GuestOperationStartError::BackendCrashed);
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

async fn send_exec_control_result(
    stream: &mut UnixStream,
    request: RawMessage,
    status: ExecControlStatus,
    diagnostic: &str,
) {
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);
    let decoded = guest_control_proto::decode_exec_control(&request.payload).unwrap();
    let payload = guest_control_proto::encode_exec_control_result(
        decoded.target_seq,
        decoded.control_nonce,
        decoded.message_id,
        status,
        diagnostic,
    )
    .unwrap();
    let response =
        guest_control_proto::encode(MSG_EXEC_CONTROL_RESULT, request.seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

async fn send_exec_control_error(stream: &mut UnixStream, request: RawMessage, message: &str) {
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);
    let payload = guest_control_proto::encode_error(message);
    let response =
        guest_control_proto::encode(guest_control_proto::MSG_ERROR, request.seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

async fn send_mismatched_exec_control_result(stream: &mut UnixStream, request: RawMessage) {
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);
    let decoded = guest_control_proto::decode_exec_control(&request.payload).unwrap();
    let payload = guest_control_proto::encode_exec_control_result(
        decoded.target_seq + 1,
        decoded.control_nonce,
        decoded.message_id,
        ExecControlStatus::Delivered,
        "",
    )
    .unwrap();
    let response =
        guest_control_proto::encode(MSG_EXEC_CONTROL_RESULT, request.seq, &payload).unwrap();
    stream.write_all(&response).await.unwrap();
}

fn expect_process_control_delivered(outcome: ProcessControlOutcome) -> ProcessControlAck {
    match outcome {
        ProcessControlOutcome::Delivered(ack) => ack,
        other => panic!("expected delivered process-control outcome, got {other:?}"),
    }
}

fn expect_process_control_failure(
    outcome: ProcessControlOutcome,
    expected_kind: ProcessControlFailureKind,
    expected_write_state: ProcessControlWriteState,
) -> io::Error {
    match outcome {
        ProcessControlOutcome::Failed {
            kind,
            write_state,
            error,
        } => {
            assert_eq!(kind, expected_kind);
            assert_eq!(write_state, expected_write_state);
            error
        }
        other => panic!("expected failed process-control outcome, got {other:?}"),
    }
}

fn assert_process_control_guest_status(
    outcome: &ProcessControlOutcome,
    expected_status: ProcessControlGuestStatus,
    expected_diagnostic: &str,
) {
    assert!(
        matches!(
            outcome,
            ProcessControlOutcome::GuestStatus { status, diagnostic }
                if *status == expected_status && diagnostic == expected_diagnostic
        ),
        "unexpected process-control outcome: {outcome:?}",
    );
}

async fn send_exec_exit(stream: &mut UnixStream, exec_seq: u32) {
    let payload = guest_control_proto::encode_exec_result(
        guest_control_proto::ExecTermination::Exited { exit_code: 0 },
        1,
        guest_control_proto::ExecCapturedOutput::Discarded,
        guest_control_proto::ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    let response =
        guest_control_proto::encode(guest_control_proto::MSG_EXEC_RESULT, exec_seq, &payload)
            .unwrap();
    stream.write_all(&response).await.unwrap();
}

async fn send_exec_started(stream: &mut UnixStream, exec_seq: u32, pid: u32) {
    let started = guest_control_proto::encode_exec_started(pid).unwrap();
    let started =
        guest_control_proto::encode(guest_control_proto::MSG_EXEC_STARTED, exec_seq, &started)
            .unwrap();
    stream.write_all(&started).await.unwrap();
}

async fn send_agent_started_and_ready(stream: &mut UnixStream, exec_seq: u32, pid: u32) {
    send_exec_started(stream, exec_seq, pid).await;
    let ready =
        guest_control_proto::encode_exec_agent_ready(guest_control_proto::ExecAgentReadyTiming {
            containment_create_us: 11,
            placement_broker_setup_us: 12,
            shell_spawn_us: 13,
            bootstrap_ready_wait_us: 14,
        });
    let ready =
        guest_control_proto::encode(guest_control_proto::MSG_EXEC_AGENT_READY, exec_seq, &ready)
            .unwrap();
    stream.write_all(&ready).await.unwrap();
}

fn monitored_cat_process() -> process_launch::asynchronous::Child {
    tokio::process::Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
        .into()
}

fn monitored_cat_process_without_log_pipes() -> process_launch::asynchronous::Child {
    tokio::process::Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
        .into()
}

fn stdout_stderr_writing_process() -> process_launch::asynchronous::Child {
    tokio::process::Command::new("bash")
        .args(["-c", "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
        .into()
}

fn stdout_closing_process() -> process_launch::asynchronous::Child {
    tokio::process::Command::new("bash")
        .args(["-c", "exec 1>&-; sleep 60"])
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
        .into()
}

fn parent_exits_with_child_process(
    pid_file: &std::path::Path,
) -> process_launch::asynchronous::Child {
    tokio::process::Command::new("bash")
        .args([
            "-c",
            "trap '' HUP; sleep 60 & echo $! > \"$1\"; exit 1",
            "_",
        ])
        .arg(pid_file)
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
        .into()
}

struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for DropNotify {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

fn pending_log_reader_for_test() -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _notify = DropNotify(Some(dropped_tx));
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    (handle, started_rx, dropped_rx)
}

fn test_resources() -> sandbox::ResourceLimits {
    sandbox::ResourceLimits {
        cpu_count: 2,
        memory_mb: 4096,
    }
}

fn test_rate_limits() -> FirecrackerDeviceRateLimits {
    FirecrackerDeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 10_240,
            ops_per_sec: 100,
        },
        net_rx: RateLimiterConfig {
            bandwidth: Some(TokenBucketConfig {
                size: 2048,
                refill_time: 100,
            }),
            ops: None,
        },
        net_tx: RateLimiterConfig {
            bandwidth: Some(TokenBucketConfig {
                size: 4096,
                refill_time: 100,
            }),
            ops: None,
        },
    }
}

fn fresh_boot_config_json(
    workspace_device_path: Option<String>,
    rate_limits: Option<&FirecrackerDeviceRateLimits>,
) -> serde_json::Value {
    let invariant = InvariantConfig::new();
    let config = build_fresh_boot_firecracker_config(
        &invariant,
        &test_resources(),
        "/kernel".to_string(),
        "/dev/nbd0".to_string(),
        workspace_device_path,
        "/run/vsock.sock".to_string(),
        rate_limits,
    )
    .unwrap();
    serde_json::to_value(config).unwrap()
}

#[test]
fn fresh_boot_config_omits_rate_limiters_when_disabled() {
    let config = fresh_boot_config_json(None, None);

    assert!(config["drives"][0].get("rate_limiter").is_none());
    assert!(
        config["network-interfaces"][0]
            .get("rx_rate_limiter")
            .is_none()
    );
    assert!(
        config["network-interfaces"][0]
            .get("tx_rate_limiter")
            .is_none()
    );
}

#[test]
fn fresh_boot_config_includes_rate_limiters_when_enabled() {
    let rate_limits = test_rate_limits();
    let config = fresh_boot_config_json(None, Some(&rate_limits));

    assert_eq!(
        config["drives"][0]["rate_limiter"],
        serde_json::json!({
            "bandwidth": { "size": 1024, "refill_time": 100 },
            "ops": { "size": 10, "refill_time": 100 },
        })
    );
    assert_eq!(
        config["network-interfaces"][0]["rx_rate_limiter"],
        serde_json::json!({
            "bandwidth": { "size": 2048, "refill_time": 100 },
        })
    );
    assert_eq!(
        config["network-interfaces"][0]["tx_rate_limiter"],
        serde_json::json!({
            "bandwidth": { "size": 4096, "refill_time": 100 },
        })
    );
}

#[test]
fn fresh_boot_config_includes_workspace_drive_without_rate_limiters() {
    let config = fresh_boot_config_json(Some("/workspaces/test/workspace.ext4".to_string()), None);

    assert_eq!(config["drives"][0]["drive_id"], "rootfs");
    assert_eq!(config["drives"][1]["drive_id"], "workspace");
    assert_eq!(
        config["drives"][1]["path_on_host"],
        "/workspaces/test/workspace.ext4"
    );
    assert_eq!(config["drives"][1]["is_root_device"], false);
    assert_eq!(config["drives"][1]["is_read_only"], false);
    assert!(config["drives"][0].get("rate_limiter").is_none());
    assert!(config["drives"][1].get("rate_limiter").is_none());
}

#[test]
fn fresh_boot_config_includes_workspace_drive_and_splits_block_limiters() {
    let rate_limits = test_rate_limits();
    let config = fresh_boot_config_json(
        Some("/workspaces/test/workspace.ext4".to_string()),
        Some(&rate_limits),
    );

    assert_eq!(config["drives"][0]["drive_id"], "rootfs");
    assert_eq!(config["drives"][1]["drive_id"], "workspace");
    assert_eq!(
        config["drives"][1]["path_on_host"],
        "/workspaces/test/workspace.ext4"
    );
    assert_eq!(config["drives"][1]["is_root_device"], false);
    assert_eq!(config["drives"][1]["is_read_only"], false);
    assert_eq!(
        config["drives"][0]["rate_limiter"]["bandwidth"]["size"],
        512
    );
    assert_eq!(
        config["drives"][1]["rate_limiter"]["bandwidth"]["size"],
        512
    );
}

fn stdout_eof_notifying_log_reader_for_test<R>(
    id: &str,
    reader: R,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Receiver<()>,
)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let id = id.to_owned();
    let (eof_tx, eof_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        if read_process_log_records(reader, |record| {
            ProcessLogStream::Stdout.log(&id, record);
        })
        .await
        .is_ok()
        {
            let _ = eof_tx.send(());
        }
    });
    (handle, eof_rx)
}

fn pid_is_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, after_comm)) = stat.rsplit_once(") ") else {
        return false;
    };
    !after_comm.starts_with('Z')
}

async fn wait_for_pid_not_running(pid: u32) -> bool {
    tokio::time::timeout(Duration::from_secs(1), async {
        while pid_is_running(pid) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

async fn wait_for_state(state: &AtomicU8, expected: SandboxState) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while SandboxState::from_u8(state.load(Ordering::Acquire)) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_path_removed(path: &Path) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn assert_idle_transition<T: std::fmt::Debug>(
    result: sandbox::Result<T>,
    expected: SandboxIdleTransition,
) {
    match result {
        Err(SandboxError::IdleTransition { transition, .. }) => {
            assert_eq!(transition, expected);
        }
        other => panic!("expected {expected} idle transition error, got {other:?}"),
    }
}

fn assert_idle_transition_message<T: std::fmt::Debug>(
    result: sandbox::Result<T>,
    expected_transition: SandboxIdleTransition,
    expected_message: &str,
) {
    match result {
        Err(SandboxError::IdleTransition {
            transition,
            message,
        }) => {
            assert_eq!(transition, expected_transition);
            assert_eq!(message, expected_message);
        }
        other => panic!(
            "expected {expected_transition} idle transition error with message \
             {expected_message:?}, got {other:?}"
        ),
    }
}

fn assert_operation_error(
    error: SandboxError,
    expected_operation: SandboxOperation,
    expected_reason: SandboxOperationReason,
) {
    match error {
        SandboxError::Operation {
            operation, reason, ..
        } => {
            assert_eq!(operation, expected_operation);
            assert_eq!(reason, expected_reason);
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

fn assert_invalid_state_operation(
    error: SandboxError,
    expected_operation: SandboxOperation,
    expected_state: &str,
) {
    match error {
        SandboxError::InvalidState { context, state, .. } => {
            assert_eq!(
                context,
                SandboxInvalidStateContext::Operation(expected_operation)
            );
            assert_eq!(state, expected_state);
        }
        other => panic!("expected invalid state error, got {other:?}"),
    }
}

async fn assert_file_entrypoints_invalid_state(sandbox: &FirecrackerSandbox, expected_state: &str) {
    let read_err = sandbox
        .read_file("/tmp/system.log", 1024)
        .await
        .unwrap_err();
    assert_invalid_state_operation(read_err, SandboxOperation::ReadFile, expected_state);

    let copy_err = sandbox
        .copy_file(
            "/tmp/system.log",
            Path::new("unused-copy-target"),
            CopyFileOptions {
                max_bytes: 1024,
                timeout: Duration::from_secs(5),
                missing_ok: false,
            },
        )
        .await
        .unwrap_err();
    assert_invalid_state_operation(copy_err, SandboxOperation::CopyFile, expected_state);
}

fn mark_coordinator_parked(coordinator: &ParkCoordinator) {
    let attempt = coordinator
        .begin_prepare_park()
        .expect("begin prepare park");
    coordinator
        .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced)
        .expect("complete prepare park");
    coordinator.mark_parked(&attempt).expect("mark parked");
}

fn event_log() -> Arc<Mutex<Vec<&'static str>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn logged_events(events: &Arc<Mutex<Vec<&'static str>>>) -> Vec<&'static str> {
    events.lock().unwrap().clone()
}

#[derive(Debug)]
struct RecordedFence {
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl Drop for RecordedFence {
    fn drop(&mut self) {
        self.events.lock().unwrap().push("release_fence");
    }
}

struct ClosingStateFence {
    coordinator: ParkCoordinator,
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl Drop for ClosingStateFence {
    fn drop(&mut self) {
        assert!(matches!(
            self.coordinator.state(),
            CoordinatorState::ClosingForPark { .. }
        ));
        self.events.lock().unwrap().push("release_fence");
    }
}

#[test]
fn termination_releases_park_fence_and_clears_parked_flag() {
    let events = event_log();
    let mut is_parked = true;
    let mut park_outcome = Some(SandboxParkOutcome::Reusable);
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });

    release_park_state_for_termination(&mut is_parked, &mut park_outcome, &mut fence);

    assert!(!is_parked);
    assert!(park_outcome.is_none());
    assert!(fence.is_none());
    assert_eq!(logged_events(&events), vec!["release_fence"]);
}

#[test]
fn park_noop_with_parked_gate_succeeds() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);

    ensure_park_noop_state(&coordinator).unwrap();
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[test]
fn park_noop_reports_dirty_gate_instead_of_succeeding() {
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("mark parked failed"));

    assert_idle_transition(
        ensure_park_noop_state(&coordinator),
        SandboxIdleTransition::Park,
    );
}

#[test]
fn park_noop_with_open_gate_marks_dirty() {
    let coordinator = ParkCoordinator::new();

    assert_idle_transition(
        ensure_park_noop_state(&coordinator),
        SandboxIdleTransition::Park,
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_quiesces_before_firecracker_park() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let park_state = coordinator.clone();

    park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            assert!(matches!(
                park_state.state(),
                CoordinatorState::ReadyForPark { .. }
            ));
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["guest_quiesce", "firecracker_park"]
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn ready_for_park_boundary_preserves_non_reusable_outcome() {
    let coordinator = ParkCoordinator::new();

    let (_fence, outcome) = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async { Ok(TestNormalOperationFence) },
        || async { Ok(()) },
        || async { Ok(test_severe_memory_retention_outcome()) },
    )
    .await
    .unwrap();

    assert_eq!(outcome, test_severe_memory_retention_outcome());
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn final_preparation_runs_after_operation_admission_closes() {
    let coordinator = ParkCoordinator::new();
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let operation_gate = GuestOperationStartGate::new(guest, coordinator.clone());
    let (preparation_entered_tx, preparation_entered_rx) = tokio::sync::oneshot::channel();
    let (release_preparation_tx, release_preparation_rx) = tokio::sync::oneshot::channel();

    let transition = super::park_with_ready_for_park_and_preparation(
        "test-sandbox",
        &coordinator,
        || async move {
            preparation_entered_tx.send(()).unwrap();
            release_preparation_rx.await.unwrap();
            Ok((TestNormalOperationFence, "prepared"))
        },
        || async { Ok(()) },
        || async { Ok(SandboxParkOutcome::Reusable) },
    );
    tokio::pin!(transition);

    tokio::select! {
        _ = &mut transition => panic!("park completed before final preparation was released"),
        result = preparation_entered_rx => result.unwrap(),
    }

    assert!(matches!(
        operation_gate
            .begin_sandbox_operation(|| SandboxState::Running)
            .await,
        Err(GuestOperationStartError::GateClosed { .. })
    ));
    assert!(matches!(
        operation_gate.begin_control_operation().await,
        Err(GuestOperationStartError::GateClosed { .. })
    ));

    release_preparation_tx.send(()).unwrap();
    let (_fence, outcome, preparation) = transition.await.unwrap();
    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    assert_eq!(preparation, "prepared");
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn final_preparation_transport_failure_marks_dirty_without_quiesce_or_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park_and_preparation(
        "test-sandbox",
        &coordinator,
        || async {
            Err::<(TestNormalOperationFence, ()), _>(ParkNormalOperationFenceError::FinalOperation(
                io::Error::new(io::ErrorKind::ConnectionReset, "final exec disconnected"),
            ))
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(SandboxParkOutcome::Reusable)
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn final_exec_park_observer_reports_completed_stages_in_order() {
    let coordinator = ParkCoordinator::new();
    let mut observer = RecordingFinalExecParkObserver::default();

    super::park_with_ready_for_park_and_preparation_with_observer(
        "test-sandbox",
        &coordinator,
        Some(&mut observer),
        || async { Ok((TestNormalOperationFence, "prepared")) },
        || async { Ok(()) },
        |_timing, events| async {
            (
                _timing,
                events,
                Ok::<SandboxParkOutcome, sandbox::SandboxError>(SandboxParkOutcome::Reusable),
            )
        },
    )
    .await
    .unwrap();

    assert_eq!(
        observer.records,
        vec![
            (SandboxFinalExecParkStage::ReusePreparation, true),
            (SandboxFinalExecParkStage::PhysicalPark, true),
        ]
    );
}

#[tokio::test]
async fn final_exec_park_observer_reports_preparation_failure_only() {
    let coordinator = ParkCoordinator::new();
    let mut observer = RecordingFinalExecParkObserver::default();

    let result = super::park_with_ready_for_park_and_preparation_with_observer(
        "test-sandbox",
        &coordinator,
        Some(&mut observer),
        || async {
            Err::<(TestNormalOperationFence, ()), _>(ParkNormalOperationFenceError::FinalOperation(
                io::Error::new(io::ErrorKind::ConnectionReset, "final exec disconnected"),
            ))
        },
        || async { Ok(()) },
        |_timing, events| async {
            (
                _timing,
                events,
                Ok::<SandboxParkOutcome, sandbox::SandboxError>(SandboxParkOutcome::Reusable),
            )
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(
        observer.records,
        vec![(SandboxFinalExecParkStage::ReusePreparation, false)]
    );
}

#[tokio::test]
async fn final_exec_park_observer_reports_physical_park_failure() {
    let coordinator = ParkCoordinator::new();
    let mut observer = RecordingFinalExecParkObserver::default();

    let result = super::park_with_ready_for_park_and_preparation_with_observer(
        "test-sandbox",
        &coordinator,
        Some(&mut observer),
        || async { Ok((TestNormalOperationFence, ())) },
        || async { Ok(()) },
        |_timing, events| async {
            (
                _timing,
                events,
                Err::<SandboxParkOutcome, _>(idle_transition_error(
                    SandboxIdleTransition::Park,
                    "physical park failed",
                )),
            )
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(
        observer.records,
        vec![
            (SandboxFinalExecParkStage::ReusePreparation, true),
            (SandboxFinalExecParkStage::PhysicalPark, false),
        ]
    );
}

#[tokio::test]
async fn final_exec_park_observer_keeps_completed_substage_on_cancellation() {
    let coordinator = ParkCoordinator::new();
    let mut observer = RecordingFinalExecParkObserver::default();
    let (substage_started_tx, substage_started_rx) = tokio::sync::oneshot::channel();
    let (_release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

    {
        let transition = super::park_with_ready_for_park_and_preparation_with_observer(
            "test-sandbox",
            &coordinator,
            Some(&mut observer),
            || async { Ok((TestNormalOperationFence, ())) },
            || async { Ok(()) },
            |timing, mut events| async move {
                events.record(
                    SandboxFinalExecParkSubstage::BalloonSetup,
                    Duration::from_millis(1),
                    true,
                    None,
                );
                let _ = substage_started_tx.send(());
                release_rx.await.unwrap();
                (
                    timing,
                    events,
                    Ok::<SandboxParkOutcome, sandbox::SandboxError>(SandboxParkOutcome::Reusable),
                )
            },
        );
        tokio::pin!(transition);

        tokio::select! {
            _result = &mut transition => panic!("park completed unexpectedly"),
            result = substage_started_rx => result.unwrap(),
        }
    }

    assert_eq!(
        observer.substage_records,
        vec![(SandboxFinalExecParkSubstage::BalloonSetup, true, None)]
    );
    assert_eq!(
        observer.substage_durations,
        vec![(
            SandboxFinalExecParkSubstage::BalloonSetup,
            Duration::from_millis(1)
        )]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_fences_before_quiesce_and_holds_until_returned() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let fence = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "firecracker_park"]
    );
    drop(fence);
    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
}

#[test]
fn ready_for_park_boundary_cancel_after_fence_releases_before_reopening_gate() {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator.begin_prepare_park().unwrap();
    let events = event_log();
    let mut guard = ParkBoundaryGuard::new(coordinator.clone(), attempt);

    guard.mark_normal_operations_fenced(ClosingStateFence {
        coordinator: coordinator.clone(),
        events: Arc::clone(&events),
    });
    drop(guard);

    assert_eq!(logged_events(&events), vec!["release_fence"]);
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[test]
fn ready_for_park_boundary_missing_fence_marks_dirty_after_ready_for_park() {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator.begin_prepare_park().unwrap();
    let mut guard: ParkBoundaryGuard<RecordedFence> =
        ParkBoundaryGuard::new(coordinator.clone(), attempt);

    guard.complete_prepare().unwrap();
    let error = guard.mark_parked().unwrap_err();

    assert!(matches!(error, PrepareParkError::Dirty { .. }));
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_busy_fence_aborts_without_dirtying() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Err::<RecordedFence, _>(ParkNormalOperationFenceError::Rejected(
                NormalOperationFenceRejection::Busy,
            ))
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert_eq!(logged_events(&events), vec!["fence"]);
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[tokio::test]
async fn ready_for_park_boundary_not_parkable_fence_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async {
            Err::<RecordedFence, _>(ParkNormalOperationFenceError::Rejected(
                NormalOperationFenceRejection::NotParkable,
            ))
        },
        || async { Ok(()) },
        || async { Ok(()) },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_guest_unavailable_fence_marks_dirty_without_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async {
            Err::<RecordedFence, _>(ParkNormalOperationFenceError::GuestUnavailable(
                io::Error::new(io::ErrorKind::NotConnected, "guest missing"),
            ))
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_dirty_prevents_quiesce_and_pause() {
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("test dirty"));
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(logged_events(&events).is_empty());
}

#[tokio::test]
async fn ready_for_park_boundary_invalid_state_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(logged_events(&events).is_empty());
}

#[tokio::test]
async fn ready_for_park_boundary_quiesce_failure_marks_dirty_without_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Err(io::Error::new(io::ErrorKind::TimedOut, "quiesce timeout"))
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "release_fence"]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_complete_prepare_failure_marks_dirty_without_pause() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let quiesce_state = coordinator.clone();

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            quiesce_state.mark_dirty(DirtyReason::new("operation dropped during quiesce"));
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "release_fence"]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_firecracker_failure_after_quiesce_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            Err::<(), _>(idle_transition_error(
                SandboxIdleTransition::Park,
                "pause failed",
            ))
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_mark_parked_failure_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let park_state = coordinator.clone();

    let result = super::park_with_ready_for_park(
        "test-sandbox",
        &coordinator,
        || async move {
            fence_events.lock().unwrap().push("fence");
            Ok(RecordedFence {
                events: Arc::clone(&fence_events),
            })
        },
        || async move {
            quiesce_events.lock().unwrap().push("guest_quiesce");
            Ok(())
        },
        || async move {
            park_events.lock().unwrap().push("firecracker_park");
            park_state.mark_dirty(DirtyReason::new("mark parked race"));
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result.map(drop), SandboxIdleTransition::Park);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
}

#[tokio::test]
async fn ready_for_park_boundary_cancel_during_guest_quiesce_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let (quiesce_started_tx, quiesce_started_rx) = tokio::sync::oneshot::channel();

    {
        let park = super::park_with_ready_for_park(
            "test-sandbox",
            &coordinator,
            || async move {
                fence_events.lock().unwrap().push("fence");
                Ok(RecordedFence {
                    events: Arc::clone(&fence_events),
                })
            },
            || async move {
                quiesce_events.lock().unwrap().push("guest_quiesce");
                let _ = quiesce_started_tx.send(());
                std::future::pending::<io::Result<()>>().await
            },
            || async { Ok(()) },
        );
        tokio::pin!(park);

        tokio::select! {
            result = &mut park => panic!("park completed unexpectedly: {result:?}"),
            result = quiesce_started_rx => result.unwrap(),
        }
    }

    assert_eq!(
        logged_events(&events),
        vec!["fence", "guest_quiesce", "release_fence"]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_park_boundary_cancel_after_ready_for_park_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let fence_events = Arc::clone(&events);
    let quiesce_events = Arc::clone(&events);
    let park_events = Arc::clone(&events);
    let (park_started_tx, park_started_rx) = tokio::sync::oneshot::channel();

    {
        let park = super::park_with_ready_for_park(
            "test-sandbox",
            &coordinator,
            || async move {
                fence_events.lock().unwrap().push("fence");
                Ok(RecordedFence {
                    events: Arc::clone(&fence_events),
                })
            },
            || async move {
                quiesce_events.lock().unwrap().push("guest_quiesce");
                Ok(())
            },
            || async move {
                park_events.lock().unwrap().push("firecracker_park");
                let _ = park_started_tx.send(());
                std::future::pending::<sandbox::Result<()>>().await
            },
        );
        tokio::pin!(park);

        tokio::select! {
            result = &mut park => panic!("park completed unexpectedly: {result:?}"),
            result = park_started_rx => result.unwrap(),
        }
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { .. }
        ));
    }

    assert_eq!(
        logged_events(&events),
        vec![
            "fence",
            "guest_quiesce",
            "firecracker_park",
            "release_fence"
        ]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_resumes_firecracker_before_guest_and_reopens() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let resume_state = coordinator.clone();

    unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            assert!(matches!(resume_state.state(), CoordinatorState::Parked));
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume"]
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[tokio::test]
async fn ready_for_operations_boundary_releases_fence_before_reopening_gate() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let release_events = Arc::clone(&events);
    let release_state = coordinator.clone();

    super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
        || {
            assert!(matches!(release_state.state(), CoordinatorState::Parked));
            release_events.lock().unwrap().push("release_fence");
        },
    )
    .await
    .unwrap();

    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume", "release_fence"]
    );
    assert!(matches!(coordinator.state(), CoordinatorState::Open));
}

#[tokio::test]
async fn ready_for_operations_boundary_firecracker_failure_does_not_resume_guest() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                "resume failed",
            ))
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
        || {
            drop(fence.take());
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(fence.is_some());
    assert_eq!(logged_events(&events), vec!["firecracker_unpark"]);
    assert!(matches!(coordinator.state(), CoordinatorState::Parked));
}

#[tokio::test]
async fn ready_for_operations_boundary_guest_resume_failure_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "resume failed",
            ))
        },
        || {
            drop(fence.take());
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(fence.is_some());
    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume"]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_dirty_state_does_not_resume_firecracker() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    coordinator.mark_dirty(DirtyReason::new("park completion failed"));
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_cancel_after_firecracker_resume_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let (resume_started_tx, resume_started_rx) = tokio::sync::oneshot::channel();

    {
        let unpark = unpark_with_ready_for_operations(
            "test-sandbox",
            &coordinator,
            || async { Ok(()) },
            || async move {
                let _ = resume_started_tx.send(());
                std::future::pending::<io::Result<()>>().await
            },
        );
        tokio::pin!(unpark);

        tokio::select! {
            result = &mut unpark => panic!("unpark completed unexpectedly: {result:?}"),
            result = resume_started_rx => result.unwrap(),
        }
    }

    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_cancel_during_firecracker_unpark_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let (firecracker_started_tx, firecracker_started_rx) = tokio::sync::oneshot::channel();

    {
        let unpark = unpark_with_ready_for_operations(
            "test-sandbox",
            &coordinator,
            || async move {
                firecracker_events
                    .lock()
                    .unwrap()
                    .push("firecracker_unpark");
                let _ = firecracker_started_tx.send(());
                std::future::pending::<sandbox::Result<()>>().await
            },
            || async move {
                resume_events.lock().unwrap().push("guest_resume");
                Ok(())
            },
        );
        tokio::pin!(unpark);

        tokio::select! {
            result = &mut unpark => panic!("unpark completed unexpectedly: {result:?}"),
            result = firecracker_started_rx => result.unwrap(),
        }
    }

    assert_eq!(logged_events(&events), vec!["firecracker_unpark"]);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_cancel_during_firecracker_unpark_keeps_fence() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let mut fence = Some(RecordedFence {
        events: Arc::clone(&events),
    });
    let (firecracker_started_tx, firecracker_started_rx) = tokio::sync::oneshot::channel();

    {
        let unpark = super::unpark_with_ready_for_operations(
            "test-sandbox",
            &coordinator,
            || async move {
                let _ = firecracker_started_tx.send(());
                std::future::pending::<sandbox::Result<()>>().await
            },
            || async { Ok(()) },
            || {
                drop(fence.take());
            },
        );
        tokio::pin!(unpark);

        tokio::select! {
            result = &mut unpark => panic!("unpark completed unexpectedly: {result:?}"),
            result = firecracker_started_rx => result.unwrap(),
        }
    }

    assert!(fence.is_some());
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_invalid_state_marks_dirty_without_resume() {
    let coordinator = ParkCoordinator::new();
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);

    let result = unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            Ok(())
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(logged_events(&events).is_empty());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[tokio::test]
async fn ready_for_operations_boundary_reopen_failure_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);
    let events = event_log();
    let firecracker_events = Arc::clone(&events);
    let resume_events = Arc::clone(&events);
    let release_events = Arc::clone(&events);
    let resume_state = coordinator.clone();

    let result = super::unpark_with_ready_for_operations(
        "test-sandbox",
        &coordinator,
        || async move {
            firecracker_events
                .lock()
                .unwrap()
                .push("firecracker_unpark");
            Ok(())
        },
        || async move {
            resume_events.lock().unwrap().push("guest_resume");
            resume_state.mark_dirty(DirtyReason::new("reopen race"));
            Ok(())
        },
        || {
            release_events.lock().unwrap().push("release_fence");
        },
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert_eq!(
        logged_events(&events),
        vec!["firecracker_unpark", "guest_resume", "release_fence"]
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[test]
fn unpark_noop_reports_dirty_gate_instead_of_succeeding() {
    let coordinator = ParkCoordinator::new();
    coordinator.mark_dirty(DirtyReason::new("resume failed"));

    assert_idle_transition(
        ensure_unpark_noop_state(&coordinator),
        SandboxIdleTransition::Unpark,
    );
}

#[test]
fn unpark_noop_with_closed_gate_marks_dirty() {
    let coordinator = ParkCoordinator::new();
    mark_coordinator_parked(&coordinator);

    assert_idle_transition(
        ensure_unpark_noop_state(&coordinator),
        SandboxIdleTransition::Unpark,
    );
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
}

#[test]
fn operation_error_classifies_io_timeout() {
    let err = FirecrackerSandbox::operation_error(
        SandboxOperation::WaitProcess,
        io::Error::new(io::ErrorKind::TimedOut, "wait timeout"),
        false,
    );

    assert_operation_error(
        err,
        SandboxOperation::WaitProcess,
        SandboxOperationReason::Timeout,
    );
}

#[test]
fn operation_error_preserves_typed_request_timeout_stage() {
    let timeout = guest_control_client::RequestTimeoutError::new(
        guest_control_client::RequestTimeoutStage::AwaitingTerminalResponse,
        Duration::from_secs(60),
    );
    let err = FirecrackerSandbox::operation_error(
        SandboxOperation::WriteFile,
        io::Error::new(io::ErrorKind::TimedOut, timeout),
        false,
    );

    match err {
        SandboxError::OperationTimeout {
            operation,
            stage,
            timeout_ms,
        } => {
            assert_eq!(operation, SandboxOperation::WriteFile);
            assert_eq!(
                stage,
                sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse
            );
            assert_eq!(timeout_ms, 60_000);
        }
        other => panic!("expected typed operation timeout, got {other:?}"),
    }
}

#[test]
fn operation_error_classifies_non_timeout_as_guest() {
    let err = FirecrackerSandbox::operation_error(
        SandboxOperation::Exec,
        io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
        false,
    );

    assert_operation_error(err, SandboxOperation::Exec, SandboxOperationReason::Guest);
}

#[test]
fn invalid_exec_env_key_returns_operation_error() {
    let err =
        FirecrackerSandbox::validate_exec_env_keys(SandboxOperation::Exec, &[("BAD-NAME", "x")])
            .unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::Exec);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("BAD-NAME"), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[test]
fn invalid_start_process_env_key_returns_operation_error() {
    let err = FirecrackerSandbox::validate_exec_env_keys(
        SandboxOperation::StartProcess,
        &[("1BAD", "x")],
    )
    .unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::StartProcess);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("1BAD"), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[tokio::test]
async fn start_process_output_rejects_invalid_stream_configuration() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let guest = attach_mock_shutdown_guest(&sandbox).await;

    for (output, expected_message) in [
        (
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 0,
                queue_capacity: 1,
                stderr_capture_limit_bytes: None,
            },
            "process stream chunk limit must be positive",
        ),
        (
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
                queue_capacity: 0,
                stderr_capture_limit_bytes: None,
            },
            "process stream queue capacity must be positive",
        ),
        (
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
                queue_capacity: ProcessOutputMode::MAX_QUEUE_CAPACITY + 1,
                stderr_capture_limit_bytes: None,
            },
            "process stream queue capacity must be at most 8192",
        ),
    ] {
        let error = match sandbox
            .start_process(&StartProcessRequest {
                timeout_is_expected: false,
                cmd: "agent",
                start_timeout: sandbox::DEFAULT_PROCESS_START_TIMEOUT,
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output,
            })
            .await
        {
            Ok(_) => panic!("invalid stream configuration should be rejected"),
            Err(error) => error,
        };
        let message = error.to_string();

        assert_operation_error(
            error,
            SandboxOperation::StartProcess,
            SandboxOperationReason::Other,
        );
        assert!(message.contains(expected_message), "got: {message}");

        let mut unexpected_frame = [0u8; 1];
        let read_error = guest.try_read(&mut unexpected_frame).unwrap_err();
        assert_eq!(read_error.kind(), io::ErrorKind::WouldBlock);
    }
}

#[tokio::test]
async fn start_process_output_accepts_maximum_queue_capacity() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let output = ProcessOutputMode::Stream {
        stream_limit_bytes: 0,
        chunk_limit_bytes: 16,
        queue_capacity: ProcessOutputMode::MAX_QUEUE_CAPACITY,
        stderr_capture_limit_bytes: None,
    };
    let request = StartProcessRequest {
        timeout_is_expected: false,
        cmd: "agent",
        start_timeout: sandbox::DEFAULT_PROCESS_START_TIMEOUT,
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        output,
    };

    let start_process = sandbox.start_process(&request);
    let acknowledge_start = async {
        let start = read_vsock_message(&mut guest).await;
        assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
        let decoded = guest_control_proto::decode_exec_start(&start.payload).unwrap();
        assert_eq!(decoded.role, guest_control_proto::ExecProcessRole::Workload);
        assert_eq!(
            decoded.control,
            guest_control_proto::ExecControlPolicy::Disabled
        );
        assert_eq!(
            decoded.stdout,
            ExecOutputPolicy::Stream {
                limit_bytes: 0,
                chunk_limit_bytes: 16,
            }
        );

        let payload = guest_control_proto::encode_exec_started(73).unwrap();
        let response =
            guest_control_proto::encode(guest_control_proto::MSG_EXEC_STARTED, start.seq, &payload)
                .unwrap();
        guest.write_all(&response).await.unwrap();
        start.seq
    };
    let (handle, exec_seq) = tokio::join!(start_process, acknowledge_start);
    let handle = handle.unwrap();

    assert!(handle.has_stdout_receiver());
    send_exec_exit(&mut guest, exec_seq).await;
    let exit = sandbox
        .wait_process(handle, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        exit.termination,
        sandbox::ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn start_process_timeout_before_write_preserves_guest_connection() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let timed_out_request = StartProcessRequest {
        timeout_is_expected: true,
        cmd: "prefetch",
        timeout: Duration::from_secs(5),
        start_timeout: Duration::ZERO,
        env: &[],
        sudo: false,
        output: ProcessOutputMode::buffered(sandbox::EXEC_OUTPUT_LIMIT_1_MIB),
    };

    let error = match sandbox.start_process(&timed_out_request).await {
        Ok(_) => panic!("zero-deadline process start should time out"),
        Err(error) => error,
    };
    match error {
        SandboxError::OperationTimeout {
            operation,
            stage,
            timeout_ms,
        } => {
            assert_eq!(operation, SandboxOperation::StartProcess);
            assert_eq!(
                stage,
                sandbox::SandboxOperationTimeoutStage::BeforeFrameWrite
            );
            assert_eq!(timeout_ms, 0);
        }
        other => panic!("expected pre-write process-start timeout, got {other:?}"),
    }
    assert_eq!(
        guest.try_read(&mut [0u8; 1]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );

    let request = StartProcessRequest {
        start_timeout: Duration::from_secs(1),
        ..timed_out_request
    };
    let start_process = sandbox.start_process(&request);
    let acknowledge_start = async {
        let start = read_vsock_message(&mut guest).await;
        assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
        let payload = guest_control_proto::encode_exec_started(73).unwrap();
        let response =
            guest_control_proto::encode(guest_control_proto::MSG_EXEC_STARTED, start.seq, &payload)
                .unwrap();
        guest.write_all(&response).await.unwrap();
        start.seq
    };
    let (handle, exec_seq) = tokio::join!(start_process, acknowledge_start);
    let handle = handle.unwrap();
    let payload = guest_control_proto::encode_exec_result(
        guest_control_proto::ExecTermination::Exited { exit_code: 0 },
        1,
        guest_control_proto::ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        guest_control_proto::ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        "",
    )
    .unwrap();
    let response =
        guest_control_proto::encode(guest_control_proto::MSG_EXEC_RESULT, exec_seq, &payload)
            .unwrap();
    guest.write_all(&response).await.unwrap();
    sandbox
        .wait_process(handle, Duration::from_secs(1))
        .await
        .unwrap();
}

#[tokio::test]
async fn start_process_timeout_after_write_rejects_later_guest_operation() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let start_timeout = Duration::from_millis(20);
    let request = StartProcessRequest {
        timeout_is_expected: true,
        cmd: "prefetch",
        timeout: Duration::from_secs(5),
        start_timeout,
        env: &[],
        sudo: false,
        output: ProcessOutputMode::buffered(sandbox::EXEC_OUTPUT_LIMIT_1_MIB),
    };

    let error = match sandbox.start_process(&request).await {
        Ok(_) => panic!("unacknowledged process start should time out"),
        Err(error) => error,
    };
    match error {
        SandboxError::OperationTimeout {
            operation,
            stage,
            timeout_ms,
        } => {
            assert_eq!(operation, SandboxOperation::StartProcess);
            assert_eq!(
                stage,
                sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse
            );
            assert_eq!(timeout_ms, 20);
        }
        other => panic!("expected post-write process-start timeout, got {other:?}"),
    }
    let start = read_vsock_message(&mut guest).await;
    assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
    let cancel = read_vsock_message(&mut guest).await;
    assert_eq!(cancel.msg_type, guest_control_proto::MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    let later_error = match sandbox
        .exec(&ExecRequest {
            cmd: "true",
            timeout: Duration::from_secs(1),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: sandbox::EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await
    {
        Ok(_) => panic!("post-write timeout connection must reject later operations"),
        Err(error) => error,
    };
    assert_operation_error(
        later_error,
        SandboxOperation::Exec,
        SandboxOperationReason::GuestConnectionUnavailable,
    );
}

#[tokio::test]
async fn cancelled_guest_write_classifies_later_admission_without_another_frame() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    {
        let write = sandbox.write_file("/tmp/cancelled-write", b"contents");
        tokio::pin!(write);
        tokio::select! {
            result = &mut write => panic!("write completed without guest acknowledgement: {result:?}"),
            request = read_vsock_message(&mut guest) => {
                assert_eq!(request.msg_type, guest_control_proto::MSG_WRITE_FILE);
            }
        }
        // Dropping this in-flight request abandons its terminal proof.
    }

    let error = sandbox
        .write_file("/tmp/later-write", b"later")
        .await
        .unwrap_err();
    assert_operation_error(
        error,
        SandboxOperation::WriteFile,
        SandboxOperationReason::GuestConnectionUnavailable,
    );
    assert_eq!(
        guest.try_read(&mut [0_u8; 1]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn closed_guest_connection_is_distinct_from_temporary_fencing() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let guest = attach_mock_shutdown_guest(&sandbox).await;
    let host = sandbox.guest.lock().await.as_ref().unwrap().clone();
    let fence = host.try_fence_normal_operations().unwrap();
    assert_operation_error(
        sandbox
            .write_file("/tmp/fenced", b"contents")
            .await
            .unwrap_err(),
        SandboxOperation::WriteFile,
        SandboxOperationReason::Guest,
    );
    drop(fence);
    drop(guest);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(
            host.try_fence_normal_operations(),
            Err(guest_control_client::NormalOperationFenceRejection::Closed)
        ) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_operation_error(
        sandbox
            .write_file("/tmp/closed", b"contents")
            .await
            .unwrap_err(),
        SandboxOperation::WriteFile,
        SandboxOperationReason::GuestConnectionUnavailable,
    );
}

#[tokio::test]
async fn start_agent_process_maps_to_agent_role_and_control_sink() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let request = StartAgentProcessRequest {
        timeout: Duration::from_secs(5),
        env: &[],
        output: ProcessOutputMode::buffered(sandbox::EXEC_OUTPUT_LIMIT_1_MIB),
    };

    let start_agent = sandbox.start_agent_process(&request);
    let acknowledge_start = async {
        let start = read_vsock_message(&mut guest).await;
        let decoded = guest_control_proto::decode_exec_start(&start.payload).unwrap();
        assert_eq!(decoded.role, guest_control_proto::ExecProcessRole::Agent);
        assert!(decoded.command.is_empty());
        assert!(!decoded.sudo);
        assert!(matches!(
            decoded.control,
            guest_control_proto::ExecControlPolicy::Enabled { sink: true, .. }
        ));

        send_agent_started_and_ready(&mut guest, start.seq, 73).await;
        start.seq
    };
    let (handle, exec_seq) = tokio::join!(start_agent, acknowledge_start);
    let handle = handle.unwrap();
    let timing = handle.start_timing();
    assert_eq!(timing.containment_create, Duration::from_micros(11));
    assert_eq!(timing.placement_broker_setup, Duration::from_micros(12));
    assert_eq!(timing.shell_spawn, Duration::from_micros(13));
    assert_eq!(timing.bootstrap_ready_wait, Duration::from_micros(14));
    assert!(timing.ready_at >= timing.shell_started_at);
    let (process, _control) = handle.into_parts();

    let payload = guest_control_proto::encode_exec_result(
        guest_control_proto::ExecTermination::Exited { exit_code: 0 },
        1,
        guest_control_proto::ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        guest_control_proto::ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        "",
    )
    .unwrap();
    let response =
        guest_control_proto::encode(guest_control_proto::MSG_EXEC_RESULT, exec_seq, &payload)
            .unwrap();
    guest.write_all(&response).await.unwrap();
    let exit = sandbox
        .wait_process(process, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        exit.termination,
        sandbox::ExecTermination::Exited { exit_code: 0 }
    );
}

#[test]
fn operation_error_preserves_file_operation_context_for_guest_failures() {
    for operation in [SandboxOperation::ReadFile, SandboxOperation::CopyFile] {
        let timeout = FirecrackerSandbox::operation_error(
            operation,
            io::Error::new(io::ErrorKind::TimedOut, "operation timed out"),
            false,
        );
        let guest = FirecrackerSandbox::operation_error(
            operation,
            io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
            false,
        );

        assert_operation_error(timeout, operation, SandboxOperationReason::Timeout);
        assert_operation_error(guest, operation, SandboxOperationReason::Guest);
    }
}

#[test]
fn process_timeout_policy_maps_zero_to_none_and_millis_to_duration() {
    assert_eq!(process_timeout_policy(0), ExecTimeoutPolicy::None);
    assert_eq!(
        process_timeout_policy(2500),
        ExecTimeoutPolicy::Duration { timeout_ms: 2500 }
    );
    assert_eq!(
        process_timeout_policy(u32::MAX),
        ExecTimeoutPolicy::Duration {
            timeout_ms: u32::MAX
        }
    );
}

#[test]
fn process_output_stream_maps_to_supervised_stdout_only() {
    let output = ProcessOutputMode::Stream {
        stream_limit_bytes: 123,
        chunk_limit_bytes: 45,
        queue_capacity: 7,
        stderr_capture_limit_bytes: None,
    };

    assert_eq!(
        process_stdout_policy(output),
        ExecOutputPolicy::Stream {
            limit_bytes: 123,
            chunk_limit_bytes: 45,
        }
    );
    assert_eq!(process_stderr_policy(output), ExecOutputPolicy::Discard);
    assert_eq!(process_stream_queue_capacity(output), Some(7));
}

#[test]
fn process_output_stream_can_capture_stderr() {
    let output = ProcessOutputMode::Stream {
        stream_limit_bytes: 123,
        chunk_limit_bytes: 45,
        queue_capacity: 7,
        stderr_capture_limit_bytes: Some(4096),
    };

    assert_eq!(
        process_stderr_policy(output),
        ExecOutputPolicy::Capture { limit_bytes: 4096 }
    );
}

#[test]
fn process_output_buffered_maps_to_bounded_capture() {
    let output = ProcessOutputMode::buffered(sandbox::ExecOutputLimits::separate(11, 13));

    assert_eq!(
        process_stdout_policy(output),
        ExecOutputPolicy::Capture { limit_bytes: 11 }
    );
    assert_eq!(
        process_stderr_policy(output),
        ExecOutputPolicy::Capture { limit_bytes: 13 }
    );
    assert_eq!(process_stream_queue_capacity(output), None);
}

#[test]
fn exec_result_from_operation_result_preserves_terminal_metadata() {
    let result = exec_result_from_operation_result(guest_control_client::ExecOperationResult {
        termination: guest_control_proto::ExecTermination::Exited { exit_code: 7 },
        duration_ms: 10,
        stdout: ExecOwnedCapturedOutput::Captured {
            bytes: b"out".to_vec(),
            truncated: true,
        },
        stderr: ExecOwnedCapturedOutput::Captured {
            bytes: b"err".to_vec(),
            truncated: false,
        },
        diagnostic: "ignored on ordinary exit".to_string(),
        stream_overflowed: false,
    })
    .expect("bounded exec result should convert");

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(result.guest_duration_ms, Some(10));
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert_eq!(result.diagnostic, "ignored on ordinary exit");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
}

#[tokio::test]
async fn apply_storage_manifest_preserves_terminal_metadata() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let request = StorageManifestRequest {
        manifest_json: b"{\"storages\":[]}",
        run_id: "run-1",
        runtime_dir: "/run/vm0/runs/run-1",
        timeout: Duration::from_secs(5),
    };

    let apply = sandbox.apply_storage_manifest(&request);
    let respond = async {
        let request = read_vsock_message(&mut guest).await;
        assert_eq!(
            request.msg_type,
            guest_control_proto::MSG_GUEST_STORAGE_MANIFEST
        );
        let decoded =
            guest_control_proto::decode_guest_storage_manifest_request(&request.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 5_000);
        assert_eq!(decoded.run_id, "run-1");
        assert_eq!(decoded.runtime_dir, "/run/vm0/runs/run-1");
        assert_eq!(decoded.manifest_json, b"{\"storages\":[]}");

        let resources = serde_json::to_vec(&serde_json::json!({
            "run_id": null,
            "request_seq": request.seq,
            "group": format!("exec-7-{}-1", request.seq),
            "cleanup_mode": "Forced",
            "containment_wall_us": 19000,
            "collection_us": 170,
            "cpu_usage_usec": 16000,
            "memory_peak_bytes": 1048576,
            "memory_high_limit_bytes": "max",
            "unknown_peer_field": "must-not-be-logged"
        }))
        .unwrap();

        let payload = guest_control_proto::encode_guest_storage_manifest_result(
            guest_control_proto::DecodedExecResult {
                termination: guest_control_proto::ExecTermination::WaitFailed,
                duration_ms: 19,
                stdout: guest_control_proto::ExecCapturedOutput::Captured {
                    bytes: b"out",
                    truncated: true,
                },
                stderr: guest_control_proto::ExecCapturedOutput::Captured {
                    bytes: b"err",
                    truncated: false,
                },
                diagnostic: "containment cleanup failed",
            },
            &resources,
        )
        .unwrap();
        let response = guest_control_proto::encode(
            guest_control_proto::MSG_GUEST_STORAGE_MANIFEST_RESULT,
            request.seq,
            &payload,
        )
        .unwrap();
        guest.write_all(&response).await.unwrap();
    };
    let (result, ()) = tokio::join!(apply, respond);
    let result = result.unwrap();

    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert_eq!(result.guest_duration_ms, Some(19));
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert_eq!(result.diagnostic, "containment cleanup failed");
    let events = captured.entries();
    let summaries: Vec<_> = events
        .iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str) == Some("storage apply resources")
        })
        .collect();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].fields["id"], sandbox.id.to_string());
    let resources: serde_json::Value =
        serde_json::from_str(&summaries[0].fields["resources"]).unwrap();
    assert_eq!(resources["cpu_usage_usec"], 16000);
    assert_eq!(resources["memory_high_limit_bytes"], "max");
    assert!(resources["memory_pgscan"].is_null());
    assert!(!summaries[0].fields["resources"].contains("must-not-be-logged"));
}

#[tokio::test]
async fn mount_workspace_drive_maps_empty_request_and_terminal_metadata() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;

    let mount = sandbox.mount_workspace_drive();
    let respond = async {
        let request = read_vsock_message(&mut guest).await;
        assert_eq!(
            request.msg_type,
            guest_control_proto::MSG_WORKSPACE_DRIVE_MOUNT
        );
        guest_control_proto::decode_workspace_drive_mount_request(&request.payload).unwrap();

        let payload = guest_control_proto::encode_workspace_drive_mount_result(
            guest_control_proto::ExecTermination::WaitFailed,
            17,
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"out",
                truncated: true,
            },
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"err",
                truncated: false,
            },
            "containment cleanup failed",
        )
        .unwrap();
        let response = guest_control_proto::encode(
            guest_control_proto::MSG_WORKSPACE_DRIVE_MOUNT_RESULT,
            request.seq,
            &payload,
        )
        .unwrap();
        guest.write_all(&response).await.unwrap();
    };
    let (result, ()) = tokio::join!(mount, respond);
    let result = result.unwrap();

    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert_eq!(result.guest_duration_ms, Some(17));
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert_eq!(result.diagnostic, "containment cleanup failed");
}

#[tokio::test]
async fn verify_session_history_identity_maps_fixed_request_and_terminal_metadata() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let session_id_hash = "a".repeat(64);
    let history_hash = "b".repeat(64);
    let request = SessionHistoryIdentityVerifyRequest {
        metadata_path: "/run/vm0/runs/previous/final.json",
        runtime_dir: "/run/vm0/runs/previous",
        framework: "claude-code",
        session_id_hash: &session_id_hash,
        history_ref_kind: "blob",
        history_hash: &history_hash,
        history_size_bytes: 42,
        timeout: Duration::from_secs(5),
    };

    let verify = sandbox.verify_session_history_identity(&request);
    let respond = async {
        let request = read_vsock_message(&mut guest).await;
        assert_eq!(request.msg_type, guest_control_proto::MSG_EXEC_START);
        let decoded = guest_control_proto::decode_exec_start(&request.payload).unwrap();
        assert_eq!(
            decoded.role,
            guest_control_proto::ExecProcessRole::SessionHistoryIdentityVerifier
        );
        assert_eq!(
            decoded.timeout,
            guest_control_proto::ExecTimeoutPolicy::Duration { timeout_ms: 5_000 }
        );
        let verifier: guest_contracts::session_history_identity::SessionHistoryIdentityVerifyRequest =
            serde_json::from_str(decoded.command).unwrap();
        assert_eq!(verifier.metadata_path, "/run/vm0/runs/previous/final.json");
        assert_eq!(verifier.runtime_dir, "/run/vm0/runs/previous");
        assert_eq!(verifier.expectation.session_id_hash, session_id_hash);
        assert_eq!(verifier.expectation.history_hash, history_hash);

        let payload = guest_control_proto::encode_exec_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 8 },
            19,
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"out",
                truncated: true,
            },
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"err",
                truncated: false,
            },
            "identity mismatch",
        )
        .unwrap();
        let response = guest_control_proto::encode(
            guest_control_proto::MSG_EXEC_RESULT,
            request.seq,
            &payload,
        )
        .unwrap();
        guest.write_all(&response).await.unwrap();
    };
    let (result, ()) = tokio::join!(verify, respond);
    let result = result.unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 8 });
    assert_eq!(result.guest_duration_ms, Some(19));
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert_eq!(result.diagnostic, "identity mismatch");
}

#[tokio::test]
async fn cleanup_codex_session_maps_fixed_request_and_terminal_metadata() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let request = CodexSessionCleanupRequest {
        session_id: "019e9154-c304-70f0-adde-36efb1be1701",
        fallback_relative_path: "sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl",
        timeout: Duration::from_secs(5),
    };

    let cleanup = sandbox.cleanup_codex_session(&request);
    let respond = async {
        let request = read_vsock_message(&mut guest).await;
        assert_eq!(request.msg_type, guest_control_proto::MSG_EXEC_START);
        let decoded = guest_control_proto::decode_exec_start(&request.payload).unwrap();
        assert_eq!(
            decoded.role,
            guest_control_proto::ExecProcessRole::CodexSessionCleanup
        );
        assert_eq!(
            decoded.timeout,
            guest_control_proto::ExecTimeoutPolicy::Duration { timeout_ms: 5_000 }
        );
        let cleanup: guest_contracts::codex_session_cleanup::CodexSessionCleanupRequest =
            serde_json::from_str(decoded.command).unwrap();
        assert_eq!(cleanup.session_id, "019e9154-c304-70f0-adde-36efb1be1701");
        assert_eq!(
            cleanup.fallback_relative_path,
            "sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        );

        let payload = guest_control_proto::encode_exec_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            19,
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"out",
                truncated: true,
            },
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"err",
                truncated: false,
            },
            "cleanup diagnostic",
        )
        .unwrap();
        let response = guest_control_proto::encode(
            guest_control_proto::MSG_EXEC_RESULT,
            request.seq,
            &payload,
        )
        .unwrap();
        guest.write_all(&response).await.unwrap();
    };
    let (result, ()) = tokio::join!(cleanup, respond);
    let result = result.unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.guest_duration_ms, Some(19));
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert_eq!(result.diagnostic, "cleanup diagnostic");
}

#[tokio::test]
async fn restore_guest_state_preserves_fixed_request_and_terminal_metadata() {
    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let entropy = [0xA5; 256];
    let request = GuestStateRestoreRequest {
        unix_seconds: 1_778_000_000,
        unix_nanoseconds: 123_000_000,
        entropy: &entropy,
        timezone: GuestStateRestoreTimezone::Required("Asia/Shanghai"),
        timeout: Duration::from_secs(5),
    };

    let restore = sandbox.restore_guest_state(&request);
    let respond = async {
        let request = read_vsock_message(&mut guest).await;
        assert_eq!(
            request.msg_type,
            guest_control_proto::MSG_GUEST_STATE_RESTORE
        );
        let decoded =
            guest_control_proto::decode_guest_state_restore_request(&request.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 5_000);
        assert_eq!(decoded.unix_seconds, 1_778_000_000);
        assert_eq!(decoded.unix_nanoseconds, 123_000_000);
        assert_eq!(decoded.entropy, entropy);
        assert_eq!(
            decoded.timezone,
            guest_control_proto::GuestStateRestoreTimezone::Required("Asia/Shanghai")
        );

        let payload = guest_control_proto::encode_guest_state_restore_result(
            guest_control_proto::ExecTermination::WaitFailed,
            19,
            guest_control_proto::ExecCapturedOutput::Captured {
                bytes: b"err",
                truncated: true,
            },
            "containment cleanup failed",
        )
        .unwrap();
        let response = guest_control_proto::encode(
            guest_control_proto::MSG_GUEST_STATE_RESTORE_RESULT,
            request.seq,
            &payload,
        )
        .unwrap();
        guest.write_all(&response).await.unwrap();
    };
    let (result, ()) = tokio::join!(restore, respond);
    let result = result.unwrap();

    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert_eq!(result.guest_duration_ms, Some(19));
    assert!(result.stdout.is_empty());
    assert_eq!(result.stderr, b"err");
    assert!(!result.stdout_truncated);
    assert!(result.stderr_truncated);
    assert_eq!(result.diagnostic, "containment cleanup failed");
}

#[test]
fn exec_result_from_operation_result_maps_terminal_edge_states() {
    for (termination, diagnostic, input_stderr, expected_termination) in [
        (
            guest_control_proto::ExecTermination::TimedOut,
            "",
            Vec::new(),
            ExecTermination::TimedOut,
        ),
        (
            guest_control_proto::ExecTermination::Cancelled,
            "cancel diagnostic",
            Vec::new(),
            ExecTermination::Cancelled,
        ),
        (
            guest_control_proto::ExecTermination::StartFailed,
            "spawn failed",
            Vec::new(),
            ExecTermination::StartFailed,
        ),
        (
            guest_control_proto::ExecTermination::WaitFailed,
            "wait failed",
            b"stderr clue".to_vec(),
            ExecTermination::WaitFailed,
        ),
    ] {
        let result = exec_result_from_operation_result(guest_control_client::ExecOperationResult {
            termination,
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: input_stderr.clone(),
                truncated: false,
            },
            diagnostic: diagnostic.to_string(),
            stream_overflowed: false,
        })
        .expect("bounded exec result should convert");

        assert_eq!(result.termination, expected_termination);
        assert_eq!(result.guest_duration_ms, Some(10));
        assert_eq!(result.stderr, input_stderr);
        assert_eq!(result.diagnostic, diagnostic);
    }
}

#[test]
fn exec_result_from_operation_result_rejects_invalid_capture_state() {
    let overflow =
        match exec_result_from_operation_result(guest_control_client::ExecOperationResult {
            termination: guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            diagnostic: String::new(),
            stream_overflowed: true,
        }) {
            Ok(_) => panic!("bounded capture should reject stream overflow"),
            Err(error) => error,
        };
    assert_eq!(overflow.kind(), io::ErrorKind::InvalidData);
    assert!(overflow.to_string().contains("overflowed a stream queue"));

    let stdout_discarded =
        match exec_result_from_operation_result(guest_control_client::ExecOperationResult {
            termination: guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Discarded,
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            diagnostic: String::new(),
            stream_overflowed: false,
        }) {
            Ok(_) => panic!("bounded capture should reject discarded stdout"),
            Err(error) => error,
        };
    assert_eq!(stdout_discarded.kind(), io::ErrorKind::InvalidData);
    assert!(stdout_discarded.to_string().contains("discarded stdout"));

    let stderr_discarded =
        match exec_result_from_operation_result(guest_control_client::ExecOperationResult {
            termination: guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: ExecOwnedCapturedOutput::Discarded,
            diagnostic: String::new(),
            stream_overflowed: false,
        }) {
            Ok(_) => panic!("bounded capture should reject discarded stderr"),
            Err(error) => error,
        };
    assert_eq!(stderr_discarded.kind(), io::ErrorKind::InvalidData);
    assert!(stderr_discarded.to_string().contains("discarded stderr"));
}

#[test]
fn supervised_exec_result_to_process_exit_preserves_terminal_metadata() {
    let exit = supervised_exec_result_to_process_exit(
        42,
        guest_control_client::ExecOperationResult {
            termination: guest_control_proto::ExecTermination::WaitFailed,
            duration_ms: 10,
            stdout: ExecOwnedCapturedOutput::Captured {
                bytes: b"out".to_vec(),
                truncated: true,
            },
            stderr: ExecOwnedCapturedOutput::Captured {
                bytes: b"err".to_vec(),
                truncated: false,
            },
            diagnostic: "wait failed".to_string(),
            stream_overflowed: true,
        },
    );

    assert_eq!(exit.guest_pid, 42);
    assert_eq!(exit.termination, ExecTermination::WaitFailed);
    assert_eq!(exit.stdout, b"out");
    assert_eq!(exit.stderr, b"err");
    assert!(exit.stdout_truncated);
    assert!(!exit.stderr_truncated);
    assert_eq!(exit.diagnostic, "wait failed");
    assert!(exit.stream_overflowed);
}

#[test]
fn supervised_exec_result_to_process_exit_maps_terminal_edge_states() {
    for (termination, diagnostic, expected_termination) in [
        (
            guest_control_proto::ExecTermination::TimedOut,
            "",
            ExecTermination::TimedOut,
        ),
        (
            guest_control_proto::ExecTermination::Cancelled,
            "cancel diagnostic",
            ExecTermination::Cancelled,
        ),
        (
            guest_control_proto::ExecTermination::StartFailed,
            "spawn failed",
            ExecTermination::StartFailed,
        ),
        (
            guest_control_proto::ExecTermination::WaitFailed,
            "wait failed",
            ExecTermination::WaitFailed,
        ),
    ] {
        let exit = supervised_exec_result_to_process_exit(
            42,
            guest_control_client::ExecOperationResult {
                termination,
                duration_ms: 10,
                stdout: ExecOwnedCapturedOutput::Discarded,
                stderr: ExecOwnedCapturedOutput::Captured {
                    bytes: Vec::new(),
                    truncated: false,
                },
                diagnostic: diagnostic.to_string(),
                stream_overflowed: false,
            },
        );

        assert_eq!(exit.termination, expected_termination);
        assert_eq!(exit.guest_duration_ms, Some(10));
        assert_eq!(exit.stderr, Vec::<u8>::new());
        assert_eq!(exit.diagnostic, diagnostic);
    }
}

#[test]
fn operation_error_classifies_observed_backend_crash_for_all_operations() {
    for operation in [
        SandboxOperation::Exec,
        SandboxOperation::ReadFile,
        SandboxOperation::CopyFile,
        SandboxOperation::WriteFile,
        SandboxOperation::StartProcess,
        SandboxOperation::ProcessControl,
        SandboxOperation::WaitProcess,
    ] {
        let err = FirecrackerSandbox::operation_error(
            operation,
            io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"),
            true,
        );

        assert_operation_error(err, operation, SandboxOperationReason::BackendCrashed);
    }
}

#[test]
fn unavailable_guest_classifies_observed_backend_crash_for_all_operations() {
    for operation in [
        SandboxOperation::Exec,
        SandboxOperation::ReadFile,
        SandboxOperation::CopyFile,
        SandboxOperation::WriteFile,
        SandboxOperation::StartProcess,
        SandboxOperation::ProcessControl,
        SandboxOperation::WaitProcess,
    ] {
        let err = FirecrackerSandbox::operation_unavailable_error(operation, SandboxState::Crashed);

        assert_operation_error(err, operation, SandboxOperationReason::BackendCrashed);
    }
}

#[test]
fn unavailable_guest_preserves_file_operation_context_for_non_crashed_states() {
    for operation in [SandboxOperation::ReadFile, SandboxOperation::CopyFile] {
        for (state, expected_state) in [
            (SandboxState::Created, "created"),
            (SandboxState::Running, "running"),
            (SandboxState::Stopping, "stopping"),
            (SandboxState::Stopped, "stopped"),
        ] {
            let err = FirecrackerSandbox::operation_unavailable_error(operation, state);

            assert_invalid_state_operation(err, operation, expected_state);
        }
    }
}

#[test]
fn operation_gate_closed_preserves_file_operation_context() {
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator
        .begin_prepare_park()
        .expect("begin prepare park");
    let gate_state = coordinator.state();

    for operation in [SandboxOperation::ReadFile, SandboxOperation::CopyFile] {
        let err = FirecrackerSandbox::operation_gate_closed_error(operation, gate_state.clone());

        assert_invalid_state_operation(
            err,
            operation,
            "ClosingForPark { attempt_id: ParkAttemptId(1) }",
        );
    }
    coordinator
        .abort_prepare_park(&attempt)
        .expect("abort prepare park");
}

#[tokio::test]
async fn file_operation_entrypoints_preserve_operation_context_for_start_rejections() {
    for (state, expected_state) in [
        (SandboxState::Created, "created"),
        (SandboxState::Running, "running"),
    ] {
        let sandbox = test_sandbox_with_state(state);

        assert_file_entrypoints_invalid_state(&sandbox, expected_state).await;
    }

    let sandbox = test_sandbox_with_state(SandboxState::Running);
    let attempt = sandbox
        .park_coordinator
        .begin_prepare_park()
        .expect("begin prepare park");

    assert_file_entrypoints_invalid_state(
        &sandbox,
        "ClosingForPark { attempt_id: ParkAttemptId(1) }",
    )
    .await;

    sandbox
        .park_coordinator
        .abort_prepare_park(&attempt)
        .expect("abort prepare park");
}

#[test]
fn process_control_latency_logs_only_material_delays() {
    assert_eq!(
        process_control_latency_level(Duration::from_millis(249)),
        None
    );
    assert_eq!(
        process_control_latency_level(Duration::from_millis(250)),
        Some(ProcessControlLatencyLevel::Info)
    );
    assert_eq!(
        process_control_latency_level(Duration::from_millis(749)),
        Some(ProcessControlLatencyLevel::Info)
    );
    assert_eq!(
        process_control_latency_level(Duration::from_millis(750)),
        Some(ProcessControlLatencyLevel::Warn)
    );
}

#[tokio::test]
async fn process_control_rejects_closed_policy_gate_without_dirtying() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let attempt = coordinator
        .begin_prepare_park()
        .expect("begin prepare park");
    let (state, state_tx) = running_process_state();

    let outcome = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "gate-closed".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    )
    .await;
    let error = expect_process_control_failure(
        outcome,
        ProcessControlFailureKind::Operation,
        ProcessControlWriteState::NotWritten,
    );

    assert!(
        error.to_string().contains("sandbox operation gate closed"),
        "unexpected error: {error}",
    );
    coordinator.abort_prepare_park(&attempt).unwrap();
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_rejects_stopped_state_without_dirtying() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = process_state(SandboxState::Stopped);

    let outcome = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "stopped".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    )
    .await;
    let error = expect_process_control_failure(
        outcome,
        ProcessControlFailureKind::Operation,
        ProcessControlWriteState::NotWritten,
    );

    assert!(
        error.to_string().contains("sandbox not running"),
        "unexpected error: {error}",
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_reports_backend_crash_before_guest_write() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = process_state(SandboxState::Crashed);

    let outcome = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "crashed-before-write".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    )
    .await;
    let error = expect_process_control_failure(
        outcome,
        ProcessControlFailureKind::BackendCrashed,
        ProcessControlWriteState::NotWritten,
    );

    assert!(
        error.to_string().contains("firecracker process crashed"),
        "unexpected error: {error}",
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_local_validation_failure_keeps_gate_clean() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();
    let too_large = vec![0; guest_control_proto::EXEC_CONTROL_MAX_PAYLOAD_BYTES + 1];

    let outcome = FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        Arc::clone(&state),
        state_tx.subscribe(),
        control.clone(),
        "too-large".to_owned(),
        too_large,
        Duration::from_secs(5),
    )
    .await;
    let error = expect_process_control_failure(
        outcome,
        ProcessControlFailureKind::Operation,
        ProcessControlWriteState::NotWritten,
    );

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "valid-after-local-failure".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_exec_control_result(&mut guest, request, ExecControlStatus::Delivered, "").await;

    let ack = expect_process_control_delivered(control_task.await.unwrap());
    assert_eq!(ack.message_id, "valid-after-local-failure");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_preserves_guest_statuses_and_legacy_errors() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let cases = [
        (
            ExecControlStatus::Inactive,
            ProcessControlGuestStatus::Inactive,
            io::ErrorKind::NotFound,
            "exec operation is not active",
        ),
        (
            ExecControlStatus::NonceMismatch,
            ProcessControlGuestStatus::NonceMismatch,
            io::ErrorKind::PermissionDenied,
            "exec operation nonce mismatch",
        ),
        (
            ExecControlStatus::Unsupported,
            ProcessControlGuestStatus::Unsupported,
            io::ErrorKind::Unsupported,
            "exec control is not supported by this operation",
        ),
        (
            ExecControlStatus::Rejected,
            ProcessControlGuestStatus::Rejected,
            io::ErrorKind::PermissionDenied,
            "exec control request rejected",
        ),
        (
            ExecControlStatus::SinkUnavailable,
            ProcessControlGuestStatus::SinkUnavailable,
            io::ErrorKind::NotConnected,
            "exec control sink is not connected",
        ),
        (
            ExecControlStatus::SinkTimeout,
            ProcessControlGuestStatus::SinkTimeout,
            io::ErrorKind::TimedOut,
            "exec control sink timed out",
        ),
        (
            ExecControlStatus::QueueFull,
            ProcessControlGuestStatus::QueueFull,
            io::ErrorKind::WouldBlock,
            "exec control queue is full",
        ),
        (
            ExecControlStatus::SinkError,
            ProcessControlGuestStatus::SinkError,
            io::ErrorKind::BrokenPipe,
            "exec control sink error",
        ),
        (
            ExecControlStatus::SinkClosed,
            ProcessControlGuestStatus::SinkClosed,
            io::ErrorKind::BrokenPipe,
            "exec control sink closed",
        ),
    ];

    for (index, (guest_status, status, error_kind, error_message)) in cases.into_iter().enumerate()
    {
        let message_id = format!("guest-status-{index}");
        let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
            coordinator.clone(),
            Arc::clone(&state),
            state_tx.subscribe(),
            control.clone(),
            message_id,
            b"payload".to_vec(),
            Duration::from_secs(5),
        ));
        let request = read_vsock_message(&mut guest).await;
        send_exec_control_result(&mut guest, request, guest_status, "").await;

        let outcome = control_task.await.unwrap();
        assert_process_control_guest_status(&outcome, status, "");
        let error = outcome.into_ack().unwrap_err();
        assert_eq!(error.kind(), error_kind);
        assert_eq!(error.to_string(), error_message);
    }

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "guest-diagnostic".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        request,
        ExecControlStatus::Rejected,
        "guest rejected this request",
    )
    .await;

    let outcome = control_task.await.unwrap();
    assert_process_control_guest_status(
        &outcome,
        ProcessControlGuestStatus::Rejected,
        "guest rejected this request",
    );
    let error = outcome.into_ack().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(error.to_string(), "guest rejected this request");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_guest_error_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "guest-error".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_exec_control_error(&mut guest, request, "guest rejected control").await;

    let outcome = control_task.await.unwrap();
    assert!(
        matches!(
            &outcome,
            ProcessControlOutcome::GuestError(message) if message == "guest rejected control"
        ),
        "unexpected process-control outcome: {outcome:?}",
    );
    let error = outcome.into_ack().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(error.to_string(), "guest rejected control");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_allows_concurrent_requests_while_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let first_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        Arc::clone(&state),
        state_tx.subscribe(),
        control.clone(),
        "concurrent-a".to_owned(),
        b"payload-a".to_vec(),
        Duration::from_secs(5),
    ));
    let second_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "concurrent-b".to_owned(),
        b"payload-b".to_vec(),
        Duration::from_secs(5),
    ));

    let first_request = read_vsock_message(&mut guest).await;
    let second_request = read_vsock_message(&mut guest).await;
    let mut message_ids = [
        guest_control_proto::decode_exec_control(&first_request.payload)
            .unwrap()
            .message_id
            .to_owned(),
        guest_control_proto::decode_exec_control(&second_request.payload)
            .unwrap()
            .message_id
            .to_owned(),
    ];
    message_ids.sort();
    assert_eq!(message_ids, ["concurrent-a", "concurrent-b"]);

    send_exec_control_result(&mut guest, second_request, ExecControlStatus::Delivered, "").await;
    send_exec_control_result(&mut guest, first_request, ExecControlStatus::Delivered, "").await;

    let first_ack = expect_process_control_delivered(first_task.await.unwrap());
    let second_ack = expect_process_control_delivered(second_task.await.unwrap());
    assert_eq!(first_ack.message_id, "concurrent-a");
    assert_eq!(second_ack.message_id, "concurrent-b");
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_protocol_poison_after_guest_write_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq: _,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "malformed-result".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    send_mismatched_exec_control_result(&mut guest, request).await;

    let error = expect_process_control_failure(
        control_task.await.unwrap(),
        ProcessControlFailureKind::Operation,
        ProcessControlWriteState::PossiblyWritten,
    );
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[tokio::test]
async fn process_control_backend_crash_after_guest_write_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        Arc::clone(&state),
        state_tx.subscribe(),
        control,
        "backend-crash".to_owned(),
        b"payload".to_vec(),
        Duration::from_secs(5),
    ));
    let request = read_vsock_message(&mut guest).await;
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);

    state.store(SandboxState::Crashed as u8, Ordering::Release);
    state_tx.send(SandboxState::Crashed).unwrap();

    let outcome = tokio::time::timeout(Duration::from_secs(1), control_task)
        .await
        .unwrap()
        .unwrap();
    let error = expect_process_control_failure(
        outcome,
        ProcessControlFailureKind::BackendCrashed,
        ProcessControlWriteState::PossiblyWritten,
    );
    assert!(
        error.to_string().contains("firecracker process crashed"),
        "unexpected error: {error}",
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn process_control_timeout_after_guest_write_keeps_policy_open() {
    let ExecProcessControlFixture {
        host: _host,
        handle,
        mut guest,
        exec_seq,
    } = setup_exec_process_control_fixture().await;
    let control = handle.control_handle().unwrap();
    let coordinator = ParkCoordinator::new();
    let (state, state_tx) = running_process_state();

    let control_task = tokio::spawn(FirecrackerSandbox::exec_process_control(
        coordinator.clone(),
        state,
        state_tx.subscribe(),
        control,
        "timeout-after-write".to_owned(),
        b"payload".to_vec(),
        Duration::ZERO,
    ));
    let request = read_vsock_message(&mut guest).await;
    assert_eq!(request.msg_type, MSG_EXEC_CONTROL);

    let outcome = tokio::time::timeout(Duration::from_secs(1), control_task)
        .await
        .unwrap()
        .unwrap();
    let error = expect_process_control_failure(
        outcome,
        ProcessControlFailureKind::Operation,
        ProcessControlWriteState::PossiblyWritten,
    );
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(coordinator.state(), CoordinatorState::Open);

    send_exec_exit(&mut guest, exec_seq).await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

/// Exercise the `monitor_process` crash detection flow through real child
/// exit. A running process exit should mark the sandbox crashed and wake
/// current subscribers.
#[tokio::test]
async fn process_monitor_reports_unexpected_exit() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let runtime_cancel = CancellationToken::new();
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        Arc::clone(&guest),
        runtime_cancel.clone(),
    );

    drop(stdin);

    tokio::time::timeout(Duration::from_secs(1), runtime_cancel.cancelled())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), wait_for_backend_crash(state_rx))
        .await
        .unwrap();
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );

    handle.wait().await;
}

#[tokio::test]
async fn process_monitor_releases_guest_cpu_cgroup_after_reap() {
    let temp = tempfile::tempdir().unwrap();
    let leaf = temp.path().join("guest");
    std::fs::create_dir(&leaf).unwrap();
    let placement_file = std::fs::File::create(temp.path().join("placement")).unwrap();
    let lease = GuestCpuCgroupLease::from_test_file(leaf.clone(), placement_file);
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();
    let context = ProcessMonitorContext {
        state,
        state_publish_lock,
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
        guest_cpu_cgroup: Some(lease),
    };

    let handle = monitor_process_with_context("test-sandbox", child, context);
    assert!(leaf.exists());

    drop(stdin);
    handle.wait().await;

    assert!(!leaf.exists());
}

#[tokio::test]
async fn process_monitor_cancels_control_server_after_exit() {
    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("control.sock");
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let runtime_cancel = CancellationToken::new();
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        Arc::clone(&guest),
        runtime_cancel.clone(),
    );
    let mut control = crate::control::bind_server(
        sock_path.clone(),
        GuestOperationStartGate::new(Arc::clone(&guest), ParkCoordinator::new()),
        handle.termination_handle(ParkCoordinator::new()),
    )
    .unwrap()
    .spawn(runtime_cancel.clone());

    drop(stdin);
    wait_for_path_removed(&sock_path).await;

    handle.wait().await;
    control.shutdown().await;
}

#[tokio::test]
async fn process_monitor_drains_log_readers_after_exit() {
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let child = stdout_stderr_writing_process();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        CancellationToken::new(),
    );

    tokio::time::timeout(Duration::from_secs(1), handle.wait())
        .await
        .expect("process monitor should drain completed log readers");
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );
}

#[tokio::test]
async fn process_monitor_aborts_stuck_log_reader_after_exit() {
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = monitored_cat_process_without_log_pipes();
    let stdin = child.stdin.take();
    let (stdout_reader, stdout_started_rx, stdout_dropped_rx) = pending_log_reader_for_test();
    let (stderr_reader, stderr_started_rx, stderr_dropped_rx) = pending_log_reader_for_test();
    let readers = ProcessLogReaders::new_for_test(Some(stdout_reader), Some(stderr_reader));

    tokio::time::timeout(Duration::from_secs(1), stdout_started_rx)
        .await
        .expect("pending stdout reader should start")
        .expect("pending stdout reader started sender should stay alive");
    tokio::time::timeout(Duration::from_secs(1), stderr_started_rx)
        .await
        .expect("pending stderr reader should start")
        .expect("pending stderr reader started sender should stay alive");
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
        guest_cpu_cgroup: None,
    };
    let handle = monitor_process_with_log_readers("test-sandbox", child, context, readers);

    drop(stdin);

    tokio::time::timeout(Duration::from_secs(1), handle.wait())
        .await
        .expect("process monitor should not hang on stuck log reader");
    tokio::time::timeout(Duration::from_secs(1), stdout_dropped_rx)
        .await
        .expect("stuck stdout log reader should be aborted")
        .expect("stuck stdout log reader drop notification should be sent");
    tokio::time::timeout(Duration::from_secs(1), stderr_dropped_rx)
        .await
        .expect("stuck stderr log reader should be aborted")
        .expect("stuck stderr log reader drop notification should be sent");
}

#[tokio::test]
async fn process_monitor_wait_cancel_keeps_log_reader_cleanup_owned() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = monitored_cat_process_without_log_pipes();
    let stdin = child.stdin.take();
    let (reader, started_rx, dropped_rx) = pending_log_reader_for_test();
    let readers = ProcessLogReaders::new_for_test(Some(reader), None);

    tokio::time::timeout(Duration::from_secs(1), started_rx)
        .await
        .expect("pending reader should start")
        .expect("pending reader started sender should stay alive");
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
        guest_cpu_cgroup: None,
    };
    let handle = monitor_process_with_log_readers("test-sandbox", child, context, readers);

    let waiter = tokio::spawn(async move {
        handle.wait().await;
    });
    tokio::task::yield_now().await;
    waiter.abort();
    let _ = waiter.await;

    drop(stdin);

    tokio::time::timeout(Duration::from_secs(1), dropped_rx)
        .await
        .expect("detached monitor should still cleanup owned log reader")
        .expect("pending reader drop notification should be sent");
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
}

/// The lifecycle stream stores the latest state, so late subscribers still
/// classify an already-observed backend crash deterministically.
#[tokio::test]
async fn backend_crash_state_is_visible_to_late_subscribers() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx.clone(),
        guest,
        CancellationToken::new(),
    );

    drop(stdin);
    wait_for_state(&state, SandboxState::Crashed).await;

    tokio::time::timeout(
        Duration::from_millis(50),
        wait_for_backend_crash(state_tx.subscribe()),
    )
    .await
    .unwrap();

    handle.wait().await;
}

/// When the process is stopped gracefully (state transitions to Stopping
/// before process exit), `monitor_process` records Stopped without marking
/// the backend crashed.
#[tokio::test]
async fn process_monitor_records_graceful_stop_without_crash() {
    let state = Arc::new(AtomicU8::new(SandboxState::Stopping as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Stopping);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx.clone(),
        guest,
        CancellationToken::new(),
    );

    drop(stdin);
    let exit_state = tokio::time::timeout(
        Duration::from_secs(1),
        wait_for_process_exit(state_tx.subscribe()),
    )
    .await
    .unwrap();
    assert_eq!(exit_state, SandboxState::Stopped);
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );

    handle.wait().await;
}

#[tokio::test]
async fn process_monitor_reports_startup_exit_as_stopped() {
    let state = Arc::new(AtomicU8::new(SandboxState::Created as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Created);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = monitored_cat_process();
    let stdin = child.stdin.take();

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx.clone(),
        guest,
        CancellationToken::new(),
    );

    drop(stdin);
    let exit_state = tokio::time::timeout(
        Duration::from_secs(1),
        wait_for_process_exit(state_tx.subscribe()),
    )
    .await
    .unwrap();
    assert_eq!(exit_state, SandboxState::Stopped);
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );

    handle.wait().await;
}

#[derive(Default)]
struct RecordingSandboxStartObserver {
    records: Vec<(SandboxStartStage, bool)>,
}

impl SandboxStartObserver for RecordingSandboxStartObserver {
    fn record_stage(&mut self, stage: SandboxStartStage, _duration: Duration, success: bool) {
        self.records.push((stage, success));
    }
}

#[tokio::test]
async fn start_with_observer_reports_backend_launch_failure() {
    let workspace = tempfile::tempdir().unwrap();
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    sandbox.sandbox_paths = SandboxPaths::new(workspace.path().join("workspace"));
    guest_rpc::prepare_socket_paths(&mut sandbox, &workspace.path().join("sock"));
    let mut observer = RecordingSandboxStartObserver::default();

    let error = sandbox
        .start_with_observer(&mut observer)
        .await
        .unwrap_err();

    let SandboxError::Start { message } = error else {
        panic!("expected startup error");
    };
    assert!(message.contains("COW device missing before sandbox start"));
    assert_eq!(
        observer.records,
        vec![(SandboxStartStage::BackendLaunch, false)]
    );
}

#[tokio::test]
async fn spawn_and_wait_for_api_adopts_process_and_secures_socket() {
    let workspace = tempfile::tempdir().unwrap();
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    sandbox.sandbox_paths = SandboxPaths::new(workspace.path().to_path_buf());

    let mut api = MockFirecrackerApi::repeating(MockResponse::ok());
    std::fs::set_permissions(api.socket_path(), std::fs::Permissions::from_mode(0o666)).unwrap();

    let mut command = process_launch::Command::new("bash");
    command.args(["-c", "sleep 60"]);

    let _client = sandbox
        .spawn_and_wait_for_api(
            command,
            api.socket_path(),
            CancellationToken::new(),
            "fresh boot",
        )
        .await
        .unwrap();

    let request = api.next_request().await;
    assert_eq!(request.method, "GET", "raw request: {}", request.raw);
    assert_eq!(request.path, "/", "raw request: {}", request.raw);
    assert_eq!(
        std::fs::metadata(api.socket_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let pid = i32::try_from(sandbox.host_process_pid().unwrap()).unwrap();
    let pid = nix::unistd::Pid::from_raw(pid);
    assert!(nix::sys::signal::kill(pid, None).is_ok());

    sandbox.runtime.kill_process().await;

    assert!(nix::sys::signal::kill(pid, None).is_err());
}

#[tokio::test]
async fn spawn_and_wait_for_api_reports_process_exit_before_readiness() {
    let workspace = tempfile::tempdir().unwrap();
    let api_dir = tempfile::tempdir().unwrap();
    let api_sock = api_dir.path().join("missing.sock");
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    sandbox.sandbox_paths = SandboxPaths::new(workspace.path().to_path_buf());

    let mut command = process_launch::Command::new("bash");
    command.args(["-c", "exit 23"]);

    let result = tokio::time::timeout(
        Duration::from_secs(1),
        sandbox.spawn_and_wait_for_api(
            command,
            &api_sock,
            CancellationToken::new(),
            "snapshot restore",
        ),
    )
    .await
    .expect("process exit should win before API readiness timeout");
    let error = match result {
        Ok(_) => panic!("startup should fail when the child exits"),
        Err(error) => error,
    };
    let SandboxError::Start { message } = error else {
        panic!("expected startup error");
    };
    assert!(
        message.contains("firecracker process exited before API became ready"),
        "got: {message}"
    );
    assert!(
        message.contains("boot_mode=snapshot restore"),
        "got: {message}"
    );
    assert!(message.contains("state=stopped"), "got: {message}");
    assert!(
        message.contains(&format!("api_sock={}", api_sock.display())),
        "got: {message}"
    );
    assert!(sandbox.host_process_pid().is_some());

    sandbox.runtime.kill_process().await;
}

#[tokio::test]
async fn stdout_eof_does_not_mark_running_process_crashed() {
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = stdout_closing_process();
    let stdout = child.stdout.take().expect("stdout should be piped");
    let stderr = child
        .stderr
        .take()
        .map(|stderr| process_log_reader("test-sandbox", ProcessLogStream::Stderr, stderr));
    let (stdout_reader, stdout_eof_rx) =
        stdout_eof_notifying_log_reader_for_test("test-sandbox", stdout);
    let readers = ProcessLogReaders::new_for_test(Some(stdout_reader), stderr);
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx: state_tx.clone(),
        guest,
        runtime_cancel: CancellationToken::new(),
        guest_cpu_cgroup: None,
    };

    let handle = monitor_process_with_log_readers("test-sandbox", child, context, readers);

    tokio::time::timeout(Duration::from_secs(1), stdout_eof_rx)
        .await
        .expect("stdout reader should observe EOF")
        .expect("stdout EOF notification sender should stay alive");
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Running
    );
    assert_eq!(*state_rx.borrow(), SandboxState::Running);

    publish_process_state(
        &state,
        &state_publish_lock,
        &state_tx,
        SandboxState::Stopping,
    );
    handle.kill();
    handle.wait().await;
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );
}

#[tokio::test]
async fn process_monitor_kills_group_after_unexpected_parent_exit() {
    if !ChildExitNotifier::available_for_current_process_for_test() {
        eprintln!("skipping pidfd-dependent process group cleanup test");
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let child = parent_exits_with_child_process(&pid_file);

    let handle = monitor_process(
        "test-sandbox",
        child,
        Arc::clone(&state),
        Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        CancellationToken::new(),
    );

    handle.wait().await;

    let leaked_pid: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let child_stopped = wait_for_pid_not_running(leaked_pid).await;
    if !child_stopped {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(leaked_pid).unwrap()),
            nix::sys::signal::Signal::SIGKILL,
        );
    }

    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
    assert!(
        child_stopped,
        "unexpected parent exit should not leave process-group children running"
    );
}

#[tokio::test]
async fn process_monitor_fallback_does_not_kill_group_after_parent_reap() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let mut child = parent_exits_with_child_process(&pid_file);
    let readers = ProcessLogReaders::from_child("test-sandbox", &mut child);
    let context = ProcessMonitorContext {
        state: Arc::clone(&state),
        state_publish_lock: Arc::clone(&state_publish_lock),
        state_tx,
        guest,
        runtime_cancel: CancellationToken::new(),
        guest_cpu_cgroup: None,
    };

    let handle = monitor_process_with_log_readers_and_exit_notifier(
        "test-sandbox",
        child,
        context,
        readers,
        ChildExitNotifier::unavailable_for_test(),
    );

    handle.wait().await;

    let leaked_pid: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let child_still_running = pid_is_running(leaked_pid);
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(leaked_pid).unwrap()),
        nix::sys::signal::Signal::SIGKILL,
    );

    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
    assert!(
        child_still_running,
        "pidfd-unavailable fallback must not signal a cached process group after parent reap"
    );
}

/// Verify that `killpg` kills the entire process group spawned with
/// `process_group(0)`.  This is the mechanism the `Drop` impl relies on.
#[tokio::test]
async fn killpg_kills_entire_process_group() {
    // "bash -c 'sleep 60'" creates two processes in the same group:
    //   bash (group leader, PGID = its PID) → sleep (inherits PGID).
    let mut child = tokio::process::Command::new("bash")
        .args(["-c", "sleep 60"])
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let raw_pid = child.id().unwrap();
    let pid = i32::try_from(raw_pid).unwrap();
    let pgid = nix::unistd::Pid::from_raw(pid);

    // killpg should kill both bash and sleep.
    nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL).unwrap();

    // Reap the direct child.
    let status = child.wait().await.unwrap();
    assert!(!status.success(), "process should have been killed");

    // Signal 0 checks existence — should fail with ESRCH.
    let exists = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None);
    assert!(exists.is_err(), "process group leader should be dead");
}

// -- Firecracker API-backed lifecycle tests --
//
// These exercise snapshot restore and `park_inner` / `unpark_inner`
// against a mock Firecracker API socket. We assert on:
//   1. the correct sequence of HTTP requests (method, path, body);
//   2. whether the reactive controller handle is present / absent;
//   3. the is_parked flag state; and
//   4. idempotency on repeat calls.

use std::sync::atomic::AtomicU32;
use tokio::sync::Notify;

#[derive(Debug, Clone)]
struct MockBalloonStats {
    target_mib: u32,
    actual_mib: u32,
    free_memory: Option<i64>,
    available_memory: Option<i64>,
    total_memory: Option<i64>,
    swap_in: Option<i64>,
    swap_out: Option<i64>,
    major_faults: Option<i64>,
    minor_faults: Option<i64>,
    disk_caches: Option<i64>,
}

impl MockBalloonStats {
    fn new(target_mib: u32, actual_mib: u32) -> Self {
        Self {
            target_mib,
            actual_mib,
            free_memory: None,
            available_memory: None,
            total_memory: None,
            swap_in: None,
            swap_out: None,
            major_faults: None,
            minor_faults: None,
            disk_caches: None,
        }
    }

    fn with_memory(mut self, free_memory: i64, available_memory: i64, total_memory: i64) -> Self {
        self.free_memory = Some(free_memory);
        self.available_memory = Some(available_memory);
        self.total_memory = Some(total_memory);
        self
    }

    fn with_extended_counters(
        mut self,
        swap_in: i64,
        swap_out: i64,
        major_faults: i64,
        minor_faults: i64,
        disk_caches: i64,
    ) -> Self {
        self.swap_in = Some(swap_in);
        self.swap_out = Some(swap_out);
        self.major_faults = Some(major_faults);
        self.minor_faults = Some(minor_faults);
        self.disk_caches = Some(disk_caches);
        self
    }

    fn to_json(&self) -> String {
        serde_json::json!({
            "target_mib": self.target_mib,
            "actual_mib": self.actual_mib,
            "target_pages": u64::from(self.target_mib) * 256,
            "actual_pages": u64::from(self.actual_mib) * 256,
            "free_memory": self.free_memory,
            "available_memory": self.available_memory,
            "total_memory": self.total_memory,
            "swap_in": self.swap_in,
            "swap_out": self.swap_out,
            "major_faults": self.major_faults,
            "minor_faults": self.minor_faults,
            "disk_caches": self.disk_caches,
        })
        .to_string()
    }
}

#[derive(Debug, Clone)]
enum MockBalloonStatsReply {
    Ok(MockBalloonStats),
    DelayedOk(Duration, MockBalloonStats),
    GatedOk {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        stats: MockBalloonStats,
    },
    Status(u16),
}

#[derive(Debug)]
struct MockBalloonStatsSequence {
    replies: std::collections::VecDeque<MockBalloonStatsReply>,
    last: MockBalloonStatsReply,
}

impl MockBalloonStatsSequence {
    fn new(replies: std::collections::VecDeque<MockBalloonStatsReply>) -> Self {
        let last = replies
            .back()
            .cloned()
            .unwrap_or_else(|| MockBalloonStatsReply::Ok(MockBalloonStats::new(0, 99999)));
        Self { replies, last }
    }

    fn next(&mut self) -> MockBalloonStatsReply {
        if let Some(reply) = self.replies.pop_front() {
            self.last = reply.clone();
            reply
        } else {
            self.last.clone()
        }
    }
}

#[derive(Clone)]
enum MockBalloonStatsSource {
    DynamicActual(Option<Arc<AtomicU32>>),
    Sequence(Arc<Mutex<MockBalloonStatsSequence>>),
}

impl MockBalloonStatsSource {
    fn next(&self) -> MockBalloonStatsReply {
        match self {
            Self::DynamicActual(balloon_actual) => {
                let actual_mib = balloon_actual
                    .as_ref()
                    .map_or(99999, |actual| actual.load(Ordering::Relaxed));
                MockBalloonStatsReply::Ok(MockBalloonStats::new(0, actual_mib))
            }
            Self::Sequence(sequence) => sequence.lock().unwrap().next(),
        }
    }
}

struct MockLifecycleApi {
    api: MockFirecrackerApi,
}

impl MockLifecycleApi {
    fn new(
        patch_statuses: std::collections::VecDeque<u16>,
        balloon_actual: Option<Arc<AtomicU32>>,
    ) -> Self {
        Self::with_stats_source(
            patch_statuses,
            MockBalloonStatsSource::DynamicActual(balloon_actual),
        )
    }

    fn with_stats(
        patch_statuses: std::collections::VecDeque<u16>,
        balloon_stats: std::collections::VecDeque<MockBalloonStatsReply>,
    ) -> Self {
        Self::with_stats_source(
            patch_statuses,
            MockBalloonStatsSource::Sequence(Arc::new(Mutex::new(MockBalloonStatsSequence::new(
                balloon_stats,
            )))),
        )
    }

    fn with_stats_source(
        patch_statuses: std::collections::VecDeque<u16>,
        balloon_stats_source: MockBalloonStatsSource,
    ) -> Self {
        let patch_statuses = Arc::new(Mutex::new(patch_statuses));
        let api = MockFirecrackerApi::with_handler(move |request| {
            let patch_statuses = Arc::clone(&patch_statuses);
            let balloon_stats_source = balloon_stats_source.clone();
            async move {
                if request.method == "GET" && request.path == "/balloon/statistics" {
                    match balloon_stats_source.next() {
                        MockBalloonStatsReply::Ok(stats) => MockResponse::ok_body(stats.to_json()),
                        MockBalloonStatsReply::DelayedOk(delay, stats) => {
                            tokio::time::sleep(delay).await;
                            MockResponse::ok_body(stats.to_json())
                        }
                        MockBalloonStatsReply::GatedOk {
                            entered,
                            release,
                            stats,
                        } => {
                            entered.notify_one();
                            release.notified().await;
                            MockResponse::ok_body(stats.to_json())
                        }
                        MockBalloonStatsReply::Status(status) => {
                            MockResponse::new(status, "Bad Request", r#"{"fault_message":"test"}"#)
                        }
                    }
                } else if request.method == "PATCH" {
                    let status = patch_statuses.lock().unwrap().pop_front().unwrap_or(204);
                    if status == 204 {
                        MockResponse::no_content()
                    } else {
                        MockResponse::new(status, "Bad Request", r#"{"fault_message":"test"}"#)
                    }
                } else {
                    MockResponse::no_content()
                }
            }
        });

        Self { api }
    }

    fn socket_path(&self) -> &Path {
        self.api.socket_path()
    }

    fn drain_requests(&mut self) -> Vec<MockRequest> {
        self.api.drain_requests()
    }
}

/// Filter captured requests to only PATCH requests (ignoring GET stats
/// polls from `wait_for_balloon` and the reactive balloon controller).
fn patches(reqs: &[MockRequest]) -> Vec<&MockRequest> {
    reqs.iter().filter(|r| r.method == "PATCH").collect()
}

fn mock_request_body_json(request: &MockRequest) -> serde_json::Value {
    serde_json::from_str(&request.body)
        .unwrap_or_else(|error| panic!("invalid JSON body: {error}; request: {request:?}"))
}

async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

async fn capture_balloon_timeout_after_sample<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::pin!(future);
    tokio::time::pause();

    loop {
        if has_captured_event(&captured.entries(), "waiting for balloon") {
            break;
        }
        tokio::select! {
            _ = &mut future => {
                panic!("balloon operation completed before a deficient sample was observed");
            }
            () = tokio::task::yield_now() => {}
        }
    }

    tokio::time::advance(BALLOON_SETTLE_INITIAL_TIMEOUT).await;
    tokio::time::resume();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

async fn wait_for_balloon_sample_count<F>(
    mut future: std::pin::Pin<&mut F>,
    captured: &CapturedEvents,
    expected_sample_count: usize,
) where
    F: Future,
{
    loop {
        let sample_count = captured_message_count(&captured.entries(), "waiting for balloon");
        if sample_count == expected_sample_count {
            return;
        }
        tokio::select! {
            _ = future.as_mut() => {
                panic!(
                    "balloon wait completed after {sample_count} samples, expected {expected_sample_count}"
                );
            }
            () = tokio::task::yield_now() => {}
        }
    }
}

async fn advance_balloon_wait_to_progress_grace<F>(
    mut future: std::pin::Pin<&mut F>,
    captured: &CapturedEvents,
) where
    F: Future,
{
    wait_for_balloon_sample_count(future.as_mut(), captured, 1).await;
    tokio::time::advance(BALLOON_SETTLE_FAST_POLL_INTERVALS[0]).await;
    tokio::time::resume();
    wait_for_balloon_sample_count(future.as_mut(), captured, 2).await;
    tokio::time::pause();

    tokio::time::advance(BALLOON_SETTLE_INITIAL_TIMEOUT - BALLOON_SETTLE_FAST_POLL_INTERVALS[0])
        .await;
    tokio::time::resume();
    loop {
        if has_captured_event(
            &captured.entries(),
            "balloon inflation still progressing, extending settle deadline",
        ) {
            tokio::time::pause();
            return;
        }
        tokio::select! {
            _ = future.as_mut() => {
                panic!("balloon wait completed without progress grace");
            }
            () = tokio::task::yield_now() => {}
        }
    }
}

async fn advance_balloon_wait_to_next_progress_grace<F>(
    mut future: std::pin::Pin<&mut F>,
    captured: &CapturedEvents,
    expected_sample_count: usize,
    expected_grace_count: usize,
) where
    F: Future,
{
    wait_for_balloon_sample_count(future.as_mut(), captured, expected_sample_count).await;
    tokio::time::advance(BALLOON_SETTLE_PROGRESS_GRACE).await;
    tokio::time::resume();
    loop {
        let grace_count = captured_message_count(
            &captured.entries(),
            "balloon inflation still progressing, extending settle deadline",
        );
        if grace_count == expected_grace_count {
            tokio::time::pause();
            return;
        }
        tokio::select! {
            _ = future.as_mut() => {
                panic!(
                    "balloon wait completed after {grace_count} grace intervals, expected {expected_grace_count}"
                );
            }
            () = tokio::task::yield_now() => {}
        }
    }
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
        .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
}

fn captured_event_field<'a>(event: &'a CapturedEvent, field: &str) -> &'a str {
    event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"))
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = captured_event_field(event, field);
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}

fn captured_message_count(events: &[CapturedEvent], message: &str) -> usize {
    events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .count()
}

#[test]
fn exec_capture_request_preserves_stable_operation_label() {
    let stdin = [1, 2, 3];
    let request = ExecRequest {
        cmd: "echo hello",
        timeout: Duration::from_millis(42),
        env: &[("TEST_ENV", "value")],
        sudo: true,
        expected_exit_codes: &[10],
        stdin_bytes: Some(&stdin),
        output_limits: sandbox::ExecOutputLimits::separate(123, 456),
    };

    let capture = exec_capture_request(&request, 42, "storage-download");

    assert_eq!(capture.command, "echo hello");
    assert_eq!(capture.label, "storage-download");
    assert_eq!(capture.timeout_ms, 42);
    assert_eq!(capture.env, &[("TEST_ENV", "value")]);
    assert!(capture.sudo);
    assert_eq!(capture.stdin_bytes, Some(stdin.as_slice()));
    assert_eq!(capture.stdout_limit_bytes, 123);
    assert_eq!(capture.stderr_limit_bytes, 456);
    assert_eq!(capture.expected_exit_codes, &[10]);
    assert_eq!(capture.wait_timeout, Duration::from_millis(5042));
}

fn has_captured_event(events: &[CapturedEvent], message: &str) -> bool {
    events.iter().any(|event| {
        event
            .fields
            .get("message")
            .is_some_and(|actual| actual == message)
    })
}

fn assert_shutdown_failure_event<'a>(
    events: &'a [CapturedEvent],
    sandbox_id: &str,
    failure_kind: &str,
) -> &'a CapturedEvent {
    let event = captured_event(events, "graceful shutdown failed");
    assert_event_field(event, "sandbox_id", sandbox_id);
    assert_event_field(event, "timeout_ms", "5000");
    assert_event_field(event, "failure_kind", failure_kind);
    captured_event_field(event, "elapsed_ms")
        .parse::<u64>()
        .unwrap_or_else(|error| panic!("invalid elapsed_ms; error={error}; event={event:#?}"));
    event
}

#[tokio::test]
async fn stop_with_shutdown_ack_is_quiet() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        assert!(shutdown.payload.is_empty());
        let response = guest_control_proto::encode(MSG_SHUTDOWN_ACK, shutdown.seq, &[]).unwrap();
        guest.write_all(&response).await.unwrap();
    });

    let (result, events) = capture_async_log_events(sandbox.stop()).await;

    result.unwrap();
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    assert!(!has_captured_event(&events, "graceful shutdown failed"));
}

#[tokio::test]
async fn stop_logs_shutdown_timeout_and_reaches_stopped() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let sandbox_id = sandbox.id.clone();
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let (shutdown_seen_tx, shutdown_seen_rx) = tokio::sync::oneshot::channel();
    let (release_guest_tx, release_guest_rx) = tokio::sync::oneshot::channel();
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        shutdown_seen_tx.send(()).unwrap();
        let _ = release_guest_rx.await;
    });

    let (result, events) = capture_async_log_events(async {
        let stop = sandbox.stop();
        tokio::pin!(stop);
        tokio::select! {
            result = &mut stop => panic!("stop completed before timeout: {result:?}"),
            seen = shutdown_seen_rx => seen.unwrap(),
        }
        tokio::time::pause();
        tokio::time::advance(SHUTDOWN_TIMEOUT).await;
        stop.await
    })
    .await;

    result.unwrap();
    let _ = release_guest_tx.send(());
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    let event = assert_shutdown_failure_event(&events, &sandbox_id, "timeout");
    let elapsed_ms = captured_event_field(event, "elapsed_ms")
        .parse::<u64>()
        .unwrap();
    assert!(
        elapsed_ms >= duration_ms(SHUTDOWN_TIMEOUT),
        "shutdown timeout elapsed too early; event={event:#?}"
    );
    assert_event_field(event, "error", "request timeout");
}

#[tokio::test]
async fn stop_logs_shutdown_request_failure_and_reaches_stopped() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let sandbox_id = sandbox.id.clone();
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        drop(guest);
    });

    let (result, events) = capture_async_log_events(sandbox.stop()).await;

    result.unwrap();
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    let event = assert_shutdown_failure_event(&events, &sandbox_id, "request_failure");
    assert_event_field(event, "error", "connection closed");
}

#[tokio::test]
async fn stop_logs_unexpected_shutdown_response_and_kills_process() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let sandbox_id = sandbox.id.clone();
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let child = tokio::process::Command::new("cat")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let child_pid = child.id().unwrap();
    let process = monitor_process(
        &sandbox.id,
        child.into(),
        Arc::clone(&sandbox.state),
        Arc::clone(&sandbox.state_publish_lock),
        sandbox.state_tx.clone(),
        Arc::clone(&sandbox.guest),
        CancellationToken::new(),
    );
    sandbox.runtime.set_process(process);
    let guest_task = tokio::spawn(async move {
        let shutdown = read_vsock_message(&mut guest).await;
        assert_eq!(shutdown.msg_type, MSG_SHUTDOWN);
        let response = guest_control_proto::encode(MSG_PONG, shutdown.seq, &[]).unwrap();
        guest.write_all(&response).await.unwrap();
    });

    let (result, events) = capture_async_log_events(sandbox.stop()).await;

    result.unwrap();
    guest_task.await.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    assert!(!pid_is_running(child_pid), "fallback must kill the process");
    let event = assert_shutdown_failure_event(&events, &sandbox_id, "unexpected_response");
    assert!(
        captured_event_field(event, "error").contains("unexpected lifecycle response type"),
        "unexpected shutdown error; event={event:#?}"
    );
}

fn mib(value: i64) -> i64 {
    value * BYTES_PER_MIB
}

fn balloon_statistics(target_mib: u32, actual_mib: u32) -> BalloonStatistics {
    BalloonStatistics {
        target_mib,
        actual_mib,
        target_pages: u64::from(target_mib) * 256,
        actual_pages: u64::from(actual_mib) * 256,
        free_memory: None,
        available_memory: None,
        total_memory: None,
        swap_in: None,
        swap_out: None,
        major_faults: None,
        minor_faults: None,
        disk_caches: None,
    }
}

#[tokio::test]
async fn wait_for_balloon_rechecks_after_initial_25_ms_delay() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 0)),
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, target_mib)),
        ]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::time::pause();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "fast-start");
    tokio::pin!(wait);

    loop {
        if captured_message_count(&captured.entries(), "waiting for balloon") == 1 {
            break;
        }
        tokio::select! {
            outcome = &mut wait => {
                panic!("balloon wait completed before the first deficient sample: {outcome:?}");
            }
            () = tokio::task::yield_now() => {}
        }
    }

    let mut requests = api.drain_requests();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "GET" && request.path == "/balloon/statistics")
            .count(),
        1
    );

    tokio::time::advance(Duration::from_millis(24)).await;
    assert!(
        api.drain_requests().is_empty(),
        "the second statistics GET must not begin before 25 ms"
    );

    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::time::resume();
    let settle_result = wait.await;
    drop(guard);

    assert_eq!(settle_result.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        settle_result.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::TargetReached
    );
    requests.extend(api.drain_requests());
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "GET" && request.path == "/balloon/statistics")
            .count(),
        2
    );
}

#[tokio::test]
async fn wait_for_balloon_follows_exact_bounded_poll_schedule() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let request_entered = Arc::new(Notify::new());
    let response_release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::iter::repeat_with(|| MockBalloonStatsReply::GatedOk {
            entered: Arc::clone(&request_entered),
            release: Arc::clone(&response_release),
            stats: MockBalloonStats::new(target_mib, 0),
        })
        .take(28)
        .chain(std::iter::once(MockBalloonStatsReply::Status(500)))
        .collect(),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "bounded-schedule");
    tokio::pin!(wait);

    // Exercise through 4,775 ms. A 4,975 ms sample is not guaranteed because
    // each interval starts after the previous Unix-socket response completes.
    for (index, delay_ms) in std::iter::once(0_u64)
        .chain([25, 50, 100, 100, 100, 200, 200])
        .chain(std::iter::repeat_n(200, 20))
        .enumerate()
    {
        if delay_ms > 0 {
            tokio::time::advance(Duration::from_millis(delay_ms - 1)).await;
            assert!(
                futures_util::poll!(wait.as_mut()).is_pending(),
                "balloon wait completed before scheduled sample {}",
                index + 1
            );
            assert_eq!(
                captured_message_count(&captured.entries(), "waiting for balloon"),
                index,
                "statistics GET began before the scheduled delay of {delay_ms} ms"
            );
            tokio::time::advance(Duration::from_millis(1)).await;
            tokio::time::resume();
        }
        loop {
            tokio::select! {
                () = request_entered.notified() => break,
                outcome = &mut wait => {
                    panic!(
                        "balloon wait completed before statistics request {}; outcome={outcome:?}",
                        index + 1
                    );
                }
                () = tokio::task::yield_now() => {}
            }
        }
        tokio::time::pause();
        response_release.notify_one();
        let expected_sample_count = index + 1;
        loop {
            let sample_count = captured_message_count(&captured.entries(), "waiting for balloon");
            if sample_count == expected_sample_count {
                break;
            }
            tokio::select! {
                outcome = &mut wait => {
                    panic!(
                        "balloon wait completed after {sample_count} samples, expected {expected_sample_count}; outcome={outcome:?}"
                    );
                }
                () = tokio::task::yield_now() => {}
            }
        }
    }

    tokio::time::advance(BALLOON_SETTLE_INITIAL_TIMEOUT).await;
    tokio::time::resume();
    let outcome = wait.await;
    drop(guard);

    expect_severe_memory_retention(outcome.park_outcome);
    assert_eq!(
        outcome.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    let requests = api.drain_requests();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "GET" && request.path == "/balloon/statistics")
            .count(),
        28
    );
}

#[tokio::test]
async fn wait_for_balloon_extends_deadline_for_recent_safe_progress() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let initial_stats =
        MockBalloonStats::new(target_mib, 256).with_memory(mib(3840), mib(3940), mib(3940));
    let first_progressing_stats =
        MockBalloonStats::new(target_mib, 1200).with_memory(mib(3000), mib(3300), mib(3940));
    let second_progressing_stats =
        MockBalloonStats::new(target_mib, 2314).with_memory(mib(2136), mib(2265), mib(3940));
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(initial_stats),
            MockBalloonStatsReply::Ok(first_progressing_stats),
            MockBalloonStatsReply::Ok(second_progressing_stats),
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, target_mib)),
        ]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::time::pause();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "progress-grace");
    tokio::pin!(wait);

    advance_balloon_wait_to_progress_grace(wait.as_mut(), &captured).await;
    advance_balloon_wait_to_next_progress_grace(wait.as_mut(), &captured, 3, 2).await;
    tokio::time::resume();
    let outcome = wait.await;
    drop(guard);
    let events = captured.entries();

    assert_eq!(outcome.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        outcome.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::TargetReached
    );
    assert_eq!(
        captured_message_count(
            &events,
            "balloon inflation still progressing, extending settle deadline"
        ),
        2
    );
    let event = captured_event(
        &events,
        "balloon inflation still progressing, extending settle deadline",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "actual", "Some(1200)");
    assert_event_field(event, "target", "3072");
    assert_event_field(event, "deficit_mib", "Some(1872)");
    assert_event_field(event, "previous_actual_mib", "Some(256)");
    assert_event_field(event, "reported_free_mib", "Some(3000)");
    assert_event_field(event, "reported_available_mib", "Some(3300)");
    assert_event_field(event, "grace_ms", "5000");
    assert!(!has_captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway"
    ));
}

#[tokio::test]
async fn wait_for_balloon_progress_extensions_stop_when_progress_stalls() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let initial_stats =
        MockBalloonStats::new(target_mib, 256).with_memory(mib(3840), mib(3940), mib(3940));
    let first_progressing_stats =
        MockBalloonStats::new(target_mib, 1200).with_memory(mib(3000), mib(3300), mib(3940));
    let second_progressing_stats =
        MockBalloonStats::new(target_mib, 2314).with_memory(mib(2136), mib(2265), mib(3940));
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(initial_stats),
            MockBalloonStatsReply::Ok(first_progressing_stats),
            MockBalloonStatsReply::Ok(second_progressing_stats.clone()),
            MockBalloonStatsReply::Ok(second_progressing_stats),
        ]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::time::pause();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "bounded-progress-grace");
    tokio::pin!(wait);

    advance_balloon_wait_to_progress_grace(wait.as_mut(), &captured).await;
    advance_balloon_wait_to_next_progress_grace(wait.as_mut(), &captured, 3, 2).await;
    wait_for_balloon_sample_count(wait.as_mut(), &captured, 4).await;
    tokio::time::advance(BALLOON_SETTLE_PROGRESS_GRACE).await;
    tokio::time::resume();
    let outcome = wait.await;
    drop(guard);
    let events = captured.entries();

    expect_severe_memory_retention(outcome.park_outcome);
    assert_eq!(
        outcome.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    assert_eq!(
        captured_message_count(
            &events,
            "balloon inflation still progressing, extending settle deadline"
        ),
        2
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 15s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "Some(2314)");
    assert_event_field(event, "deficit_mib", "Some(758)");
    assert_event_field(event, "reason", "severe_deficit");
    assert_event_field(event, "admission_action", "reject_and_destroy");
}

#[tokio::test]
async fn wait_for_balloon_progress_extensions_stop_at_absolute_timeout() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let slow_stats_entered = Arc::new(Notify::new());
    let slow_stats_release = Arc::new(Notify::new());
    let progressing_stats = |actual_mib| {
        MockBalloonStats::new(target_mib, actual_mib).with_memory(mib(4096), mib(4096), mib(4096))
    };
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(progressing_stats(0)),
            MockBalloonStatsReply::Ok(progressing_stats(100)),
            MockBalloonStatsReply::Ok(progressing_stats(200)),
            MockBalloonStatsReply::Ok(progressing_stats(300)),
            MockBalloonStatsReply::Ok(progressing_stats(400)),
            MockBalloonStatsReply::Ok(progressing_stats(500)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&slow_stats_entered),
                release: Arc::clone(&slow_stats_release),
                stats: progressing_stats(600),
            },
        ]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::time::pause();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "absolute-progress-timeout");
    tokio::pin!(wait);

    advance_balloon_wait_to_progress_grace(wait.as_mut(), &captured).await;
    for (sample_count, grace_count) in [(3, 2), (4, 3), (5, 4), (6, 5)] {
        advance_balloon_wait_to_next_progress_grace(
            wait.as_mut(),
            &captured,
            sample_count,
            grace_count,
        )
        .await;
    }
    tokio::select! {
        () = slow_stats_entered.notified() => {}
        _ = wait.as_mut() => panic!("balloon wait completed before the final bounded request"),
    }
    tokio::time::advance(BALLOON_SETTLE_PROGRESS_GRACE).await;
    tokio::time::resume();
    let outcome = wait.await;
    slow_stats_release.notify_waiters();
    drop(guard);
    let events = captured.entries();

    expect_severe_memory_retention(outcome.park_outcome);
    assert_eq!(
        outcome.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    assert_eq!(
        captured_message_count(
            &events,
            "balloon inflation still progressing, extending settle deadline"
        ),
        5
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 30s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "Some(500)");
    assert_event_field(event, "reason", "severe_deficit");
    assert_event_field(event, "admission_action", "reject_and_destroy");
}

#[tokio::test]
async fn wait_for_balloon_near_target_logs_summary_without_timeout() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib,
            target_mib - 39,
        ))]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();

    let (settle_result, events) = capture_async_log_events(wait_for_balloon_with_outcome(
        &client,
        target_mib,
        "near-target",
    ))
    .await;

    assert_eq!(settle_result.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        settle_result.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::WithinTolerance
    );
    assert!(!has_captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway"
    ));
    let event = captured_event(
        &events,
        "balloon inflated within tolerance, proceeding to pause",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "actual", "3033");
    assert_event_field(event, "target", "3072");
    assert_event_field(event, "deficit_mib", "39");
    assert_event_field(event, "sample_count", "1");
    assert_event_field(event, "requested_target_mib", "3072");
    assert_event_field(event, "target_observed", "true");
    assert_event_field(event, "observed_target_mib", "Some(3072)");
    assert_event_field(event, "first_actual_mib", "Some(3033)");
    assert_event_field(event, "max_actual_mib", "Some(3033)");
    assert_event_field(event, "actual_delta_mib", "Some(0)");
}

#[tokio::test]
async fn wait_for_balloon_timeout_logs_actual_stalled_reason() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib, 800,
        ))]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();

    let (settle_result, events) = capture_balloon_timeout_after_sample(
        wait_for_balloon_with_outcome(&client, target_mib, "stalled"),
    )
    .await;

    assert_eq!(settle_result.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        settle_result.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "Some(800)");
    assert_event_field(event, "target", "1024");
    assert_event_field(event, "deficit_mib", "Some(224)");
    assert_event_field(event, "requested_target_mib", "1024");
    assert_event_field(event, "target_observed", "true");
    assert_event_field(event, "observed_target_mib", "Some(1024)");
    assert_event_field(event, "first_actual_mib", "Some(800)");
    assert_event_field(event, "max_actual_mib", "Some(800)");
    assert_event_field(event, "actual_delta_mib", "Some(0)");
    assert_event_field(event, "reason", "actual_stalled");
    assert_event_field(event, "admission_action", "reuse");
}

#[tokio::test]
async fn wait_for_balloon_reusable_progressing_timeout_logs_at_info() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 700)),
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 800)),
        ]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::time::pause();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "reusable-progress-timeout");
    tokio::pin!(wait);

    wait_for_balloon_sample_count(wait.as_mut(), &captured, 1).await;
    tokio::time::advance(BALLOON_SETTLE_FAST_POLL_INTERVALS[0]).await;
    tokio::time::resume();
    wait_for_balloon_sample_count(wait.as_mut(), &captured, 2).await;
    tokio::time::pause();
    tokio::time::advance(BALLOON_SETTLE_INITIAL_TIMEOUT - BALLOON_SETTLE_FAST_POLL_INTERVALS[0])
        .await;
    tokio::time::resume();
    let outcome = wait.await;
    drop(guard);
    let events = captured.entries();

    assert_eq!(outcome.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        outcome.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "actual", "Some(800)");
    assert_event_field(event, "deficit_mib", "Some(224)");
    assert_event_field(event, "reason", "actual_progressing_timeout");
    assert_event_field(event, "admission_action", "reuse");
}

#[tokio::test]
async fn wait_for_balloon_accepts_pressure_limited_partial_reclaim() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let stats = MockBalloonStats::new(target_mib, 800).with_memory(mib(64), mib(128), mib(2048));
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(stats)]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();

    let (settle_result, events) = capture_async_log_events(wait_for_balloon_with_outcome(
        &client,
        target_mib,
        "pressure-limited",
    ))
    .await;

    assert_eq!(settle_result.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        settle_result.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::PressureLimited
    );
    assert!(!has_captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway"
    ));
    let event = captured_event(
        &events,
        "balloon pressure-limited partial reclaim, proceeding to pause",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "actual", "800");
    assert_event_field(event, "target", "1024");
    assert_event_field(event, "deficit_mib", "224");
    assert_event_field(event, "tolerance_mib", "128");
    assert_event_field(event, "sample_count", "1");
    assert_event_field(event, "target_observed", "true");
    assert_event_field(event, "reported_free_mib", "Some(64)");
    assert_event_field(event, "reported_available_mib", "Some(128)");
    assert_event_field(event, "reason", "pressure_limited_partial_reclaim");
}

#[test]
fn balloon_settle_tolerance_is_capped_and_scales_for_small_targets() {
    assert_eq!(
        balloon_settle_tolerance_mib(4096 - balloon::MIN_GUEST_MIB),
        256
    );
    assert_eq!(
        balloon_settle_tolerance_mib(2048 - balloon::MIN_GUEST_MIB),
        128
    );
    assert_eq!(
        balloon_settle_tolerance_mib(1024 - balloon::MIN_GUEST_MIB),
        0
    );
    assert_eq!(balloon_settle_tolerance_mib(1), 0);
}

#[test]
fn balloon_settle_summary_classifies_progressing_timeout() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut summary = BalloonSettleSummary::new(target_mib);

    summary.observe(&balloon_statistics(target_mib, 700));
    summary.observe(&balloon_statistics(target_mib, 800));

    assert_eq!(summary.reason(), "actual_progressing_timeout");
    assert_eq!(summary.park_outcome(), SandboxParkOutcome::Reusable);
    assert_eq!(summary.last_actual_mib, Some(800));
    assert_eq!(summary.last_deficit_mib, Some(224));
    assert_eq!(summary.first_actual_mib, Some(700));
    assert_eq!(summary.max_actual_mib, Some(800));
    assert_eq!(summary.actual_delta_mib(), Some(100));
}

#[test]
fn pressure_limited_reclaim_ignores_free_memory_when_available_memory_is_missing() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let tolerance_mib = balloon_settle_tolerance_mib(target_mib);
    let mut available_summary = BalloonSettleSummary::new(target_mib);
    let mut available_stats = balloon_statistics(target_mib, 800);
    available_stats.free_memory = Some(mib(2048));
    available_stats.available_memory = Some(mib(128));
    available_stats.total_memory = Some(mib(2048));
    let available_deficit_mib = available_summary.observe(&available_stats);

    assert!(
        available_summary.is_pressure_limited_partial_reclaim(available_deficit_mib, tolerance_mib)
    );

    let mut missing_available_summary = BalloonSettleSummary::new(target_mib);
    let mut missing_available_stats = balloon_statistics(target_mib, 800);
    missing_available_stats.free_memory = Some(mib(32));
    missing_available_stats.total_memory = Some(mib(2048));
    let missing_available_deficit_mib = missing_available_summary.observe(&missing_available_stats);

    assert!(
        !missing_available_summary
            .is_pressure_limited_partial_reclaim(missing_available_deficit_mib, tolerance_mib)
    );
}

#[tokio::test]
async fn wait_for_balloon_timeout_logs_target_not_observed_reason() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            512, 800,
        ))]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();

    let (settle_result, events) = capture_balloon_timeout_after_sample(
        wait_for_balloon_with_outcome(&client, target_mib, "stale-target"),
    )
    .await;

    assert_eq!(settle_result.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        settle_result.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "target_observed", "false");
    assert_event_field(event, "observed_target_mib", "Some(512)");
    assert_event_field(event, "reason", "target_not_observed");
}

#[tokio::test]
async fn wait_for_balloon_stats_poll_is_bounded_by_settle_timeout() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::DelayedOk(
            BALLOON_SETTLE_INITIAL_TIMEOUT + Duration::from_secs(1),
            MockBalloonStats::new(target_mib, target_mib),
        )]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();

    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let wait = wait_for_balloon_with_outcome(&client, target_mib, "slow-stats");
    tokio::pin!(wait);
    let request = tokio::select! {
        request = api.api.next_request() => request,
        _ = &mut wait => panic!("balloon wait completed before requesting statistics"),
    };
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/balloon/statistics")
    );

    tokio::time::pause();
    tokio::time::advance(BALLOON_SETTLE_INITIAL_TIMEOUT).await;
    tokio::time::resume();
    let outcome = wait.await;
    drop(guard);
    let events = captured.entries();

    assert_eq!(outcome.park_outcome, SandboxParkOutcome::Reusable);
    assert_eq!(
        outcome.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "sample_count", "0");
    assert_event_field(event, "reason", "stats_unavailable");
    assert_event_field(event, "actual", "None");
    assert_event_field(event, "deficit_mib", "None");
}

#[tokio::test]
async fn wait_for_balloon_timeout_logs_severe_deficit_and_memory_stats() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let stats = MockBalloonStats::new(target_mib, 600)
        .with_memory(mib(32), mib(0), mib(2048))
        .with_extended_counters(11, 12, 13, 14, 15);
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(stats)]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();

    let (settle_result, events) = capture_balloon_timeout_after_sample(
        wait_for_balloon_with_outcome(&client, target_mib, "severe"),
    )
    .await;

    assert_eq!(
        settle_result.telemetry_outcome,
        SandboxFinalExecParkSubstageOutcome::Deadline
    );
    let diagnostics = expect_severe_memory_retention(settle_result.park_outcome);
    assert_eq!(diagnostics.requested_target_mib, target_mib);
    assert_eq!(diagnostics.first_observed_target_mib, Some(target_mib));
    assert_eq!(diagnostics.observed_target_mib, Some(target_mib));
    assert!(diagnostics.target_observed);
    assert_eq!(diagnostics.first_actual_mib, Some(600));
    assert_eq!(diagnostics.actual_mib, Some(600));
    assert_eq!(diagnostics.max_actual_mib, Some(600));
    assert_eq!(diagnostics.deficit_mib, Some(424));
    assert_eq!(diagnostics.actual_delta_mib, Some(0));
    assert_eq!(diagnostics.sample_count, 1);
    assert_eq!(diagnostics.reported_free_memory_bytes, Some(mib(32)));
    assert_eq!(diagnostics.reported_available_memory_bytes, Some(0));
    assert_eq!(diagnostics.reported_total_memory_bytes, Some(mib(2048)));
    assert_eq!(diagnostics.reported_swap_in_bytes, Some(11));
    assert_eq!(diagnostics.reported_swap_out_bytes, Some(12));
    assert_eq!(diagnostics.reported_major_faults, Some(13));
    assert_eq!(diagnostics.reported_minor_faults, Some(14));
    assert_eq!(diagnostics.reported_disk_caches_bytes, Some(15));
    assert_eq!(diagnostics.guest_memory_snapshot, None);
    let event = captured_event(
        &events,
        "balloon inflate incomplete after 5s, pausing anyway",
    );
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "Some(600)");
    assert_event_field(event, "deficit_mib", "Some(424)");
    assert_event_field(event, "reported_free_mib", "Some(32)");
    assert_event_field(event, "reported_available_mib", "Some(0)");
    assert_event_field(event, "reported_total_mib", "Some(2048)");
    assert_event_field(event, "reason", "severe_deficit");
    assert_event_field(event, "admission_action", "reject_and_destroy");
}

#[tokio::test]
async fn park_pauses_when_balloon_stats_are_unavailable() {
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Status(500)]),
    );
    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();

    let (result, events) = {
        let ((_substage_events, result), events) = capture_async_log_events(park_inner_with_guest(
            &mut is_parked,
            2048,
            &mut controller,
            api.socket_path(),
            "stats-error",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: None,
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        ))
        .await;
        (result, events)
    };
    result.unwrap();

    assert!(is_parked);
    let event = captured_event(&events, "balloon stats unavailable, proceeding to pause");
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "actual", "None");
    assert_event_field(event, "deficit_mib", "None");
    assert_event_field(event, "sample_count", "0");
    assert_event_field(event, "reason", "stats_unavailable");
    assert_eq!(
        observer.substage_records,
        vec![
            (SandboxFinalExecParkSubstage::BalloonSetup, true, None,),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::StatsUnavailable),
            ),
            (SandboxFinalExecParkSubstage::VcpuPause, true, None),
        ]
    );
    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn exact_handoff_skips_balloon_target_but_still_pauses() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);
    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();
    let handoff = SandboxFinalExecParkHandoff::new();
    assert!(handoff.request());

    let result = {
        let (_events, result) = park_inner_with_guest_and_handoff(
            &mut is_parked,
            2048,
            &mut controller,
            api.socket_path(),
            "handoff-before-balloon",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: Some(&handoff),
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        )
        .await;
        result
    };

    assert!(matches!(
        result.unwrap(),
        PhysicalParkOutcome::Handoff(SandboxFinalExecParkHandoffPoint::BeforeBalloon)
    ));
    assert!(is_parked);
    assert!(controller.is_none());
    assert_eq!(
        observer.substage_records,
        vec![
            (
                SandboxFinalExecParkSubstage::BalloonSetup,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::HandoffRequested),
            ),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (SandboxFinalExecParkSubstage::VcpuPause, true, None),
        ]
    );
    let requests = api.drain_requests();
    let patches = patches(&requests);
    assert_eq!(patches.len(), 1, "handoff should only pause the VM");
    assert_eq!(patches[0].path, "/vm");
}

#[tokio::test]
async fn exact_handoff_interrupts_in_flight_balloon_settle() {
    let stats_entered = Arc::new(Notify::new());
    let stats_release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::GatedOk {
            entered: Arc::clone(&stats_entered),
            release: Arc::clone(&stats_release),
            stats: MockBalloonStats::new(1536, 0),
        }]),
    );
    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();
    let handoff = SandboxFinalExecParkHandoff::new();
    let result = {
        let park = park_inner_with_guest_and_handoff(
            &mut is_parked,
            2048,
            &mut controller,
            api.socket_path(),
            "handoff-during-balloon",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: Some(&handoff),
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        );
        tokio::pin!(park);

        tokio::select! {
            () = stats_entered.notified() => {}
            _ = park.as_mut() => panic!("park completed before balloon settle was interrupted"),
        }
        assert!(handoff.request());
        let (_events, result) = tokio::time::timeout(Duration::from_secs(1), park.as_mut())
            .await
            .expect("handoff should wake the in-flight balloon request");
        result
    };
    stats_release.notify_waiters();

    assert!(matches!(
        result.unwrap(),
        PhysicalParkOutcome::Handoff(SandboxFinalExecParkHandoffPoint::DuringBalloonSettle)
    ));
    assert!(is_parked);
    assert!(controller.is_none());
    assert_eq!(
        observer.substage_records,
        vec![
            (SandboxFinalExecParkSubstage::BalloonSetup, true, None),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::HandoffRequested),
            ),
            (SandboxFinalExecParkSubstage::VcpuPause, true, None),
        ]
    );
    let requests = api.drain_requests();
    let patches = patches(&requests);
    assert_eq!(
        patches.len(),
        2,
        "handoff should inflate once and then pause"
    );
    assert_eq!(patches[0].path, "/balloon");
    assert_eq!(patches[1].path, "/vm");
}

#[tokio::test]
async fn exact_handoff_interrupts_balloon_settle_after_multiple_progress_extensions() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let stats_entered = Arc::new(Notify::new());
    let stats_release = Arc::new(Notify::new());
    let initial_stats =
        MockBalloonStats::new(target_mib, 256).with_memory(mib(3840), mib(3940), mib(3940));
    let first_progressing_stats =
        MockBalloonStats::new(target_mib, 1200).with_memory(mib(3000), mib(3300), mib(3940));
    let second_progressing_stats =
        MockBalloonStats::new(target_mib, 2314).with_memory(mib(2136), mib(2265), mib(3940));
    let api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(initial_stats),
            MockBalloonStatsReply::Ok(first_progressing_stats),
            MockBalloonStatsReply::Ok(second_progressing_stats),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&stats_entered),
                release: Arc::clone(&stats_release),
                stats: MockBalloonStats::new(target_mib, target_mib),
            },
        ]),
    );
    let client = ApiClient::new(api.socket_path()).unwrap();
    let handoff = SandboxFinalExecParkHandoff::new();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    tokio::time::pause();
    let wait = wait_for_balloon_with_optional_handoff(
        &client,
        target_mib,
        "handoff-after-progress-extensions",
        Some(&handoff),
    );
    tokio::pin!(wait);

    advance_balloon_wait_to_progress_grace(wait.as_mut(), &captured).await;
    advance_balloon_wait_to_next_progress_grace(wait.as_mut(), &captured, 3, 2).await;
    tokio::select! {
        () = stats_entered.notified() => {}
        _ = wait.as_mut() => panic!("balloon wait completed before handoff was requested"),
    }
    assert!(handoff.request());
    tokio::time::resume();
    let outcome = tokio::time::timeout(Duration::from_secs(1), wait)
        .await
        .expect("handoff should wake the extended balloon request");
    stats_release.notify_waiters();
    drop(guard);

    assert!(matches!(outcome, BalloonSettleWaitResult::Handoff));
    assert_eq!(
        captured_message_count(
            &captured.entries(),
            "balloon inflation still progressing, extending settle deadline"
        ),
        2
    );
}

#[tokio::test]
async fn snapshot_restore_with_limiters_loads_paused_patches_then_resumes() {
    let mut api =
        MockLifecycleApi::new(std::collections::VecDeque::from(vec![204, 204, 204]), None);
    let client = ApiClient::new(api.socket_path()).unwrap();
    let rate_limits = test_rate_limits();

    load_snapshot_and_apply_rate_limits(&client, "/snap/state", "/snap/memory", Some(&rate_limits))
        .await
        .unwrap();

    let reqs = api.drain_requests();
    assert_eq!(
        reqs.len(),
        5,
        "expected load, rootfs drive patch, workspace drive patch, network patch, resume"
    );
    assert_eq!(reqs[0].method, "PUT");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);

    assert_eq!(reqs[1].method, "PATCH");
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert_eq!(
        mock_request_body_json(&reqs[1])["rate_limiter"]["bandwidth"]["size"],
        512
    );

    assert_eq!(reqs[2].method, "PATCH");
    assert_eq!(reqs[2].path, "/drives/workspace");
    assert_eq!(
        mock_request_body_json(&reqs[2])["rate_limiter"]["bandwidth"]["size"],
        512
    );

    assert_eq!(reqs[3].method, "PATCH");
    assert_eq!(reqs[3].path, "/network-interfaces/eth0");
    assert_eq!(
        mock_request_body_json(&reqs[3])["rx_rate_limiter"]["bandwidth"]["size"],
        2048
    );
    assert_eq!(
        mock_request_body_json(&reqs[3])["tx_rate_limiter"]["bandwidth"]["size"],
        4096
    );

    assert_eq!(reqs[4].method, "PATCH");
    assert_eq!(reqs[4].path, "/vm");
    assert!(reqs[4].body.contains("Resumed"));
}

#[tokio::test]
async fn snapshot_restore_without_limiters_loads_and_resumes_without_patching() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);
    let client = ApiClient::new(api.socket_path()).unwrap();

    load_snapshot_and_apply_rate_limits(&client, "/snap/state", "/snap/memory", None)
        .await
        .unwrap();

    let reqs = api.drain_requests();
    assert_eq!(reqs.len(), 1, "expected only snapshot load");
    assert_eq!(reqs[0].method, "PUT");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], true);
}

#[tokio::test]
async fn snapshot_restore_limiter_patch_failure_does_not_resume() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::from(vec![500]), None);
    let client = ApiClient::new(api.socket_path()).unwrap();
    let rate_limits = test_rate_limits();

    let err = load_snapshot_and_apply_rate_limits(
        &client,
        "/snap/state",
        "/snap/memory",
        Some(&rate_limits),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(err.contains("snapshot drive rate limiter patch failed"));
    let reqs = api.drain_requests();
    assert_eq!(reqs.len(), 2, "resume must not be attempted");
    assert_eq!(reqs[0].method, "PUT");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
    assert_eq!(reqs[1].method, "PATCH");
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert!(reqs.iter().all(|request| request.path != "/vm"));
}

#[tokio::test]
async fn snapshot_restore_workspace_limiter_patch_failure_does_not_resume() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::from(vec![204, 500]), None);
    let client = ApiClient::new(api.socket_path()).unwrap();
    let rate_limits = test_rate_limits();

    let err = load_snapshot_and_apply_rate_limits(
        &client,
        "/snap/state",
        "/snap/memory",
        Some(&rate_limits),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(err.contains("snapshot workspace drive rate limiter patch failed"));
    let reqs = api.drain_requests();
    assert_eq!(
        reqs.len(),
        3,
        "network patch and resume must not be attempted"
    );
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert_eq!(reqs[2].path, "/drives/workspace");
    assert!(
        reqs.iter()
            .all(|request| request.path != "/network-interfaces/eth0")
    );
    assert!(reqs.iter().all(|request| request.path != "/vm"));
}

#[tokio::test]
async fn snapshot_restore_network_limiter_patch_failure_does_not_resume() {
    let mut api =
        MockLifecycleApi::new(std::collections::VecDeque::from(vec![204, 204, 500]), None);
    let client = ApiClient::new(api.socket_path()).unwrap();
    let rate_limits = test_rate_limits();

    let err = load_snapshot_and_apply_rate_limits(
        &client,
        "/snap/state",
        "/snap/memory",
        Some(&rate_limits),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(err.contains("snapshot network rate limiter patch failed"));
    let reqs = api.drain_requests();
    assert_eq!(reqs.len(), 4, "resume must not be attempted");
    assert_eq!(reqs[0].path, "/snapshot/load");
    assert_eq!(mock_request_body_json(&reqs[0])["resume_vm"], false);
    assert_eq!(reqs[1].path, "/drives/rootfs");
    assert_eq!(reqs[2].path, "/drives/workspace");
    assert_eq!(reqs[3].path, "/network-interfaces/eth0");
    assert!(reqs.iter().all(|request| request.path != "/vm"));
}

fn test_balloon_controller() -> balloon::ControllerHandle {
    balloon::ControllerHandle::from_task_for_test(tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(3600)).await
    }))
}

#[tokio::test]
async fn park_inflates_and_pauses() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "test-park",
    )
    .await
    .unwrap();

    assert!(is_parked, "is_parked should be set");
    assert!(controller.is_none(), "controller handle should be taken");

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(
        ps.len(),
        2,
        "expected balloon inflate + vm pause, got {ps:?}"
    );
    assert_eq!(ps[0].path, "/balloon");
    let parsed: serde_json::Value = serde_json::from_str(&ps[0].body).unwrap();
    assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 1024);
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_inflates_by_one_at_min_plus_one() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        balloon::MIN_GUEST_MIB + 1,
        &mut controller,
        api.socket_path(),
        "test-min-plus-1",
    )
    .await
    .unwrap();

    assert!(is_parked);
    assert!(controller.is_none());
    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2);
    assert_eq!(ps[0].path, "/balloon");
    let parsed: serde_json::Value = serde_json::from_str(&ps[0].body).unwrap();
    assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 1);
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_small_vm_skips_balloon_but_pauses_vcpus() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();

    let result = {
        let (_events, result) = park_inner_with_guest(
            &mut is_parked,
            balloon::MIN_GUEST_MIB,
            &mut controller,
            api.socket_path(),
            "test-park-small",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: None,
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        )
        .await;
        result
    };
    result.unwrap();

    assert!(is_parked, "is_parked should be set");
    let still_there = controller.as_ref().expect("controller must be preserved");
    assert_eq!(
        still_there.id(),
        original_id,
        "controller must not be replaced or aborted"
    );

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "expected only vm pause, no balloon PATCH");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Paused"));
    assert_eq!(
        observer.substage_records,
        vec![
            (
                SandboxFinalExecParkSubstage::BalloonSetup,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (SandboxFinalExecParkSubstage::VcpuPause, true, None),
        ]
    );
}

#[tokio::test]
async fn unpark_resumes_and_deflates() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "test-unpark",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();

    assert!(!is_parked, "is_parked should be cleared");
    assert!(
        controller.is_some(),
        "reactive controller must be respawned"
    );

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    // resume, then deflate (+ possible reactive controller PATCHes)
    assert!(ps.len() >= 2, "expected at least resume + deflate");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
    assert_eq!(ps[1].path, "/balloon");
    let parsed: serde_json::Value = serde_json::from_str(&ps[1].body).unwrap();
    assert_eq!(parsed["amount_mib"].as_u64().unwrap(), 0);

    if let Some(h) = controller.take() {
        h.abort();
    }
}

#[tokio::test]
async fn terminal_unpark_resumes_and_deflates_without_background_controller() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx,
        "test-terminal-unpark",
        UnparkPurpose::TerminalOperations,
    )
    .await
    .unwrap();

    assert!(!is_parked, "is_parked should be cleared");
    assert!(
        controller.is_none(),
        "terminal unpark must not start a background controller"
    );

    let requests = api.drain_requests();
    let patches = patches(&requests);
    assert_eq!(patches.len(), 2, "expected resume followed by deflate");
    assert_eq!(patches[0].path, "/vm");
    assert!(patches[0].body.contains("Resumed"));
    assert_eq!(patches[1].path, "/balloon");
    let body: serde_json::Value = serde_json::from_str(&patches[1].body).unwrap();
    assert_eq!(body["amount_mib"].as_u64().unwrap(), 0);
}

#[tokio::test]
async fn unpark_returns_while_controller_guards_pending_deflation() {
    let lagging_stats_entered = Arc::new(Notify::new());
    let release_lagging_stats = Arc::new(Notify::new());
    let converged_stats_entered = Arc::new(Notify::new());
    let release_converged_stats = Arc::new(Notify::new());
    let active_stats_entered = Arc::new(Notify::new());
    let release_active_stats = Arc::new(Notify::new());
    let lagging_stats = MockBalloonStats::new(0, 3581).with_memory(
        3431 * BYTES_PER_MIB,
        3506 * BYTES_PER_MIB,
        3934 * BYTES_PER_MIB,
    );
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&lagging_stats_entered),
                release: Arc::clone(&release_lagging_stats),
                stats: lagging_stats,
            },
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&converged_stats_entered),
                release: Arc::clone(&release_converged_stats),
                stats: MockBalloonStats::new(0, 0),
            },
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&active_stats_entered),
                release: Arc::clone(&release_active_stats),
                stats: MockBalloonStats::new(0, 0),
            },
        ]),
    );
    let api_socket = api.socket_path().to_path_buf();
    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        4096,
        &mut controller,
        &api_socket,
        state_rx,
        "test-unpark-lagging-actual",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(
        controller.is_some(),
        "protected controller should be installed without waiting for deflation"
    );

    lagging_stats_entered.notified().await;
    let unpark_requests = api.drain_requests();
    let unpark_patches = patches(&unpark_requests);
    assert_eq!(unpark_patches.len(), 2);
    assert_eq!(unpark_patches[0].path, "/vm");
    assert_eq!(unpark_patches[1].path, "/balloon");
    assert_eq!(mock_request_body_json(unpark_patches[1])["amount_mib"], 0);

    release_lagging_stats.notify_one();
    converged_stats_entered.notified().await;
    let guarded_requests = api.drain_requests();
    assert!(
        patches(&guarded_requests).is_empty(),
        "the contradictory high-free sample must not reverse target-zero deflation"
    );

    release_converged_stats.notify_one();
    active_stats_entered.notified().await;
    assert!(
        patches(&api.drain_requests()).is_empty(),
        "normal policy must not start before exact deflation"
    );

    release_active_stats.notify_one();
    state_tx.send(SandboxState::Stopped).unwrap();
    if let Some(handle) = controller.take() {
        handle.abort_and_join().await;
    }
}

#[tokio::test]
async fn unpark_propagates_deflate_error() {
    // Resume succeeds (204), deflate fails (400).
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::from(vec![204, 400]), None);

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    let result = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "test-unpark-err",
        UnparkPurpose::Reuse,
    )
    .await;

    assert_idle_transition(result, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true on failure");
    assert!(
        controller.is_none(),
        "controller must not be respawned on failure"
    );

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected resume + failed deflate");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
    assert_eq!(ps[1].path, "/balloon");
}

#[tokio::test]
async fn unpark_small_vm_skips_balloon_but_resumes_vcpus() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = true;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        balloon::MIN_GUEST_MIB,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "test-unpark-small",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();

    assert!(!is_parked);
    let still_there = controller.as_ref().expect("controller must be preserved");
    assert_eq!(
        still_there.id(),
        original_id,
        "controller must not be replaced"
    );

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "expected only vm resume, no balloon PATCH");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
}

#[tokio::test]
async fn double_park_is_idempotent() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "dp",
    )
    .await
    .unwrap();
    park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "dp",
    )
    .await
    .unwrap();

    assert!(is_parked);
    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(
        ps.len(),
        2,
        "expected exactly one park sequence (inflate + pause) despite double-park"
    );
}

#[tokio::test]
async fn double_unpark_is_idempotent() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "du",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();
    let first_controller_id = controller.as_ref().unwrap().id();

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "du",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();

    assert!(!is_parked);
    assert_eq!(
        controller.as_ref().unwrap().id(),
        first_controller_id,
        "second unpark must not replace the controller"
    );
    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    let deflate_count = ps.iter().filter(|r| r.path == "/balloon").count();
    assert_eq!(deflate_count, 1, "expected exactly one deflate PATCH");

    if let Some(h) = controller.take() {
        h.abort();
    }
}

#[tokio::test]
async fn unpark_without_park_is_noop() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = false;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "fresh",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();

    assert!(!is_parked);
    assert_eq!(
        controller.as_ref().unwrap().id(),
        original_id,
        "controller must not be touched"
    );
    assert!(patches(&api.drain_requests()).is_empty());
}

#[tokio::test]
async fn park_unpark_park_cycle() {
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::new(), None);

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    // Turn 1: park.
    park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "cycle",
    )
    .await
    .unwrap();
    assert!(is_parked);
    assert!(controller.is_none());

    // Turn 2: unpark → park.
    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "cycle",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(controller.is_some(), "unpark must respawn the controller");

    park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "cycle",
    )
    .await
    .unwrap();
    assert!(is_parked);
    assert!(
        controller.is_none(),
        "second park must abort the controller respawned by unpark"
    );

    // PATCH sequence: inflate, pause, resume, deflate, inflate, pause.
    // Filter to only PATCHes (ignoring GET /balloon/statistics from
    // wait_for_balloon and the respawned reactive controller).
    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    let ops: Vec<(&str, Option<u64>)> = ps
        .iter()
        .map(|r| {
            let amt = serde_json::from_str::<serde_json::Value>(&r.body)
                .ok()
                .and_then(|v| v["amount_mib"].as_u64());
            (r.path.as_str(), amt)
        })
        .collect();
    assert_eq!(
        ops,
        vec![
            ("/balloon", Some(1024)), // park 1: inflate
            ("/vm", None),            // park 1: pause
            ("/vm", None),            // unpark: resume
            ("/balloon", Some(0)),    // unpark: deflate
            ("/balloon", Some(1024)), // park 2: inflate
            ("/vm", None),            // park 2: pause
        ],
        "unexpected PATCH sequence: {ops:?}"
    );
}

#[tokio::test]
async fn park_balloon_failure_leaves_flag_false() {
    // Balloon inflate fails (400). Pause should not be attempted.
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::from(vec![400]), None);

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();

    let result = {
        let (_events, result) = park_inner_with_guest(
            &mut is_parked,
            2048,
            &mut controller,
            api.socket_path(),
            "test-park-fail",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: None,
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        )
        .await;
        result
    };

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(!is_parked, "flag must stay false on failure");
    assert!(controller.is_none());

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "only balloon inflate should be attempted");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(
        observer.substage_records,
        vec![(
            SandboxFinalExecParkSubstage::BalloonSetup,
            false,
            Some(SandboxFinalExecParkSubstageOutcome::Failed),
        )]
    );
    // A follow-up unpark must be a clean no-op because is_parked is false.
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "test-park-fail",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(controller.is_none());
}

#[tokio::test]
async fn park_retry_after_failure_succeeds() {
    // First park: balloon fails (400). Second park: balloon OK (204), pause OK (204).
    let mut api =
        MockLifecycleApi::new(std::collections::VecDeque::from(vec![400, 204, 204]), None);

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let first = park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "retry",
    )
    .await;
    assert_idle_transition(first, SandboxIdleTransition::Park);
    assert!(!is_parked);
    assert!(controller.is_none());

    park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "retry",
    )
    .await
    .unwrap();
    assert!(is_parked);

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    // First attempt: balloon(400). Second: balloon(204) + pause(204).
    assert_eq!(ps.len(), 3);
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/balloon");
    assert_eq!(ps[2].path, "/vm");
    assert!(ps[2].body.contains("Paused"));
}

#[tokio::test]
async fn unpark_retry_after_failure_succeeds() {
    // First unpark: resume fails (500 — genuine error, not idempotent 400).
    // Second unpark: resume OK (204), deflate OK (204).
    let mut api =
        MockLifecycleApi::new(std::collections::VecDeque::from(vec![500, 204, 204]), None);

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    let first = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "retry",
        UnparkPurpose::Reuse,
    )
    .await;
    assert_idle_transition(first, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true on failure");
    assert!(controller.is_none());

    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "retry",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(controller.is_some(), "controller must be respawned");

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 3);
    // First attempt: resume(500).
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
    // Second attempt: resume(204), deflate(204).
    assert_eq!(ps[1].path, "/vm");
    assert_eq!(ps[2].path, "/balloon");

    if let Some(h) = controller.take() {
        h.abort();
    }
}

// -- new tests for vCPU pause/resume --

#[tokio::test]
async fn park_pause_http_400_propagates_as_idle_transition() {
    // Balloon inflate succeeds and observes a severe deficit. The next stats
    // request fails, terminating settle with that severe classification, but
    // the final VM pause returns a Firecracker fault and must remain an
    // operational error.
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::from(vec![204, 400]),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 0)),
            MockBalloonStatsReply::Status(500),
        ]),
    );

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let result = park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "pause-fail",
    )
    .await;

    assert_idle_transition_message(
        result,
        SandboxIdleTransition::Park,
        "vm pause: HTTP 400: test",
    );
    assert!(!is_parked, "flag must stay false on failure");
    // Controller was aborted before balloon PATCH.
    assert!(controller.is_none());

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2);
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
}

#[tokio::test]
async fn unpark_resume_http_400_propagates_as_idle_transition() {
    // A Firecracker resume fault must not be mistaken for an already-running
    // VM. No deflate should be attempted.
    let mut api = MockLifecycleApi::new(std::collections::VecDeque::from(vec![400]), None);

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    let result = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "resume-fail",
        UnparkPurpose::Reuse,
    )
    .await;

    assert_idle_transition_message(
        result,
        SandboxIdleTransition::Unpark,
        "vm resume: HTTP 400: test",
    );
    assert!(is_parked, "flag must stay true on failure");
    assert!(controller.is_none(), "controller must not be respawned");

    let reqs = api.drain_requests();
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 1, "only resume should be attempted, no deflate");
    assert_eq!(ps[0].path, "/vm");
    assert!(ps[0].body.contains("Resumed"));
}

#[tokio::test]
async fn unpark_retry_after_partial_failure_resumes_idempotently() {
    // First unpark: resume OK (204), deflate fails (400).
    // Second unpark: repeated resume OK (204), deflate OK (204).
    let api = MockLifecycleApi::new(
        std::collections::VecDeque::from(vec![204, 400, 204, 204]),
        None,
    );

    let mut is_parked = true;
    let mut controller: Option<balloon::ControllerHandle> = None;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);

    // First attempt: resume OK, deflate fails.
    let first = unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "idem",
        UnparkPurpose::Reuse,
    )
    .await;
    assert_idle_transition(first, SandboxIdleTransition::Unpark);
    assert!(is_parked, "flag must stay true after partial failure");

    // Firecracker accepts the repeated target-state request.
    unpark_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        state_rx.clone(),
        "idem",
        UnparkPurpose::Reuse,
    )
    .await
    .unwrap();
    assert!(!is_parked);
    assert!(
        controller.is_some(),
        "controller must be respawned on success"
    );

    if let Some(h) = controller.take() {
        h.abort();
    }
}

#[tokio::test]
async fn park_waits_for_balloon_before_pause() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let ready_response_entered = Arc::new(Notify::new());
    let release_ready_response = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 0)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&ready_response_entered),
                release: Arc::clone(&release_ready_response),
                stats: MockBalloonStats::new(target_mib, target_mib),
            },
        ]),
    );
    let socket_path = api.socket_path().to_path_buf();

    let mut park_task = tokio::spawn(async move {
        let mut controller = Some(test_balloon_controller());
        let mut is_parked = false;
        let result = park_inner(
            &mut is_parked,
            2048,
            &mut controller,
            &socket_path,
            "wait-test",
        )
        .await;
        (result, is_parked, controller)
    });

    let early_park_result = tokio::select! {
        result = &mut park_task => Some(result),
        () = ready_response_entered.notified() => None,
    };
    let completed_before_release = park_task.is_finished();
    let requests_before_release = api.drain_requests();
    release_ready_response.notify_one();
    let park_result = match early_park_result {
        Some(result) => result,
        None => park_task.await,
    };

    assert!(
        !completed_before_release,
        "park completed before the target-reaching statistics response was released"
    );
    let (result, is_parked, controller) = park_result.unwrap();
    result.unwrap();

    let request_paths_before_release: Vec<_> = requests_before_release
        .iter()
        .map(|request| (request.method.as_str(), request.path.as_str()))
        .collect();
    assert_eq!(
        request_paths_before_release,
        [
            ("PATCH", "/balloon"),
            ("GET", "/balloon/statistics"),
            ("GET", "/balloon/statistics"),
        ],
        "VM pause must be withheld while the target-reaching response is gated"
    );

    assert!(is_parked);
    assert!(controller.is_none());
    let mut reqs = requests_before_release;
    reqs.extend(api.drain_requests());
    let stats_gets = reqs
        .iter()
        .filter(|request| request.method == "GET" && request.path == "/balloon/statistics")
        .count();
    assert_eq!(stats_gets, 2);

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2);
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_pauses_when_balloon_is_within_settle_tolerance() {
    // Production samples have shown 4 GiB VMs often settling with a
    // low-hundreds MiB residual while the guest reports little available
    // memory. That is close enough to park without waiting for the full
    // timeout and emitting a WARN.
    let balloon_actual = Arc::new(AtomicU32::new(4096 - balloon::MIN_GUEST_MIB - 39));
    let mut api = MockLifecycleApi::new(
        std::collections::VecDeque::new(),
        Some(Arc::clone(&balloon_actual)),
    );

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        4096,
        &mut controller,
        api.socket_path(),
        "near-test",
    )
    .await
    .unwrap();

    assert!(is_parked);
    let reqs = api.drain_requests();
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert_eq!(
        stats_gets, 1,
        "near-target balloon should settle on the first stats poll"
    );

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_pauses_when_balloon_deficit_equals_settle_tolerance() {
    let target_mib = 4096 - balloon::MIN_GUEST_MIB;
    let balloon_actual = Arc::new(AtomicU32::new(
        target_mib - balloon_settle_tolerance_mib(target_mib),
    ));
    let mut api = MockLifecycleApi::new(
        std::collections::VecDeque::new(),
        Some(Arc::clone(&balloon_actual)),
    );

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    park_inner(
        &mut is_parked,
        4096,
        &mut controller,
        api.socket_path(),
        "tolerance-edge",
    )
    .await
    .unwrap();

    assert!(is_parked);
    let reqs = api.drain_requests();
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert_eq!(
        stats_gets, 1,
        "exact tolerance boundary should settle on the first stats poll"
    );

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_pauses_when_balloon_reclaim_is_pressure_limited() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let stats = MockBalloonStats::new(target_mib, 800).with_memory(mib(64), mib(128), mib(2048));
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(stats)]),
    );

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let (result, events) = capture_async_log_events(park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "pressure-limited-park",
    ))
    .await;
    assert_eq!(result.unwrap(), SandboxParkOutcome::Reusable);

    assert!(is_parked);
    assert!(controller.is_none());
    let event = captured_event(
        &events,
        "balloon pressure-limited partial reclaim, proceeding to pause",
    );
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "reason", "pressure_limited_partial_reclaim");

    let reqs = api.drain_requests();
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert_eq!(
        stats_gets, 1,
        "pressure-limited balloon should settle on the first stats poll"
    );

    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn park_rejects_severe_balloon_retention_after_pausing() {
    // Balloon never progresses despite observing the requested target.
    // Parking must still pause the VM, then report it as non-reusable.
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib, 0,
        ))]),
    );

    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;

    let (result, _) = capture_balloon_timeout_after_sample(park_inner(
        &mut is_parked,
        2048,
        &mut controller,
        api.socket_path(),
        "timeout-test",
    ))
    .await;
    let outcome = result.unwrap();

    let diagnostics = expect_severe_memory_retention(outcome);
    assert_eq!(diagnostics.guest_memory_snapshot, None);
    assert!(is_parked);

    let reqs = api.drain_requests();

    // At least one stats poll must have occurred before the timeout.
    let stats_gets = reqs
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/balloon/statistics")
        .count();
    assert!(
        stats_gets >= 1,
        "expected at least one balloon stats poll before timeout, got {stats_gets}"
    );

    // Final PATCH must be the vm pause.
    let ps = patches(&reqs);
    assert_eq!(ps.len(), 2, "expected balloon inflate + vm pause");
    assert_eq!(ps[0].path, "/balloon");
    assert_eq!(ps[1].path, "/vm");
    assert!(ps[1].body.contains("Paused"));
}

#[tokio::test]
async fn severe_park_collects_terminal_guest_memory_before_pause() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(target_mib, 0)),
            MockBalloonStatsReply::Status(500),
        ]),
    );
    let socket_path = api.socket_path().to_path_buf();
    let (guest, mut guest_stream) = connected_mock_guest().await;
    let retained_guest = Arc::clone(&guest);

    let park_task = tokio::spawn(async move {
        let mut controller = Some(test_balloon_controller());
        let mut is_parked = false;
        let (_, outcome) = park_inner_with_guest(
            &mut is_parked,
            2048,
            &mut controller,
            &socket_path,
            "terminal-memory-snapshot",
            PhysicalParkRequest {
                guest,
                handoff: None,
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(None),
        )
        .await;
        (outcome, is_parked)
    });

    let request = read_vsock_message(&mut guest_stream).await;
    assert_eq!(request.msg_type, MSG_MEMORY_SNAPSHOT);
    assert!(request.payload.is_empty());
    let requests_before_snapshot = api.drain_requests();
    assert!(
        patches(&requests_before_snapshot)
            .iter()
            .all(|request| request.path != "/vm"),
        "Firecracker must not pause before the terminal guest snapshot"
    );

    let snapshot = test_guest_memory_snapshot();
    let response = guest_control_proto::encode(
        MSG_MEMORY_SNAPSHOT_RESULT,
        request.seq,
        &snapshot.encode_payload(),
    )
    .unwrap();
    guest_stream.write_all(&response).await.unwrap();

    let (result, is_parked) = park_task.await.unwrap();
    let diagnostics = expect_severe_memory_retention(result.unwrap());
    assert_eq!(
        diagnostics.guest_memory_snapshot,
        Some(guest_memory_snapshot(snapshot))
    );
    assert!(is_parked);
    assert!(retained_guest.lock().await.is_some());

    let mut requests = requests_before_snapshot;
    requests.extend(api.drain_requests());
    let pause = patches(&requests)
        .into_iter()
        .find(|request| request.path == "/vm")
        .expect("severe park should pause Firecracker after the guest snapshot");
    assert!(pause.body.contains("Paused"));
}

#[tokio::test]
async fn reusable_park_does_not_request_terminal_guest_memory() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([MockBalloonStatsReply::Ok(MockBalloonStats::new(
            target_mib, target_mib,
        ))]),
    );
    let (guest, guest_stream) = connected_mock_guest().await;
    let retained_guest = Arc::clone(&guest);
    let mut controller = Some(test_balloon_controller());
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();

    let outcome = {
        let (_events, outcome) = park_inner_with_guest(
            &mut is_parked,
            2048,
            &mut controller,
            api.socket_path(),
            "reusable-no-memory-snapshot",
            PhysicalParkRequest {
                guest,
                handoff: None,
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        )
        .await;
        outcome.unwrap()
    };

    assert_eq!(outcome, SandboxParkOutcome::Reusable);
    assert!(is_parked);
    assert!(retained_guest.lock().await.is_some());
    let mut buffer = [0; HEADER_SIZE];
    assert_eq!(
        guest_stream.try_read(&mut buffer).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "reusable park must not send a terminal memory snapshot request"
    );
    let requests = api.drain_requests();
    let pause = patches(&requests)
        .into_iter()
        .find(|request| request.path == "/vm")
        .expect("reusable park should pause Firecracker");
    assert!(pause.body.contains("Paused"));
    assert_eq!(
        observer.substage_records,
        vec![
            (SandboxFinalExecParkSubstage::BalloonSetup, true, None,),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::TargetReached),
            ),
            (SandboxFinalExecParkSubstage::VcpuPause, true, None),
        ]
    );
}

#[tokio::test]
async fn park_small_vm_pause_failure_preserves_controller() {
    // A minimum-size VM does no balloon work and only pauses. If pause
    // fails, the controller must be preserved (not aborted) — unlike
    // large VMs where the controller is already gone.
    let api = MockLifecycleApi::new(std::collections::VecDeque::from(vec![500]), None);

    let original_controller = test_balloon_controller();
    let original_id = original_controller.id();
    let mut controller = Some(original_controller);
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();

    let result = {
        let (_events, result) = park_inner_with_guest(
            &mut is_parked,
            balloon::MIN_GUEST_MIB,
            &mut controller,
            api.socket_path(),
            "small-fail",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: None,
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        )
        .await;
        result
    };

    assert_idle_transition(result, SandboxIdleTransition::Park);
    assert!(!is_parked, "flag must stay false on failure");
    // Key assertion: controller is preserved for small VMs (no balloon
    // work was done, so no need to abort the controller).
    let still_there = controller.as_ref().expect("controller must be preserved");
    assert_eq!(
        still_there.id(),
        original_id,
        "controller must not be replaced or aborted"
    );
    assert_eq!(
        observer.substage_records,
        vec![
            (
                SandboxFinalExecParkSubstage::BalloonSetup,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (
                SandboxFinalExecParkSubstage::VcpuPause,
                false,
                Some(SandboxFinalExecParkSubstageOutcome::Failed),
            ),
        ]
    );
}
