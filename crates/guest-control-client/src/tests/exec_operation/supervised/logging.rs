use std::time::Duration;

use guest_control_proto::{ExecOutputStream, ExecProcessRole, ExecTermination};
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use super::super::super::support::{
    send_discarded_exec_result, send_exec_output, send_exec_result,
};
use super::support::{
    start_supervised_exec_fixture, start_supervised_process_fixture, supervised_request,
    supervised_stream_request,
};
use crate::{SupervisedExecControl, SupervisedExecRequest};

#[tokio::test]
async fn expected_timeout_keeps_output_overflow_warning() {
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut started = start_supervised_process_fixture(SupervisedExecRequest {
        timeout_is_expected: true,
        timeout: guest_control_proto::ExecTimeoutPolicy::Duration { timeout_ms: 10_000 },
        ..supervised_stream_request("bounded-stream")
    })
    .await;
    let mut output = started.handle.take_process_output_receiver().unwrap();
    for (sequence, bytes) in [(0, b"first".as_slice()), (1, b"second".as_slice())] {
        send_exec_output(
            &mut started.guest,
            started.start.seq(),
            sequence,
            ExecOutputStream::Stdout,
            bytes,
            false,
        )
        .await;
    }
    send_discarded_exec_result(
        &mut started.guest,
        started.start.seq(),
        ExecTermination::TimedOut,
    )
    .await;
    let result = started.handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::TimedOut);
    assert!(result.stream_overflowed);
    assert_eq!(output.recv().await.unwrap().bytes, b"first");
    assert!(output.recv().await.is_none());
    let events = captured.entries();
    let terminal = events
        .iter()
        .find(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("exec operation terminal result")
        })
        .unwrap();
    assert_eq!(terminal.level, Level::WARN);
    assert_eq!(
        terminal.fields.get("process_class").map(String::as_str),
        Some("contained_workload")
    );
    assert_eq!(
        terminal.fields.get("operation_kind").map(String::as_str),
        Some("start_process")
    );
    assert_eq!(
        terminal.fields.get("terminal_reason").map(String::as_str),
        Some("notable")
    );
    assert_eq!(
        terminal.fields.get("stream_overflowed").map(String::as_str),
        Some("true")
    );
}

#[tokio::test]
async fn expected_workload_timeout_setting_does_not_demote_agent_timeout() {
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut started = start_supervised_exec_fixture(SupervisedExecRequest {
        role: ExecProcessRole::Agent,
        timeout_is_expected: true,
        timeout: guest_control_proto::ExecTimeoutPolicy::Duration { timeout_ms: 10_000 },
        control: SupervisedExecControl::Enabled { sink: true },
        ..supervised_request("")
    })
    .await;
    send_exec_result(
        &mut started.guest,
        started.start.seq(),
        ExecTermination::TimedOut,
        b"",
        b"",
    )
    .await;
    let result = started.handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::TimedOut);
    let events = captured.entries();
    let terminal = events
        .iter()
        .find(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("exec operation terminal result")
        })
        .unwrap();
    assert_eq!(terminal.level, Level::WARN);
    assert_eq!(
        terminal.fields.get("terminal_reason").map(String::as_str),
        Some("notable")
    );
    assert_eq!(
        terminal.fields.get("process_class").map(String::as_str),
        Some("controlled_agent")
    );
    assert_eq!(
        terminal.fields.get("operation_kind").map(String::as_str),
        Some("start_agent_process")
    );
}
