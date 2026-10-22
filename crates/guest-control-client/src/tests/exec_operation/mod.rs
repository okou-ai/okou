use std::time::Duration;

use guest_control_proto::ExecOutputPolicy;
use tokio::sync::mpsc::{self, error::TryRecvError};

use crate::{ExecOperationHandle, ExecOperationRequest, ExecOutputEvent};

fn assert_stream_closed(receiver: &mut mpsc::Receiver<ExecOutputEvent>, scenario: &str) {
    match receiver.try_recv() {
        Err(TryRecvError::Disconnected) => {}
        Err(TryRecvError::Empty) => {
            panic!("{scenario}: stream sender remained open after terminal state")
        }
        Ok(event) => {
            panic!("{scenario}: expected stream closure, received unexpected event: {event:?}")
        }
    }
}

async fn start_capture_operation(
    host: &crate::GuestControlClient,
    command: &str,
) -> ExecOperationHandle {
    host.start_exec_operation(ExecOperationRequest {
        timeout_ms: 5000,
        start_write_timeout: Duration::from_secs(5),
        command,
        env: &[],
        sudo: false,
        label: "test-command",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: &[],
        stdin_bytes: None,
        stream_queue_capacity: None,
    })
    .await
    .unwrap()
}

mod cancel;
mod capture;
mod deadline;
mod exec;
mod lifecycle;
mod malformed;
mod stream;
mod supervised;
