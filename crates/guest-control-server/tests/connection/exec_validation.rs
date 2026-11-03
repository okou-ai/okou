use std::io::Write;

use guest_control_proto::{
    self, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecTermination,
    ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_CONTROL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED,
};

use super::exec_helpers::{EXEC_CONTROL_NONCE, send_exec_control};
use super::support::*;

#[test]
fn malformed_exec_control_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_EXEC_CONTROL, 121, b"bad");
    let error = read_error_response(&mut host_stream, 121);
    assert_eq!(error, "invalid payload: exec_control target_seq truncated");

    assert_ping_pong(&mut host_stream, 122);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_rejects_invalid_one_shot_start_policies() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_request(
        &mut host_stream,
        103,
        guest_control_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            role: guest_control_proto::ExecProcessRole::Workload,
            timeout: ExecTimeoutPolicy::None,
            command: "printf should-not-run",
            env: &[],
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 103),
        "exec timeout policy none requires supervised lifecycle"
    );

    let mut zero_timeout_payload = guest_control_proto::encode_exec_start(
        1,
        "printf should-not-run",
        &[],
        false,
        "test",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    zero_timeout_payload[3..7].copy_from_slice(&0u32.to_be_bytes());
    let zero_timeout_msg =
        guest_control_proto::encode(MSG_EXEC_START, 104, &zero_timeout_payload).unwrap();
    host_stream.write_all(&zero_timeout_msg).unwrap();
    assert_eq!(
        read_error_response(&mut host_stream, 104),
        "invalid payload: exec start timeout duration must be positive"
    );

    let mut invalid_control_payload =
        guest_control_proto::encode_exec_start_with_expected_exit_codes(
            guest_control_proto::ExecStartEncodeRequest {
                lifecycle: ExecLifecyclePolicy::Supervised,
                role: guest_control_proto::ExecProcessRole::Workload,
                timeout: ExecTimeoutPolicy::None,
                command: "printf should-not-run",
                env: &[],
                sudo: false,
                label: "test",
                stdout: ExecOutputPolicy::Discard,
                stderr: ExecOutputPolicy::Discard,
                expected_exit_codes: &[],
                control: ExecControlPolicy::Enabled {
                    control_nonce: *b"0123456789abcdef",
                    sink: false,
                },
                stdin_bytes: None,
            },
        )
        .unwrap();
    invalid_control_payload[0] = zero_timeout_payload[0];
    let invalid_control_msg =
        guest_control_proto::encode(MSG_EXEC_START, 105, &invalid_control_payload).unwrap();
    host_stream.write_all(&invalid_control_msg).unwrap();
    assert_eq!(
        read_error_response(&mut host_stream, 105),
        "invalid payload: exec start role, lifecycle, and control combination invalid"
    );

    send_quiesce_operations(&mut host_stream, 106);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 106);
    assert!(quiesced.payload.is_empty());

    send_resume_operations(&mut host_stream, 107);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 107);
    assert!(resumed.payload.is_empty());

    send_exec_start(
        &mut host_stream,
        108,
        "printf ok",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 108);
    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn controlled_agent_rejects_command_sudo_and_stdin_authority() {
    let (handle, mut host_stream) = start_guest_connection();

    for (seq, command, sudo, stdin_bytes, expected) in [
        (
            130,
            "printf should-not-run",
            false,
            None,
            "Agent process cannot select a command",
        ),
        (
            131,
            "",
            true,
            None,
            "Agent process cannot select sudo execution",
        ),
        (
            132,
            "",
            false,
            Some(b"stdin".as_slice()),
            "Agent process cannot provide stdin",
        ),
    ] {
        send_exec_start_request(
            &mut host_stream,
            seq,
            guest_control_proto::ExecStartEncodeRequest {
                lifecycle: ExecLifecyclePolicy::Supervised,
                role: guest_control_proto::ExecProcessRole::Agent,
                timeout: ExecTimeoutPolicy::None,
                command,
                env: &[],
                sudo,
                label: "controlled-agent-authority-test",
                stdout: ExecOutputPolicy::Discard,
                stderr: ExecOutputPolicy::Discard,
                expected_exit_codes: &[],
                control: ExecControlPolicy::Enabled {
                    control_nonce: [seq as u8; 16],
                    sink: true,
                },
                stdin_bytes,
            },
        );
        assert_eq!(read_error_response(&mut host_stream, seq), expected);
    }

    assert_ping_pong(&mut host_stream, 133);
    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_rejects_output_policies_that_cannot_fit_protocol_frames_without_running() {
    let capture_marker = unique_tmp_path("exec-operation-huge-capture-policy", ".marker");
    let stream_marker = unique_tmp_path("exec-operation-huge-stream-policy", ".marker");
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        118,
        &format!("printf ran > '{}'", capture_marker.as_str()),
        5000,
        ExecOutputPolicy::Capture {
            limit_bytes: u32::MAX,
        },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, capture_result) = read_exec_result(&mut host_stream, 118);
    assert_eq!(capture_result.termination, ExecTermination::StartFailed);
    assert!(
        capture_result
            .diagnostic
            .contains("capture limits exceed protocol result frame budget")
    );
    assert!(std::fs::metadata(capture_marker.as_str()).is_err());

    send_exec_start(
        &mut host_stream,
        119,
        &format!("printf ran > '{}'", stream_marker.as_str()),
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: u32::MAX,
        },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, stream_result) = read_exec_result(&mut host_stream, 119);
    assert_eq!(stream_result.termination, ExecTermination::StartFailed);
    assert!(
        stream_result
            .diagnostic
            .contains("stream chunk limit exceeds protocol frame budget")
    );
    assert!(std::fs::metadata(stream_marker.as_str()).is_err());

    finish_guest_connection(handle, host_stream);
}
#[test]
fn exec_operation_rejects_retired_process_roles_without_running() {
    let marker = unique_tmp_path("exec-retired-process-role", ".marker");
    let command = format!("printf ran > '{}'", marker.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    for (seq, retired_role) in [(149, 0x02), (150, 0x03)] {
        let mut payload = guest_control_proto::encode_exec_start(
            5000,
            &command,
            &[],
            false,
            "test",
            ExecOutputPolicy::Discard,
            ExecOutputPolicy::Discard,
        )
        .unwrap();
        // Exec start encodes lifecycle first, then process role.
        payload[1] = retired_role;
        send_control_payload(&mut host_stream, MSG_EXEC_START, seq, &payload);
        assert_eq!(
            read_error_response(&mut host_stream, seq),
            "invalid payload: exec start process role invalid"
        );
        assert_ping_pong(&mut host_stream, seq + 2);
        assert!(!std::path::Path::new(marker.as_str()).exists());
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_invalid_env_returns_start_failed_without_leaking_value() {
    let (handle, mut host_stream) = start_guest_connection();

    let secret = "do-not-print-this-secret";
    send_exec_start_with_env(
        &mut host_stream,
        110,
        "echo should-not-run",
        5000,
        &[("BAD;KEY", secret)],
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 110);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(
        result
            .diagnostic
            .contains("invalid environment variable name")
    );
    assert!(!result.diagnostic.contains(secret));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn controlled_agent_rejects_invalid_environment_without_starting() {
    let (handle, mut host_stream) = start_guest_connection();

    for (seq, key, value, expected) in [
        (
            134,
            "BAD;KEY",
            "do-not-print-this-key-secret",
            "invalid environment variable name",
        ),
        (
            135,
            "VALID_KEY",
            "do-not-print-this-value-secret\0",
            "environment variable value contains NUL bytes",
        ),
    ] {
        send_exec_start_request(
            &mut host_stream,
            seq,
            guest_control_proto::ExecStartEncodeRequest {
                lifecycle: ExecLifecyclePolicy::Supervised,
                role: guest_control_proto::ExecProcessRole::Agent,
                timeout: ExecTimeoutPolicy::None,
                command: "",
                env: &[(key, value)],
                sudo: false,
                label: "controlled-agent-invalid-environment",
                stdout: ExecOutputPolicy::Discard,
                stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
                expected_exit_codes: &[],
                control: ExecControlPolicy::Enabled {
                    control_nonce: [seq as u8; 16],
                    sink: true,
                },
                stdin_bytes: None,
            },
        );

        let msg = read_message(&mut host_stream);
        assert_eq!(msg.msg_type, guest_control_proto::MSG_EXEC_RESULT);
        assert_eq!(msg.seq, seq);
        let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::StartFailed);
        assert!(result.diagnostic.contains(expected));
        assert!(!result.diagnostic.contains("do-not-print-this"));
    }

    assert_ping_pong(&mut host_stream, 136);
    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_unknown_cancel_is_ignored() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_cancel(&mut host_stream, 999);
    send_exec_start(
        &mut host_stream,
        114,
        "printf ok",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 114);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_seq_zero_start_cancel_and_control_return_error() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        0,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let start_error = read_message(&mut host_stream);
    assert_eq!(start_error.msg_type, MSG_ERROR);
    assert_eq!(start_error.seq, 0);
    assert!(
        guest_control_proto::decode_error(&start_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    send_exec_cancel(&mut host_stream, 0);
    let cancel_error = read_message(&mut host_stream);
    assert_eq!(cancel_error.msg_type, MSG_ERROR);
    assert_eq!(cancel_error.seq, 0);
    assert!(
        guest_control_proto::decode_error(&cancel_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    send_exec_control(&mut host_stream, 0, 1, EXEC_CONTROL_NONCE, "message-zero");
    let control_error = read_message(&mut host_stream);
    assert_eq!(control_error.msg_type, MSG_ERROR);
    assert_eq!(control_error.seq, 0);
    assert!(
        guest_control_proto::decode_error(&control_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    finish_guest_connection(handle, host_stream);
}
