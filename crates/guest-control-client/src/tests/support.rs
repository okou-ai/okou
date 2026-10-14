use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{
    ExecAgentReadyTiming, ExecCapturedOutput, ExecControlNonce, ExecControlStatus,
    ExecOutputStream, ExecTermination, HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_ERROR,
    MSG_EXEC_AGENT_READY, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT,
    MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START, MSG_EXEC_STARTED, MSG_GUEST_DNS_READINESS,
    MSG_GUEST_DNS_READINESS_RESULT, MSG_MEMORY_SNAPSHOT, MSG_MEMORY_SNAPSHOT_RESULT,
    MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_PING, MSG_PONG, MSG_QUIESCE_OPERATIONS,
    MSG_READY, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, MSG_WRITE_FILES, MSG_WRITE_FILES_RESULT, MSG_WRITE_PRIVATE_FILES,
    RawMessage,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::operation_tracker::NormalOperationReadiness;
use crate::{
    ConnectionState, ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput,
    FrameWriteObserver, GuestControlClient, NormalOperationFence,
};

const MOCK_GUEST_IO_TIMEOUT: Duration = Duration::from_secs(5);
// Keep the task guard wider than multi-frame reads so the per-frame
// assertions report the actual protocol step that got stuck.
const MOCK_GUEST_TASK_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) fn make_pair() -> (UnixStream, UnixStream) {
    UnixStream::pair().unwrap()
}

pub(crate) async fn await_mock_guest(mut task: JoinHandle<()>) {
    match tokio::time::timeout(MOCK_GUEST_TASK_TIMEOUT, &mut task).await {
        Ok(result) => result.expect("mock guest task panicked"),
        Err(_) => {
            task.abort();
            let _ = task.await;
            panic!("mock guest task did not finish");
        }
    }
}

pub(crate) struct MockGuest {
    stream: UnixStream,
}

impl MockGuest {
    pub(crate) fn new(stream: UnixStream) -> Self {
        Self { stream }
    }

    pub(crate) fn into_stream(self) -> UnixStream {
        self.stream
    }

    pub(crate) fn stream_mut(&mut self) -> &mut UnixStream {
        &mut self.stream
    }

    pub(crate) async fn complete_handshake(&mut self) {
        mock_handshake(&mut self.stream).await;
    }

    pub(crate) async fn read_message(&mut self) -> RawMessage {
        read_guest_message(&mut self.stream).await
    }

    pub(crate) async fn read_messages(&mut self, count: usize) -> Vec<RawMessage> {
        read_guest_messages(&mut self.stream, count).await
    }

    pub(crate) async fn expect_message(&mut self, expected_type: u8) -> RawMessage {
        let message = self.read_message().await;
        assert_eq!(
            message.msg_type,
            expected_type,
            "expected guest message type {} ({:#04x}), got {} ({:#04x})",
            message_type_name(expected_type),
            expected_type,
            message_type_name(message.msg_type),
            message.msg_type
        );
        message
    }

    pub(crate) async fn expect_eof(&mut self) {
        let mut buf = [0u8; 1];
        let n = tokio::time::timeout(MOCK_GUEST_IO_TIMEOUT, self.stream.read(&mut buf))
            .await
            .expect("timed out waiting for guest stream EOF")
            .unwrap();
        assert_eq!(n, 0, "expected guest stream EOF, got {n} byte(s)");
    }

    pub(crate) async fn send_response(&mut self, msg_type: u8, seq: u32, payload: &[u8]) {
        let frame = guest_control_proto::encode(msg_type, seq, payload).unwrap();
        self.stream.write_all(&frame).await.unwrap();
    }

    pub(crate) async fn send_empty_response(&mut self, msg_type: u8, seq: u32) {
        self.send_response(msg_type, seq, &[]).await;
    }

    pub(crate) async fn send_error_response(&mut self, seq: u32, diagnostic: &str) {
        let payload = guest_control_proto::encode_error(diagnostic);
        self.send_response(MSG_ERROR, seq, &payload).await;
    }

