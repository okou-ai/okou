use std::time::Duration;

use crate::RequestTiming;

/// Optional observations on the existing ordinary batch write operation.
/// They grant no authority and never change deadlines, results or cancellation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FileWriteTiming {
    /// Attempted Sandbox policy/client admission, including returned errors.
    pub admission: Option<Duration>,
    /// Observations owned by the Host client, independent of backend admission.
    pub request: FileWriteRequestTiming,
}

/// Host client observations for one ordinary binary batch, reset at entry.
/// Unobserved phases remain absent, including after validation/transport errors.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FileWriteRequestTiming {
    /// Validation from client entry through protocol validation before locking.
    pub validation: Option<Duration>,
    /// Per-path lock acquisition, including bounded lock-map preparation.
    pub path_lock_wait: Option<Duration>,
    /// Wait for the connection's single accepted file-write gate.
    pub file_gate_wait: Option<Duration>,
    /// The existing request/response owner and frame writer's observations.
    pub host: RequestTiming,
}
