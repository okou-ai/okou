//! Native CLI deadline and active-input settlement policy.

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::active_input::ActiveInputController;
use crate::constants::ACTIVE_INPUT_SINK_QUIESCENCE_TIMEOUT_SECS;

use super::{AgentExecutionDeadline, CliExecutionResult};

pub(super) enum NativeRunOutcome<E> {
    Completed(Box<Result<CliExecutionResult, E>>),
    ExecutionTimedOut { timeout_secs: u64 },
    UserCancelled,
}

pub(super) async fn run_with_execution_deadline<E>(
    run: impl Future<Output = Result<CliExecutionResult, E>>,
    deadline: Option<AgentExecutionDeadline>,
    user_cancellation: &CancellationToken,
    active_input: &ActiveInputController,
) -> NativeRunOutcome<E> {
    tokio::pin!(run);

    let deadline = deadline.map(|deadline| {
        let at = tokio::time::Instant::from_std(deadline.at);
        (tokio::time::sleep_until(at), deadline.timeout_secs)
    });
    let deadline_elapsed = async move {
        match deadline {
            Some((sleep, timeout_secs)) => {
                sleep.await;
                timeout_secs
            }
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline_elapsed);

    let stopped = tokio::select! {
        biased;
        result = &mut run => return NativeRunOutcome::Completed(Box::new(result)),
        () = user_cancellation.cancelled() => NativeRunOutcome::UserCancelled,
        timeout_secs = &mut deadline_elapsed => NativeRunOutcome::ExecutionTimedOut {
            timeout_secs,
        },
    };
    active_input.close_terminal();
    if active_input.sink_in_flight() {
        // Let an in-flight sink settle while retaining the selected stop reason.
        let settle = async {
            tokio::select! {
                biased;
                _ = &mut run => {}
                _ = active_input.wait_for_sink_idle() => {}
            }
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(ACTIVE_INPUT_SINK_QUIESCENCE_TIMEOUT_SECS),
            settle,
        )
        .await;
    }
    stopped
}