    pub(crate) async fn send_exec_result(
        &mut self,
        seq: u32,
        termination: ExecTermination,
        stdout: &[u8],
        stderr: &[u8],
    ) {
        send_exec_result(&mut self.stream, seq, termination, stdout, stderr).await;
    }
}

/// Perform mock guest handshake: send ready, receive ping, send pong.
pub(crate) async fn mock_handshake(stream: &mut UnixStream) {
    let ready = guest_control_proto::encode(MSG_READY, 0, &[]).unwrap();
    stream.write_all(&ready).await.unwrap();

    let ping = read_guest_message(stream).await;
    assert_eq!(
        ping.msg_type,
        MSG_PING,
        "expected handshake ping, got {} ({:#04x})",
        message_type_name(ping.msg_type),
        ping.msg_type
    );

    let pong = guest_control_proto::encode(MSG_PONG, ping.seq, &[]).unwrap();
    stream.write_all(&pong).await.unwrap();
}

fn message_type_name(msg_type: u8) -> &'static str {
    match msg_type {
        MSG_READY => "ready",
        MSG_PING => "ping",
        MSG_PONG => "pong",
        MSG_SHUTDOWN => "shutdown",
        MSG_SHUTDOWN_ACK => "shutdown_ack",
        MSG_QUIESCE_OPERATIONS => "quiesce_operations",
        MSG_OPERATIONS_QUIESCED => "operations_quiesced",
        MSG_RESUME_OPERATIONS => "resume_operations",
        MSG_OPERATIONS_RESUMED => "operations_resumed",
        MSG_WRITE_FILE => "write_file",
        MSG_WRITE_FILE_RESULT => "write_file_result",
        MSG_WRITE_FILES => "write_files",
        MSG_WRITE_FILES_RESULT => "write_files_result",
        MSG_WRITE_PRIVATE_FILES => "write_private_files",
        MSG_EXEC_START => "exec_start",
        MSG_EXEC_STARTED => "exec_started",
        MSG_EXEC_AGENT_READY => "exec_agent_ready",
        MSG_EXEC_OUTPUT => "exec_output",
        MSG_EXEC_RESULT => "exec_result",
        MSG_EXEC_CANCEL => "exec_cancel",
        MSG_EXEC_CONTROL => "exec_control",
        MSG_EXEC_CONTROL_RESULT => "exec_control_result",
        MSG_MEMORY_SNAPSHOT => "memory_snapshot",
        MSG_MEMORY_SNAPSHOT_RESULT => "memory_snapshot_result",
        MSG_GUEST_DNS_READINESS => "guest_dns_readiness",
        MSG_GUEST_DNS_READINESS_RESULT => "guest_dns_readiness_result",
        MSG_ERROR => "error",
        _ => "unknown",
    }
}

pub(crate) async fn host_from_stream(stream: UnixStream) -> io::Result<GuestControlClient> {
    let deadline = Instant::now() + Duration::from_secs(5);
    GuestControlClient::from_stream(stream, deadline).await
}

pub(crate) fn operation_count(host: &GuestControlClient) -> usize {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected { operations, .. } => operations.len(),
        ConnectionState::Closed(_) => 0,
    }
}

pub(crate) fn pending_request_count(host: &GuestControlClient) -> usize {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected { pending, .. } => pending.len(),
        ConnectionState::Closed(_) => 0,
    }
}

pub(crate) fn pending_control_count(host: &GuestControlClient) -> usize {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected { operations, .. } => operations.pending_control_count(),
        ConnectionState::Closed(_) => 0,
    }
}

pub(crate) fn set_next_route_id(host: &GuestControlClient, next_route_id: u64) {
    let mut guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    let ConnectionState::Connected {
        next_route_id: current,
        ..
    } = &mut *guard
    else {
        panic!("connection should be open");
    };
    *current = next_route_id;
}

