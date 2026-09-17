use guest_control_proto::{
    self, ExecControlNonce, ExecControlPolicy, ExecControlStatus, ExecLifecyclePolicy,
    ExecOutputPolicy, ExecOutputStream, ExecStartEncodeRequest, ExecTimeoutPolicy, MSG_ERROR,
    MSG_EXEC_AGENT_READY, MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT,
    MSG_EXEC_RESULT, MSG_EXEC_STARTED,
};

use super::support::{read_message, send_exec_start_request};

pub(super) const EXEC_CONTROL_NONCE: ExecControlNonce = *b"exec-ctrl-000001";
pub(super) const EXEC_CONTROL_WRONG_NONCE: ExecControlNonce = *b"exec-ctrl-999999";
pub(super) const EXEC_OPERATION_TIMEOUT_TEST_MS: u32 = 2_000;

pub(super) fn unique_exec_control_nonce(seed: u64) -> ExecControlNonce {
    let mut nonce = [0u8; 16];
    nonce[..8].copy_from_slice(&u64::from(std::process::id()).to_be_bytes());
    nonce[8..].copy_from_slice(&seed.to_be_bytes());
    nonce
}

pub(super) fn sleep_command_with_pid(pid_path: &str) -> String {
    format!("printf '%s' \"$$\" > '{pid_path}'; sleep 60")
}

pub(super) fn send_supervised_exec_start(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout: ExecTimeoutPolicy,
    stdout: ExecOutputPolicy,
    control: ExecControlPolicy,
) {
    send_exec_start_request(
        stream,
        seq,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            role: guest_control_proto::ExecProcessRole::Workload,
            timeout,
            command,
            env: &[],
            sudo: false,
            label: "supervised-test",
            stdout,
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control,
            stdin_bytes: None,
        },
    );
}

pub(super) fn read_exec_started(stream: &mut impl std::io::Read, seq: u32) -> u32 {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_EXEC_STARTED);
    assert_eq!(msg.seq, seq);
    guest_control_proto::decode_exec_started(&msg.payload)
        .unwrap()
        .pid
}

pub(super) fn read_exec_agent_ready_and_stdout(
    stream: &mut impl std::io::Read,
    seq: u32,
    expected_stdout: &[u8],
) -> guest_control_proto::ExecAgentReadyTiming {
    let mut ready = None;
    let mut stdout = Vec::new();
    let mut output_seq = 0;
    while ready.is_none() || stdout.len() < expected_stdout.len() {
        let msg = read_message(stream);
        assert_eq!(msg.seq, seq);
        match msg.msg_type {
            MSG_EXEC_AGENT_READY => {
                assert!(ready.is_none(), "duplicate exec agent-ready frame");
                ready = Some(guest_control_proto::decode_exec_agent_ready(&msg.payload).unwrap());
            }
            MSG_EXEC_OUTPUT => {
                let decoded = guest_control_proto::decode_exec_output(&msg.payload).unwrap();
                assert_eq!(decoded.stream, ExecOutputStream::Stdout);
                assert_eq!(decoded.output_seq, output_seq);
                assert!(!decoded.truncated);
                assert!(!decoded.chunk.is_empty());
                assert!(stdout.len() + decoded.chunk.len() <= expected_stdout.len());
                stdout.extend_from_slice(decoded.chunk);
                output_seq += 1;
            }
            other => panic!("unexpected exec startup response type: 0x{other:02X}"),
        }
    }
    assert_eq!(stdout, expected_stdout);
    ready.unwrap()
}

pub(super) fn read_exec_stdout_output(stream: &mut impl std::io::Read, seq: u32) -> Vec<u8> {
    loop {
        let msg = read_message(stream);
        if msg.seq != seq {
            continue;
        }
        match msg.msg_type {
            MSG_EXEC_OUTPUT => {
                let decoded = guest_control_proto::decode_exec_output(&msg.payload).unwrap();
                assert_eq!(decoded.stream, ExecOutputStream::Stdout);
                assert!(!decoded.truncated);
                return decoded.chunk.to_vec();
            }
            MSG_EXEC_RESULT => panic!("unexpected exec result before stdout output"),
            MSG_ERROR => {
                let error = guest_control_proto::decode_error(&msg.payload).unwrap();
                panic!("unexpected exec operation error for seq={seq}: {error}");
            }
            other => panic!("unexpected exec operation response type: 0x{other:02X}"),
        }
    }
}

pub(super) fn send_exec_control(
    stream: &mut impl std::io::Write,
    request_seq: u32,
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
) {
    let payload = guest_control_proto::encode_exec_control(
        target_seq,
        control_nonce,
        message_id,
        b"payload",
        5000,
    )
    .unwrap();
    let msg = guest_control_proto::encode(MSG_EXEC_CONTROL, request_seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(super) fn assert_exec_control_result(
    stream: &mut impl std::io::Read,
    request_seq: u32,
    expected_target_seq: u32,
    expected_nonce: ExecControlNonce,
    expected_message_id: &str,
    expected_status: ExecControlStatus,
    expected_diagnostic: &str,
) {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(msg.seq, request_seq);
    let decoded = guest_control_proto::decode_exec_control_result(&msg.payload).unwrap();
    assert_eq!(decoded.target_seq, expected_target_seq);
    assert_eq!(decoded.control_nonce, expected_nonce);
    assert_eq!(decoded.message_id, expected_message_id);
    assert_eq!(decoded.status, expected_status);
    assert_eq!(decoded.diagnostic, expected_diagnostic);
}
