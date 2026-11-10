//! Opt-in, run-scoped synchronization for native CLI integration tests.

use tokio::sync::oneshot;

use super::HeartbeatMonitor;
use crate::error::AgentError;

/// Suspend execution after `turn/start` and before event/heartbeat arbitration.
///
/// This observes the real client FIFO and heartbeat receiver without consuming
/// either input. The test peer supplies protocol output and heartbeat status.
pub struct CodexTurnStartGate {
    /// Reports whether the client buffered a successful completion for this turn.
    pub terminal_buffered: oneshot::Sender<bool>,
    /// The test acknowledges delivery of its heartbeat status.
    pub heartbeat_delivered: oneshot::Receiver<()>,
    /// Reports receiver readiness while arbitration remains paused.
    pub heartbeat_ready: oneshot::Sender<bool>,
    /// Resume only after the test has checked both readiness witnesses.
    pub resume: oneshot::Receiver<()>,
}

impl CodexTurnStartGate {
    pub(crate) async fn wait(
        self,
        terminal_buffered: bool,
        heartbeat_monitor: &HeartbeatMonitor,
    ) -> Result<(), AgentError> {
        self.terminal_buffered
            .send(terminal_buffered)
            .map_err(|_| AgentError::Execution("Codex turn-start gate observer dropped".into()))?;
        self.heartbeat_delivered.await.map_err(|_| {
            AgentError::Execution("Codex heartbeat delivery acknowledgement dropped".into())
        })?;
        let heartbeat_ready = heartbeat_monitor
            .as_ref()
            .is_some_and(|receiver| !receiver.is_empty());
        self.heartbeat_ready.send(heartbeat_ready).map_err(|_| {
            AgentError::Execution("Codex heartbeat readiness observer dropped".into())
        })?;
        self.resume
            .await
            .map_err(|_| AgentError::Execution("Codex turn-start gate resume dropped".into()))?;
        Ok(())
    }
}
