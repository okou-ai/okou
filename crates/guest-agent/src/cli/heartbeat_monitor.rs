//! CLI heartbeat reception and native backend failure classification.

use guest_contracts::diagnostics::{CliTerminationReason, HeartbeatFailureDiagnostic};
use tokio::sync::oneshot;

use super::{HeartbeatMonitor, HeartbeatStatus};
use crate::error::AgentError;

pub(super) async fn wait_for_heartbeat(
    monitor: &mut HeartbeatMonitor,
) -> Result<HeartbeatStatus, oneshot::error::RecvError> {
    match monitor.as_mut() {
        Some(receiver) => receiver.await,
        None => std::future::pending().await,
    }
}

pub(super) enum NativeHeartbeatOutcome {
    Stopped,
    Failed(NativeHeartbeatFailure),
}

pub(super) struct NativeHeartbeatFailure {
    pub(super) error: AgentError,
    pub(super) diagnostic: Option<HeartbeatFailureDiagnostic>,
    pub(super) termination_reason: CliTerminationReason,
}

pub(super) async fn wait_for_native_heartbeat(
    monitor: &mut HeartbeatMonitor,
) -> NativeHeartbeatOutcome {
    let failure = match wait_for_heartbeat(monitor).await {
        Ok(HeartbeatStatus::Stopped) => return NativeHeartbeatOutcome::Stopped,
        Ok(HeartbeatStatus::Failed(failure)) => NativeHeartbeatFailure {
            error: failure.error,
            diagnostic: Some(failure.diagnostic),
            termination_reason: CliTerminationReason::HeartbeatError,
        },
        Ok(HeartbeatStatus::TaskFailed(message)) => NativeHeartbeatFailure {
            error: AgentError::Execution(format!("heartbeat task panicked: {message}")),
            diagnostic: None,
            termination_reason: CliTerminationReason::HeartbeatPanic,
        },
        Err(error) => NativeHeartbeatFailure {
            error: AgentError::Execution(format!(
                "heartbeat task stopped before reporting status: {error}"
            )),
            diagnostic: None,
            termination_reason: CliTerminationReason::HeartbeatPanic,
        },
    };
    NativeHeartbeatOutcome::Failed(failure)
}
