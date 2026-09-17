use std::fs;
use std::io::{Cursor, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::thread;

use guest_contracts::process_containment::{
    CANONICAL_TOOL_CGROUP_PROCS_ENV, CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
};
use guest_control_proto::{
    self, ExecControlPolicy, ExecControlStatus, ExecLifecyclePolicy, ExecOutputPolicy,
    ExecStartEncodeRequest, ExecTermination, ExecTimeoutPolicy, MSG_EXEC_AGENT_READY,
    MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_OPERATIONS_QUIESCED,
};

use super::exec_helpers::*;
use super::support::*;

#[test]
fn supervised_exec_sends_started_before_output() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        201,
        "printf ready",
        ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
        ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 1024,
        },
        ExecControlPolicy::Disabled,
    );

    assert!(read_exec_started(&mut host_stream, 201) > 0);
    let (chunks, result) = read_exec_result(&mut host_stream, 201);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&chunks), b"ready".to_vec());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_spawn_failure_returns_start_failed_without_started_ack() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        202,
        "bad\0command",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecControlPolicy::Disabled,
    );

    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 202);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.diagnostic.contains("Failed to execute"));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_spawn_failure_releases_registration() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        208,
        "bad\0command",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );

    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 208);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.diagnostic.contains("Failed to execute"));

    send_exec_control(
        &mut host_stream,
        310,
        208,
        EXEC_CONTROL_NONCE,
        "message-after-start-failed",
    );
    assert_exec_control_result(
        &mut host_stream,
        310,
        208,
        EXEC_CONTROL_NONCE,
        "message-after-start-failed",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    send_quiesce_operations(&mut host_stream, 311);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 311);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn controlled_agent_spawn_failure_returns_start_failed_and_releases_registration() {
    let agent_path = unique_tmp_path("controlled-agent-missing", ".secret");
    let target_seq = 212;
    let control_nonce = unique_exec_control_nonce(u64::from(target_seq));
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_agent_program(PathBuf::from(agent_path.as_str()));

    send_exec_start_request(
        &mut host_stream,
        target_seq,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            role: guest_control_proto::ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::None,
            command: "",
            env: &[],
            sudo: false,
            label: "controlled-agent-start-failure",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Enabled {
                control_nonce,
                sink: true,
            },
            stdin_bytes: None,
        },
    );

    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, target_seq);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert_eq!(
        result.diagnostic,
        "Failed to execute controlled Agent: agent bootstrap failed: guest-agent is missing"
    );
    assert!(!result.diagnostic.contains(agent_path.as_str()));

    send_exec_control(
        &mut host_stream,
        320,
        target_seq,
        control_nonce,
        "message-after-agent-start-failed",
    );
    assert_exec_control_result(
        &mut host_stream,
        320,
        target_seq,
        control_nonce,
        "message-after-agent-start-failed",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    send_quiesce_operations(&mut host_stream, 321);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 321);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_forwards_to_bootstrap_sink() {
    assert_bootstrap_sink_forwarding(AgentStartupOrder::AsReceived, 1024);
}

#[test]
fn supervised_exec_control_forwards_to_bootstrap_sink_with_output_before_ready() {
    assert_bootstrap_sink_forwarding(AgentStartupOrder::OutputFirst, 7);
}

#[test]
fn supervised_exec_control_forwards_to_bootstrap_sink_with_ready_before_output() {
    assert_bootstrap_sink_forwarding(AgentStartupOrder::ReadyFirst, 7);
}

enum AgentStartupOrder {
    AsReceived,
    OutputFirst,
    ReadyFirst,
}

fn read_bootstrap_startup(
    stream: &mut impl Read,
    seq: u32,
    endpoint: &[u8],
    order: AgentStartupOrder,
) -> guest_control_proto::ExecAgentReadyTiming {
    let first_type = match order {
        AgentStartupOrder::AsReceived => {
            return read_exec_agent_ready_and_stdout(stream, seq, endpoint);
        }
        AgentStartupOrder::OutputFirst => MSG_EXEC_OUTPUT,
        AgentStartupOrder::ReadyFirst => MSG_EXEC_AGENT_READY,
    };

    // Replay real connection frames in each legal order without changing the
    // producer's scheduling. Keep every frame and the relative order of stdout.
    let mut frames = Vec::new();
    let mut saw_ready = false;
    let mut saw_output = false;
    while !saw_ready || !saw_output {
        assert!(frames.len() < endpoint.len() + 1, "too many startup frames");
        let msg = read_message(stream);
        match msg.msg_type {
            MSG_EXEC_AGENT_READY => saw_ready = true,
            MSG_EXEC_OUTPUT => saw_output = true,
            other => panic!("unexpected startup frame: 0x{other:02X}"),
        }
        frames.push(msg);
    }
    frames.sort_by_key(|msg| msg.msg_type != first_type);
    let bytes: Vec<u8> = frames
        .into_iter()
        .flat_map(|msg| guest_control_proto::encode(msg.msg_type, msg.seq, &msg.payload).unwrap())
        .collect();
    let mut replay = Cursor::new(bytes).chain(stream);
    let ready = read_exec_agent_ready_and_stdout(&mut replay, seq, endpoint);
    let (replayed, _) = replay.into_inner();
    assert_eq!(replayed.position() as usize, replayed.get_ref().len());
    ready
}

