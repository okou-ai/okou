use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use guest_control_client::{
    ExecControlOutcome, FrameWriteObserver, SupervisedExecControl, SupervisedExecRequest,
};
use guest_control_proto::{
    ExecControlStatus, ExecOutputPolicy, ExecProcessRole, ExecTermination, ExecTimeoutPolicy,
};

use crate::support::Harness;

#[tokio::test]
async fn test_control_guest_timeout_retains_diagnostics_and_terminal_ownership() {
    let program_dir = tempfile::tempdir().unwrap();
    let program = program_dir.path().join("agent.sh");
    // The controlled Agent stays alive without connecting its input sink. The
    // real Guest server must return its deadline status, not a fabricated reply.
    std::fs::write(&program, b"#!/bin/sh\nexec sleep 60\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let h = Harness::new_with_guest_agent_program(program).await;
    let diagnostic_path = h.dir.join("diagnostic.txt");
    std::fs::write(&diagnostic_path, b"retained diagnostics").unwrap();
    let handle = h
        .host()
        .start_supervised_exec(SupervisedExecRequest {
            role: ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::None,
            timeout_is_expected: false,
            command: "",
            env: &[],
            sudo: false,
            label: "control-deadline",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stdin_bytes: None,
            control: SupervisedExecControl::Enabled { sink: true },
            stream_queue_capacity: None,
            start_timeout: Duration::from_secs(5),
        })
        .await
        .unwrap();
    let control = handle.control_handle().unwrap();
    let outcome = control
        .control_with_write_observer(
            "deadline-message",
            b"input",
            Duration::from_millis(25),
            FrameWriteObserver::default(),
        )
        .await;
    let diagnostic = h
        .host()
        .read_file(diagnostic_path.to_str().unwrap(), 1024, 1000)
        .await;
    // Cancel and reap even when a baseline regression rejects diagnostics.
    let terminal = handle.cancel_and_wait(Duration::from_secs(5)).await;
    let fence = h.host().try_fence_normal_operations();
    let parkable = fence.is_ok();
    drop(fence);
    drop(control);
    h.finish();

    assert!(
        matches!(outcome, Ok(ExecControlOutcome::GuestStatus(ref status)) if status.status == ExecControlStatus::SinkTimeout),
        "Guest deadline response must remain matched: {outcome:?}"
    );
    assert_eq!(diagnostic.unwrap(), Some(b"retained diagnostics".to_vec()));
    assert_eq!(terminal.unwrap().termination, ExecTermination::Cancelled);
    assert!(
        parkable,
        "matched control timeout must retain safe admission"
    );
}