pub(crate) fn route_reservation_count(host: &GuestControlClient) -> usize {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected {
            route_reservations, ..
        } => route_reservations.len(),
        ConnectionState::Closed(_) => 0,
    }
}

pub(crate) fn is_connected(host: &GuestControlClient) -> bool {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    matches!(&*guard, ConnectionState::Connected { .. })
}

pub(crate) fn normal_operation_readiness(host: &GuestControlClient) -> NormalOperationReadiness {
    host.shared.normal_operations.readiness()
}

pub(crate) fn fence_normal_operations(host: &GuestControlClient) -> NormalOperationFence {
    host.try_fence_normal_operations()
        .expect("normal operations should fence")
}

pub(crate) fn poison_connection(host: &GuestControlClient) {
    host.shared
        .poison_connection(crate::ConnectionCloseReason::UnclassifiedPoison, None);
}

pub(crate) async fn exec_capture_default(
    host: &GuestControlClient,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<ExecOperationResult> {
    host.exec_operation_capture_default(
        command,
        timeout_ms,
        env,
        sudo,
        "exec",
        Duration::from_millis(timeout_ms as u64 + 5000),
    )
    .await
}

pub(crate) async fn exec_capture_with_write_observer(
    host: &GuestControlClient,
    request: ExecCaptureRequest<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    crate::exec_operation::exec_operation_capture_on_shared_with_write_observer(
        &host.shared,
        request,
        write_observer,
    )
    .await
}

pub(crate) async fn exec_capture_with_write_admission(
    host: &GuestControlClient,
    request: ExecCaptureRequest<'_>,
    write_admission: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    host.exec_operation_capture_with_write_admission(request, write_admission)
        .await
}

pub(crate) fn captured_output_bytes(output: &ExecOwnedCapturedOutput) -> &[u8] {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, .. } => bytes,
        ExecOwnedCapturedOutput::Discarded => panic!("expected captured output"),
    }
}

pub(crate) async fn read_guest_message(stream: &mut UnixStream) -> RawMessage {
    let mut header = [0u8; HEADER_SIZE];
    tokio::time::timeout(MOCK_GUEST_IO_TIMEOUT, stream.read_exact(&mut header))
        .await
        .expect("timed out reading guest message header")
        .unwrap();

    let body_len = u32::from_be_bytes(header) as usize;
    assert!(
        (MIN_BODY_SIZE..=MAX_MESSAGE_SIZE).contains(&body_len),
        "invalid message body length: {body_len}",
    );

    let mut body = vec![0u8; body_len];
    tokio::time::timeout(MOCK_GUEST_IO_TIMEOUT, stream.read_exact(&mut body))
        .await
        .expect("timed out reading guest message body")
        .unwrap();

    RawMessage {
        msg_type: body[0],
        seq: u32::from_be_bytes(body[1..MIN_BODY_SIZE].try_into().unwrap()),
        payload: body[MIN_BODY_SIZE..].to_vec(),
    }
}

pub(crate) async fn read_guest_messages(stream: &mut UnixStream, count: usize) -> Vec<RawMessage> {
    let mut messages = Vec::new();
    while messages.len() < count {
        messages.push(read_guest_message(stream).await);
    }
    messages
}

#[tokio::test]
async fn read_guest_message_preserves_coalesced_frames() {
    let (mut writer, mut reader) = make_pair();
    let mut frames = guest_control_proto::encode(MSG_EXEC_START, 7, b"first").unwrap();
    frames.extend_from_slice(&guest_control_proto::encode(MSG_EXEC_RESULT, 8, b"second").unwrap());
    writer.write_all(&frames).await.unwrap();

    let first = read_guest_message(&mut reader).await;
    let second = read_guest_message(&mut reader).await;

    assert_eq!(first.msg_type, MSG_EXEC_START);
    assert_eq!(first.seq, 7);
    assert_eq!(first.payload, b"first");
    assert_eq!(second.msg_type, MSG_EXEC_RESULT);
    assert_eq!(second.seq, 8);
    assert_eq!(second.payload, b"second");
}

