use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use guest_contracts::session_history_identity::{
    SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL,
    SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES, SessionHistoryFramework,
    SessionHistoryIdentityExpectation, SessionHistoryIdentityVerifyRequest, SessionHistoryRefKind,
};
use guest_control_proto::{
    self, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecTermination,
    ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_CONTROL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED,
};

use super::exec_helpers::{EXEC_CONTROL_NONCE, send_exec_control};
use super::support::*;

fn session_history_identity_verify_payload(metadata_path: &str, runtime_dir: &str) -> String {
    serde_json::to_string(&SessionHistoryIdentityVerifyRequest {
        metadata_path: metadata_path.to_owned(),
        runtime_dir: runtime_dir.to_owned(),
        expectation: SessionHistoryIdentityExpectation::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            42,
        )
        .unwrap(),
    })
    .unwrap()
}

fn verifier_exec_request<'a>(command: &'a str) -> guest_control_proto::ExecStartEncodeRequest<'a> {
    verifier_exec_request_with_timeout(command, 5000)
}

fn verifier_exec_request_with_timeout(
    command: &str,
    timeout_ms: u32,
) -> guest_control_proto::ExecStartEncodeRequest<'_> {
    guest_control_proto::ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        role: guest_control_proto::ExecProcessRole::SessionHistoryIdentityVerifier,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms },
        command,
        env: &[],
        sudo: false,
        label: SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL,
        stdout: ExecOutputPolicy::Capture {
            limit_bytes: SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
        },
        stderr: ExecOutputPolicy::Capture {
            limit_bytes: SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
        },
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    }
}

fn write_executable_script(path: &str, contents: &str) {
    fs::write(path, contents).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

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
fn session_history_identity_verifier_directly_launches_fixed_helper_arguments() {
    let agent_path = unique_tmp_path("session-history-identity-verifier", ".sh");
    write_executable_script(
        agent_path.as_str(),
        r#"#!/bin/sh
printf 'runtime=%s\n' "$OKOU_GUEST_RUNTIME_DIR"
printf 'args'
for arg in "$@"; do printf ' <%s>' "$arg"; done
printf '\n'
"#,
    );
    let metadata_path = "/tmp/final identity;printf should-not-run";
    let runtime_dir = "/tmp/runtime $(printf should-not-run)";
    let payload = session_history_identity_verify_payload(metadata_path, runtime_dir);
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_agent_program(PathBuf::from(agent_path.as_str()));

    send_exec_start_request(&mut host_stream, 137, verifier_exec_request(&payload));
    let (chunks, result) = read_exec_result(&mut host_stream, 137);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    let stdout = String::from_utf8(result.stdout.unwrap()).unwrap();
    assert_eq!(
        stdout,
        format!(
            "runtime={runtime_dir}\nargs <verify-session-history-identity> <{metadata_path}> <claude-code> <{}> <blob> <{}> <42>\n",
            "a".repeat(64),
            "b".repeat(64),
        )
    );
    assert_eq!(result.stderr, Some(Vec::new()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn session_history_identity_verifier_natural_exit_cleans_descendants() {
    let agent_path = unique_tmp_path("session-history-verifier-descendant", ".sh");
    let pid_path = unique_pid_path("session-history-verifier-descendant");
    let mut group_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    write_executable_script(
        agent_path.as_str(),
        &format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nsleep 30 >/dev/null 2>&1 &\nexit 0\n",
            pid_path.as_str(),
        ),
    );
    let payload = session_history_identity_verify_payload("/tmp/metadata", "/tmp/runtime");
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_agent_program(PathBuf::from(agent_path.as_str()));

    send_exec_start_request(&mut host_stream, 146, verifier_exec_request(&payload));
    let (chunks, result) = read_exec_result(&mut host_stream, 146);
    let pid = group_guard.read_pid();

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    wait_for_pid_exit(pid, "session history verifier natural exit");
    group_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn session_history_identity_verifier_timeout_cleans_process_group() {
    let agent_path = unique_tmp_path("session-history-verifier-timeout", ".sh");
    let pid_path = unique_pid_path("session-history-verifier-timeout");
    let mut group_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    write_executable_script(
        agent_path.as_str(),
        &format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nsleep 30\n",
            pid_path.as_str(),
        ),
    );
    let payload = session_history_identity_verify_payload("/tmp/metadata", "/tmp/runtime");
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_agent_program(PathBuf::from(agent_path.as_str()));

    send_exec_start_request(
        &mut host_stream,
        147,
        verifier_exec_request_with_timeout(&payload, 200),
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 147);
    let pid = group_guard.read_pid();

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "session history verifier timeout");
    group_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn session_history_identity_verifier_disconnect_cleans_process_group() {
    let agent_path = unique_tmp_path("session-history-verifier-disconnect", ".sh");
    let pid_path = unique_pid_path("session-history-verifier-disconnect");
    let mut group_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    write_executable_script(
        agent_path.as_str(),
        &format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nsleep 30\n",
            pid_path.as_str(),
        ),
    );
    let payload = session_history_identity_verify_payload("/tmp/metadata", "/tmp/runtime");
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_agent_program(PathBuf::from(agent_path.as_str()));

    send_exec_start_request(
        &mut host_stream,
        148,
        verifier_exec_request_with_timeout(&payload, 60_000),
    );
    let pid = group_guard.read_pid();

    drop(host_stream);
    join_guest_connection(handle);
    wait_for_pid_exit(pid, "session history verifier disconnect");
    group_guard.disarm();
}

#[test]
fn session_history_identity_verifier_rejects_generic_exec_authority() {
    enum Mutation {
        Environment,
        Sudo,
        Stdin,
        Label,
        Output,
        ExpectedExit,
    }

    let payload = session_history_identity_verify_payload("/tmp/metadata", "/tmp/runtime");
    let (handle, mut host_stream) = start_guest_connection();

    for (seq, mutate) in [
        (138, Mutation::Environment),
        (139, Mutation::Sudo),
        (140, Mutation::Stdin),
        (141, Mutation::Label),
        (142, Mutation::Output),
        (143, Mutation::ExpectedExit),
    ] {
        let mut request = verifier_exec_request(&payload);
        let env = [("UNTRUSTED", "value")];
        let expected_exit_codes = [7];
        match mutate {
            Mutation::Environment => request.env = &env,
            Mutation::Sudo => request.sudo = true,
            Mutation::Stdin => request.stdin_bytes = Some(b"stdin"),
            Mutation::Label => request.label = "caller-selected-label",
            Mutation::Output => request.stdout = ExecOutputPolicy::Discard,
            Mutation::ExpectedExit => request.expected_exit_codes = &expected_exit_codes,
        }
        send_exec_start_request(&mut host_stream, seq, request);
        assert_eq!(
            read_error_response(&mut host_stream, seq),
            "session history identity verifier process contract is invalid"
        );
    }

    send_exec_start_request(
        &mut host_stream,
        144,
        verifier_exec_request("{\"unexpected\":true}"),
    );
    assert_eq!(
        read_error_response(&mut host_stream, 144),
        "session history identity verifier payload is invalid"
    );

    assert_ping_pong(&mut host_stream, 145);
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
