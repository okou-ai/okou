//! Real Guest-control I/O for dependent Runner lifecycle regressions.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use guest_control_client::{
    ExecControlHandle, ExecControlOutcome, FrameWriteObserver, GuestControlClient,
    SupervisedExecControl, SupervisedExecRequest,
};
use guest_control_proto::{
    ExecAgentReadyTiming, ExecControlNonce, ExecControlPolicy, ExecControlStatus, ExecOutputPolicy,
    ExecProcessRole, ExecTimeoutPolicy, HEADER_SIZE, MIN_BODY_SIZE, RawMessage,
};
use nix::sys::socket::{setsockopt, sockopt};
use sandbox::{
    GuestProcessCancelHandle, GuestProcessControlHandle, GuestProcessHandle, GuestProcessWaiter,
    ProcessControlAck, ProcessControlFailureKind, ProcessControlGuestStatus, ProcessControlOutcome,
    ProcessControlWriteState, ProcessExit,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::oneshot;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const GUEST_PID: u32 = 123;

pub struct GuestControlFixture {
    pub client: Arc<GuestControlClient>,
    pub guest: UnixStream,
    pub control: ExecControlHandle,
    pub process_control: GuestProcessControlHandle,
    pub cancel_result: oneshot::Receiver<Result<(), io::ErrorKind>>,
    pub wait_result: oneshot::Receiver<Result<(), io::ErrorKind>>,
    process: Option<GuestProcessHandle>,
    exec_seq: u32,
    control_nonce: ExecControlNonce,
}

pub fn decode_control(message: &RawMessage) -> (String, String) {
    let control = guest_control_proto::decode_exec_control(&message.payload).unwrap();
    let input = guest_contracts::active_input::decode_active_input(control.payload)
        .unwrap()
        .into_parts();
    assert_eq!(control.message_id, input.0);
    input
}

impl GuestControlFixture {
    /// `wait_limit` constrains the real supervised terminal timer for timeout
    /// regressions; it does not replace the client wait with a synthetic error.
    pub async fn start(wait_limit: Option<Duration>) -> Self {
        let (host, mut guest) = UnixStream::pair().unwrap();
        setsockopt(&host, sockopt::SndBuf, &4096usize).unwrap();
        let handshake = async {
            send_frame(&mut guest, guest_control_proto::MSG_READY, 0, &[]).await;
            let ping = read_frame(&mut guest).await;
            assert_eq!(ping.msg_type, guest_control_proto::MSG_PING);
            send_frame(&mut guest, guest_control_proto::MSG_PONG, ping.seq, &[]).await;
        };
        let (client, ()) = tokio::join!(
            guest_control_client::test_support::from_stream(host, IO_TIMEOUT),
            handshake,
        );
        let client = Arc::new(client.unwrap());
        let request = SupervisedExecRequest {
            timeout_is_expected: false,
            role: ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::None,
            command: "fixture-agent",
            env: &[],
            sudo: false,
            label: "active-input-socket-test",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            control: SupervisedExecControl::Enabled { sink: true },
            stdin_bytes: None,
            stream_queue_capacity: None,
            start_timeout: IO_TIMEOUT,
        };
        let guest_start = async {
            let start = read_frame(&mut guest).await;
            assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
            let decoded = guest_control_proto::decode_exec_start(&start.payload).unwrap();
            let ExecControlPolicy::Enabled {
                control_nonce,
                sink: true,
            } = decoded.control
            else {
                panic!("fixture must start a controlled Agent");
            };
            send_frame(
                &mut guest,
                guest_control_proto::MSG_EXEC_STARTED,
                start.seq,
                &guest_control_proto::encode_exec_started(GUEST_PID).unwrap(),
            )
            .await;
            send_frame(
                &mut guest,
                guest_control_proto::MSG_EXEC_AGENT_READY,
                start.seq,
                &guest_control_proto::encode_exec_agent_ready(ExecAgentReadyTiming {
                    containment_create_us: 0,
                    placement_broker_setup_us: 0,
                    shell_spawn_us: 0,
                    bootstrap_ready_wait_us: 0,
                }),
            )
            .await;
            (start.seq, control_nonce)
        };
        let (handle, (exec_seq, control_nonce)) =
            tokio::join!(client.start_supervised_exec(request), guest_start,);
        let mut handle = handle.unwrap();
        let control = handle.control_handle().unwrap();
        let process_control = GuestProcessControlHandle::new_with_outcome({
            let control = control.clone();
            move |message_id, payload, timeout| {
                let control = control.clone();
                Box::pin(async move {
                    let write_started = Arc::new(AtomicBool::new(false));
                    let write_observer = FrameWriteObserver::new({
                        let write_started = Arc::clone(&write_started);
                        move || {
                            write_started.store(true, Ordering::Release);
                            Ok(())
                        }
                    });
                    let result = control
                        .control_owned_with_write_observer(
                            message_id,
                            payload,
                            timeout,
                            write_observer,
                        )
                        .await;
                    process_control_outcome(result, &write_started)
                })
            }
        });
        let cancel = handle.take_cancel_handle().unwrap();
        let (cancel_tx, cancel_result) = oneshot::channel();
        let process_cancel = GuestProcessCancelHandle::new(move |timeout| {
            Box::pin(async move {
                let result = cancel.cancel(timeout).await;
                let _ = cancel_tx.send(result.as_ref().copied().map_err(io::Error::kind));
                result
            })
        });
        let (wait_tx, wait_result) = oneshot::channel();
        let process = GuestProcessHandle::new(
            GUEST_PID,
            None,
            Some(process_control.clone()),
            GuestProcessWaiter::new(move |timeout| {
                Box::pin(async move {
                    let result = handle
                        .wait(wait_limit.map_or(timeout, |limit| limit.min(timeout)))
                        .await;
                    let _ = wait_tx.send(result.as_ref().map(|_| ()).map_err(io::Error::kind));
                    let result = result?;
                    let mut exit = ProcessExit::new(GUEST_PID, 0, Vec::new(), Vec::new());
                    exit.termination = match result.termination {
                        guest_control_proto::ExecTermination::Exited { exit_code } => {
                            sandbox::ExecTermination::Exited { exit_code }
                        }
                        guest_control_proto::ExecTermination::TimedOut => {
                            sandbox::ExecTermination::TimedOut
                        }
                        guest_control_proto::ExecTermination::Cancelled => {
                            sandbox::ExecTermination::Cancelled
                        }
                        guest_control_proto::ExecTermination::StartFailed => {
                            sandbox::ExecTermination::StartFailed
                        }
                        guest_control_proto::ExecTermination::WaitFailed => {
                            sandbox::ExecTermination::WaitFailed
                        }
                    };
                    exit.guest_duration_ms = Some(result.duration_ms);
                    exit.diagnostic = result.diagnostic;
                    exit.stream_overflowed = result.stream_overflowed;
                    Ok(exit)
                })
            }),
        )
        .with_cancel_handle(process_cancel);
        Self {
            client,
            guest,
            control,
            process_control,
            cancel_result,
            wait_result,
            process: Some(process),
            exec_seq,
            control_nonce,
        }
    }

    pub fn take_process(&mut self) -> GuestProcessHandle {
        self.process
            .take()
            .expect("fixture process is consumed once")
    }

    /// Read only the frame prefix. A large payload cannot fit in the explicitly
    /// small host send buffer, so the rest remains in a real pending write.
    pub async fn observe_partial_control(&mut self) -> usize {
        let mut prefix = [0u8; HEADER_SIZE + MIN_BODY_SIZE];
        tokio::time::timeout(IO_TIMEOUT, self.guest.read_exact(&mut prefix))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(prefix[HEADER_SIZE], guest_control_proto::MSG_EXEC_CONTROL);
        let body_len = u32::from_be_bytes(prefix[..HEADER_SIZE].try_into().unwrap()) as usize;
        assert!(
            body_len > 64 * 1024,
            "control must exceed the socket send buffer"
        );
        HEADER_SIZE + body_len - prefix.len()
    }

    pub async fn read_control(&mut self) -> RawMessage {
        let message = read_frame(&mut self.guest).await;
        assert_eq!(message.msg_type, guest_control_proto::MSG_EXEC_CONTROL);
        message
    }

    pub async fn acknowledge(&mut self, message: &RawMessage) {
        let control = guest_control_proto::decode_exec_control(&message.payload).unwrap();
        assert_eq!(control.target_seq, self.exec_seq);
        assert_eq!(control.control_nonce, self.control_nonce);
        let payload = guest_control_proto::encode_exec_control_result(
            control.target_seq,
            control.control_nonce,
            control.message_id,
            guest_control_proto::ExecControlStatus::Delivered,
            "",
        )
        .unwrap();
        send_frame(
            &mut self.guest,
            guest_control_proto::MSG_EXEC_CONTROL_RESULT,
            message.seq,
            &payload,
        )
        .await;
    }

    pub async fn finish(&mut self) {
        let payload = guest_control_proto::encode_exec_result(
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            0,
            guest_control_proto::ExecCapturedOutput::Discarded,
            guest_control_proto::ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        send_frame(
            &mut self.guest,
            guest_control_proto::MSG_EXEC_RESULT,
            self.exec_seq,
            &payload,
        )
        .await;
    }

    pub async fn assert_partial_write_closed(&mut self, remaining_frame_bytes: usize) {
        let mut tail = Vec::new();
        tokio::time::timeout(IO_TIMEOUT, self.guest.read_to_end(&mut tail))
            .await
            .unwrap()
            .unwrap();
        assert!(
            tail.len() < remaining_frame_bytes,
            "stalled control must not finish or gain later frames"
        );
        assert!(
            self.client.reserve_external_operation().is_err(),
            "partial transport must reject later normal operations"
        );
    }
}

fn process_control_outcome(
    result: io::Result<ExecControlOutcome>,
    write_started: &AtomicBool,
) -> ProcessControlOutcome {
    let outcome = result.and_then(|outcome| match outcome {
        ExecControlOutcome::Delivered(ack) => {
            Ok(ProcessControlOutcome::Delivered(ProcessControlAck {
                message_id: ack.message_id,
            }))
        }
        ExecControlOutcome::GuestStatus(guest) => {
            let status = match guest.status {
                ExecControlStatus::Delivered => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "delivered control must carry an acknowledgement",
                    ));
                }
                ExecControlStatus::Inactive => ProcessControlGuestStatus::Inactive,
                ExecControlStatus::NonceMismatch => ProcessControlGuestStatus::NonceMismatch,
                ExecControlStatus::Unsupported => ProcessControlGuestStatus::Unsupported,
                ExecControlStatus::Rejected => ProcessControlGuestStatus::Rejected,
                ExecControlStatus::SinkUnavailable => ProcessControlGuestStatus::SinkUnavailable,
                ExecControlStatus::SinkTimeout => ProcessControlGuestStatus::SinkTimeout,
                ExecControlStatus::QueueFull => ProcessControlGuestStatus::QueueFull,
                ExecControlStatus::SinkError => ProcessControlGuestStatus::SinkError,
                ExecControlStatus::SinkClosed => ProcessControlGuestStatus::SinkClosed,
            };
            Ok(ProcessControlOutcome::GuestStatus {
                status,
                diagnostic: guest.diagnostic,
            })
        }
        ExecControlOutcome::GuestError(message) => Ok(ProcessControlOutcome::GuestError(message)),
    });
    match outcome {
        Ok(outcome) => outcome,
        Err(error) => ProcessControlOutcome::Failed {
            kind: ProcessControlFailureKind::Operation,
            write_state: if write_started.load(Ordering::Acquire) {
                ProcessControlWriteState::PossiblyWritten
            } else {
                ProcessControlWriteState::NotWritten
            },
            error,
        },
    }
}

async fn send_frame(stream: &mut UnixStream, kind: u8, seq: u32, payload: &[u8]) {
    let frame = guest_control_proto::encode(kind, seq, payload).unwrap();
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&frame))
        .await
        .unwrap()
        .unwrap();
}

async fn read_frame(stream: &mut UnixStream) -> RawMessage {
    let mut header = [0u8; HEADER_SIZE];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut header))
        .await
        .unwrap()
        .unwrap();
    let length = u32::from_be_bytes(header) as usize;
    assert!((MIN_BODY_SIZE..=guest_control_proto::MAX_MESSAGE_SIZE).contains(&length));
    let mut frame = header.to_vec();
    frame.resize(HEADER_SIZE + length, 0);
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut frame[HEADER_SIZE..]))
        .await
        .unwrap()
        .unwrap();
    let mut messages = guest_control_proto::Decoder::new().decode(&frame).unwrap();
    assert_eq!(messages.len(), 1);
    messages.pop().unwrap()
}