fn assert_bootstrap_sink_forwarding(order: AgentStartupOrder, chunk_limit_bytes: u32) {
    let pid_path = unique_pid_path("supervised-exec-bootstrap-sink");
    let agent_path = unique_tmp_path("supervised-exec-bootstrap-agent", ".sh");
    fs::write(
        agent_path.as_str(),
        r#"#!/bin/sh
printf '%s' "$$" > "$OKOU_TEST_AGENT_PID_PATH"
if [ "${OKOU_WORKLOAD_CGROUP_PROCS_ENDPOINT-}" = stale-canonical-workload-endpoint ]; then exit 43; fi
if [ "${OKOU_TOOL_CGROUP_PROCS_ENDPOINT-}" = stale-canonical-tool-endpoint ]; then exit 43; fi
printf '%s' "$OKOU_PROCESS_CONTROL_ENDPOINT"
sleep 60
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(agent_path.as_str()).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(agent_path.as_str(), permissions).unwrap();
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let target_seq = 203;
    let control_nonce = *uuid::Uuid::new_v4().as_bytes();
    let endpoint = process_control_ipc::endpoint_name(target_seq, &control_nonce);
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_agent_program(PathBuf::from(agent_path.as_str()));

    send_exec_start_request(
        &mut host_stream,
        target_seq,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            role: guest_control_proto::ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::None,
            command: "",
            env: &[
                ("OKOU_TEST_AGENT_PID_PATH", pid_path.as_str()),
                (
                    process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                    "stale-canonical-endpoint",
                ),
                (
                    CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                    "stale-canonical-workload-endpoint",
                ),
                (
                    CANONICAL_TOOL_CGROUP_PROCS_ENV,
                    "stale-canonical-tool-endpoint",
                ),
            ],
            sudo: false,
            label: "supervised-test",
            stdout: ExecOutputPolicy::CaptureAndStream {
                capture_limit_bytes: 1024,
                stream_limit_bytes: 1024,
                chunk_limit_bytes,
            },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Enabled {
                control_nonce,
                sink: true,
            },
            stdin_bytes: None,
        },
    );
    assert!(read_exec_started(&mut host_stream, target_seq) > 0);
    let ready = read_bootstrap_startup(&mut host_stream, target_seq, endpoint.as_bytes(), order);
    assert!(ready.shell_spawn_us > 0);
    let pid = child_guard.read_pid();

    let client_endpoint = endpoint.clone();
    let client = thread::spawn(move || {
        let mut stream = process_control_ipc::connect_abstract(&client_endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();
        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "message");
        assert_eq!(request.payload, b"payload");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: "ok".to_owned(),
            },
        )
        .unwrap();
    });

    send_exec_control(&mut host_stream, 303, target_seq, control_nonce, "message");
    assert_exec_control_result(
        &mut host_stream,
        303,
        target_seq,
        control_nonce,
        "message",
        ExecControlStatus::Delivered,
        "ok",
    );
    client.join().unwrap();

    send_exec_cancel(&mut host_stream, target_seq);
    let (chunks, result) = read_exec_result(&mut host_stream, target_seq);
    assert!(chunks.is_empty(), "unexpected output after the endpoint");
    assert_eq!(result.termination, ExecTermination::Cancelled);
    assert_eq!(result.stdout, Some(endpoint.into_bytes()));
    assert!(!result.stdout_truncated);
    wait_for_pid_exit(pid, "supervised exec bootstrap sink cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_reports_unsupported_without_sink() {
    let pid_path = unique_pid_path("supervised-exec-unsupported-control");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let command = sleep_command_with_pid(pid_path.as_str());

    send_supervised_exec_start(
        &mut host_stream,
        204,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert!(read_exec_started(&mut host_stream, 204) > 0);
    let pid = child_guard.read_pid();

    send_exec_control(&mut host_stream, 304, 204, EXEC_CONTROL_NONCE, "message");
    assert_exec_control_result(
        &mut host_stream,
        304,
        204,
        EXEC_CONTROL_NONCE,
        "message",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );

    send_exec_cancel(&mut host_stream, 204);
    let (_chunks, result) = read_exec_result(&mut host_stream, 204);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "supervised exec unsupported control cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_registries_are_isolated_per_connection() {
    let first_pid_path = unique_pid_path("supervised-exec-first-isolated");
    let second_pid_path = unique_pid_path("supervised-exec-second-isolated");
    let mut first_child_guard = ProcessGroupFileGuard::new(first_pid_path.as_str());
    let mut second_child_guard = ProcessGroupFileGuard::new(second_pid_path.as_str());
    let (first_handle, mut first_stream) = start_guest_connection();
    let (second_handle, mut second_stream) = start_guest_connection();
    let first_command = sleep_command_with_pid(first_pid_path.as_str());
    let second_command = sleep_command_with_pid(second_pid_path.as_str());

    send_supervised_exec_start(
        &mut first_stream,
        209,
        &first_command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    send_supervised_exec_start(
        &mut second_stream,
        209,
        &second_command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );

    assert!(read_exec_started(&mut first_stream, 209) > 0);
    assert!(read_exec_started(&mut second_stream, 209) > 0);
    let first_pid = first_child_guard.read_pid();
    let second_pid = second_child_guard.read_pid();

    send_exec_control(
        &mut first_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-first",
    );
    send_exec_control(
        &mut second_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-second",
    );

    assert_exec_control_result(
        &mut first_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-first",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );
    assert_exec_control_result(
        &mut second_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-second",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );

    send_exec_cancel(&mut first_stream, 209);
    send_exec_cancel(&mut second_stream, 209);

    let (_chunks, first_result) = read_exec_result(&mut first_stream, 209);
    let (_chunks, second_result) = read_exec_result(&mut second_stream, 209);
    assert_eq!(first_result.termination, ExecTermination::Cancelled);
    assert_eq!(second_result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(first_pid, "first supervised exec isolation cleanup");
    wait_for_pid_exit(second_pid, "second supervised exec isolation cleanup");
    first_child_guard.disarm();
    second_child_guard.disarm();

    finish_guest_connection(first_handle, first_stream);
    finish_guest_connection(second_handle, second_stream);
}

#[test]
fn supervised_exec_control_duplicate_start_preserves_active_nonce() {
    let pid_path = unique_pid_path("supervised-exec-duplicate-control");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let command = sleep_command_with_pid(pid_path.as_str());

    send_supervised_exec_start(
        &mut host_stream,
        206,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert!(read_exec_started(&mut host_stream, 206) > 0);
    let pid = child_guard.read_pid();

    send_supervised_exec_start(
        &mut host_stream,
        206,
        "printf duplicate",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_WRONG_NONCE,
            sink: false,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 206),
        "exec operation already active"
    );

    send_exec_control(
        &mut host_stream,
        306,
        206,
        EXEC_CONTROL_WRONG_NONCE,
        "message-wrong-nonce",
    );
    assert_exec_control_result(
        &mut host_stream,
        306,
        206,
        EXEC_CONTROL_WRONG_NONCE,
        "message-wrong-nonce",
        ExecControlStatus::NonceMismatch,
        "exec operation nonce mismatch",
    );

    send_exec_control(
        &mut host_stream,
        307,
        206,
        EXEC_CONTROL_NONCE,
        "message-original-nonce",
    );
    assert_exec_control_result(
        &mut host_stream,
        307,
        206,
        EXEC_CONTROL_NONCE,
        "message-original-nonce",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );

    send_exec_cancel(&mut host_stream, 206);
    let (_chunks, result) = read_exec_result(&mut host_stream, 206);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "supervised exec duplicate control cleanup");
    child_guard.disarm();

    send_quiesce_operations(&mut host_stream, 308);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 308);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_duplicate_start_with_control_does_not_leak_registration() {
    let pid_path = unique_pid_path("supervised-exec-duplicate-registration");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let command = sleep_command_with_pid(pid_path.as_str());

    send_supervised_exec_start(
        &mut host_stream,
        210,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Disabled,
    );
    assert!(read_exec_started(&mut host_stream, 210) > 0);
    let pid = child_guard.read_pid();

    send_supervised_exec_start(
        &mut host_stream,
        210,
        "printf duplicate",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 210),
        "exec operation already active"
    );

    send_exec_control(
        &mut host_stream,
        313,
        210,
        EXEC_CONTROL_NONCE,
        "message-duplicate-control",
    );
    assert_exec_control_result(
        &mut host_stream,
        313,
        210,
        EXEC_CONTROL_NONCE,
        "message-duplicate-control",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    send_exec_cancel(&mut host_stream, 210);
    let (_chunks, result) = read_exec_result(&mut host_stream, 210);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "supervised exec duplicate registration cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_after_exit_returns_inactive() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        207,
        "printf done",
        ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert!(read_exec_started(&mut host_stream, 207) > 0);
    let (_chunks, result) = read_exec_result(&mut host_stream, 207);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"done".to_vec()));

    send_exec_control(
        &mut host_stream,
        309,
        207,
        EXEC_CONTROL_NONCE,
        "message-after-exit",
    );
    assert_exec_control_result(
        &mut host_stream,
        309,
        207,
        EXEC_CONTROL_NONCE,
        "message-after-exit",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    finish_guest_connection(handle, host_stream);
}