pub(crate) async fn setup_host_and_mock_guest() -> (GuestControlClient, MockGuest) {
    let (host_stream, mut guest) = make_pair();
    let host_task = tokio::spawn(async move { host_from_stream(host_stream).await.unwrap() });
    mock_handshake(&mut guest).await;
    let host = host_task.await.unwrap();
    (host, MockGuest::new(guest))
}

pub(crate) async fn setup_host_and_guest() -> (GuestControlClient, UnixStream) {
    let (host, guest) = setup_host_and_mock_guest().await;
    (host, guest.into_stream())
}

fn exec_result_payload(termination: ExecTermination, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    guest_control_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Captured {
            bytes: stdout,
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
        "",
    )
    .unwrap()
}

pub(crate) async fn send_exec_result(
    stream: &mut UnixStream,
    seq: u32,
    termination: ExecTermination,
    stdout: &[u8],
    stderr: &[u8],
) {
    let payload = exec_result_payload(termination, stdout, stderr);
    let frame = guest_control_proto::encode(MSG_EXEC_RESULT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_exec_started(stream: &mut UnixStream, seq: u32, pid: u32) {
    let payload = guest_control_proto::encode_exec_started(pid).unwrap();
    let frame = guest_control_proto::encode(MSG_EXEC_STARTED, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_exec_agent_ready(stream: &mut UnixStream, seq: u32) {
    let payload = guest_control_proto::encode_exec_agent_ready(ExecAgentReadyTiming {
        containment_create_us: 1,
        placement_broker_setup_us: 2,
        shell_spawn_us: 3,
        bootstrap_ready_wait_us: 4,
    });
    let frame = guest_control_proto::encode(MSG_EXEC_AGENT_READY, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_exec_control_result(
    stream: &mut UnixStream,
    request_seq: u32,
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
) {
    let payload = guest_control_proto::encode_exec_control_result(
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    )
    .unwrap();
    let frame =
        guest_control_proto::encode(MSG_EXEC_CONTROL_RESULT, request_seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_stream_exec_result(
    stream: &mut UnixStream,
    seq: u32,
    termination: ExecTermination,
    stderr: &[u8],
) {
    let payload = guest_control_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
        "",
    )
    .unwrap();
    let frame = guest_control_proto::encode(MSG_EXEC_RESULT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_raw_exec_result(stream: &mut UnixStream, seq: u32, payload: Vec<u8>) {
    let frame = guest_control_proto::encode(MSG_EXEC_RESULT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_discarded_exec_result(
    stream: &mut UnixStream,
    seq: u32,
    termination: ExecTermination,
) {
    let payload = guest_control_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_exec_result(stream, seq, payload).await;
}

pub(crate) async fn send_exec_output(
    stream: &mut UnixStream,
    seq: u32,
    output_seq: u32,
    output_stream: ExecOutputStream,
    chunk: &[u8],
    truncated: bool,
) {
    let payload =
        guest_control_proto::encode_exec_output(output_stream, output_seq, chunk, truncated)
            .unwrap();
    let frame = guest_control_proto::encode(MSG_EXEC_OUTPUT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn wait_for_operation_count(host: &GuestControlClient, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while operation_count(host) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

pub(crate) async fn wait_for_pending_request_count(host: &GuestControlClient, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while pending_request_count(host) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

pub(crate) async fn wait_for_pending_control_count(host: &GuestControlClient, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while pending_control_count(host) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

pub(crate) async fn wait_for_route_reservation_count(host: &GuestControlClient, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while route_reservation_count(host) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

pub(crate) async fn assert_connection_accepts_exec_operation(
    host: &Arc<GuestControlClient>,
    guest: &mut UnixStream,
) {
    let exec_task = {
        let host = Arc::clone(host);
        tokio::spawn(async move { exec_capture_default(&host, "echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.command, "echo ok");
    assert_eq!(decoded.label, "exec");
    send_exec_result(
        guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(captured_output_bytes(&exec_result.stdout), b"ok");
}
