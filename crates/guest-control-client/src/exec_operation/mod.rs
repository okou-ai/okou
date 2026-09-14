use std::io;
use std::time::Duration;

mod diagnostics;
mod dispatch;
mod frame;
mod handle;
mod start;
mod state;
mod types;

pub use handle::{
    ExecControlHandle, ExecOperationHandle, SupervisedExecCancelHandle, SupervisedExecHandle,
};
pub use types::{
    CodexSessionCleanupRequest, ExecCaptureRequest, ExecControlAck, ExecControlGuestStatus,
    ExecControlOutcome, ExecOperationRequest, ExecOperationResult, ExecOutputEvent,
    ExecOwnedCapturedOutput, ExecStreamRequest, SessionHistoryIdentityVerifyRequest,
    SupervisedExecControl, SupervisedExecRequest, SupervisedExecStartTiming,
};

pub(crate) use diagnostics::log_operations_closed;
pub(crate) use dispatch::dispatch_incoming_frame;
pub(crate) use handle::{ExecOperationCancelOnDropGuard, ExecOperationWaitOutcome};
pub(crate) use start::{
    append_diagnostic, codex_session_cleanup_on_shared, exec_operation_capture_on_shared,
    exec_operation_capture_on_shared_with_write_admission,
    exec_operation_capture_on_shared_with_write_observer,
    exec_operation_capture_with_composite_on_shared_and_observer,
    exec_operation_cleanup_untracked_on_shared_with_write_observer,
    exec_operation_cleanup_with_composite_on_shared_and_observer, exec_operation_stream_on_shared,
    exec_operation_stream_with_composite_on_shared_and_observer,
    session_history_identity_verify_on_shared, start_exec_operation_on_shared,
    start_supervised_exec_on_shared, start_supervised_process_on_shared,
};
pub(crate) use state::Operations;

pub(crate) const DEFAULT_EXEC_CAPTURE_LIMIT_BYTES: u32 = 1024 * 1024;
pub(crate) const SMALL_EXEC_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;
const DEFAULT_EXEC_STREAM_CAPACITY: usize = 32;
// Bounds queued output events, not bytes. The guest drainer reads up to 64 KiB
// and splits each read at the requested chunk limit. Short reads or smaller
// chunk limits can exhaust slots with fewer bytes, so this is not guaranteed
// byte headroom. Each stream's total byte limit is enforced separately.
// Bounded copies rely on concurrent draining and fail explicitly on overflow.
pub(crate) const MAX_EXEC_STREAM_CAPACITY: usize = sandbox::ProcessOutputMode::MAX_QUEUE_CAPACITY;
const EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES: usize = 100;
const EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT: usize = 16;
const EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD: Duration = Duration::from_millis(500);
const EXEC_OPERATION_STAGE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_millis(250);

fn exec_operation_guest_error(message: String) -> io::Error {
    io::Error::other(message)
}

fn exec_operation_protocol_error(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::future::Future;
    use std::io;
    use std::sync::Arc;
    use std::time::Duration;

    use crate::{FrameWriteObserver, Shared};

    use super::MAX_EXEC_STREAM_CAPACITY;
    use super::handle::SupervisedExecHandle;
    use super::start::start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout;
    use super::types::SupervisedExecRequest;

    pub(crate) const MAX_STREAM_CAPACITY: usize = MAX_EXEC_STREAM_CAPACITY;

    pub(crate) fn set_exec_output_before_copy_hook(
        shared: &Arc<Shared>,
        hook: impl FnOnce() + Send + 'static,
    ) {
        let previous = shared
            .exec_output_before_copy_hook
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .replace(Box::new(hook));
        assert!(previous.is_none(), "exec output copy hook already set");
    }

    pub(crate) async fn start_supervised_exec_after_start_write<F>(
        shared: &Arc<Shared>,
        request: SupervisedExecRequest<'_>,
        after_start_write: F,
        start_timeout_cancel_write_timeout: Duration,
    ) -> io::Result<SupervisedExecHandle>
    where
        F: Future<Output = ()>,
    {
        start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout(
            shared,
            request,
            after_start_write,
            start_timeout_cancel_write_timeout,
            FrameWriteObserver::default(),
        )
        .await
    }

    pub(crate) async fn start_supervised_exec_with_write_observer(
        shared: &Arc<Shared>,
        request: SupervisedExecRequest<'_>,
        write_observer: FrameWriteObserver,
    ) -> io::Result<SupervisedExecHandle> {
        start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout(
            shared,
            request,
            std::future::ready(()),
            super::EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT,
            write_observer,
        )
        .await
    }
}

#[cfg(test)]
mod tests;
