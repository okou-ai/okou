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
