//! A real backend result can wait before delivery to the original API caller.

use tokio::sync::oneshot;

use super::CapturedRequest;

/// Original backend bytes, captured only after a complete response was drained.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendResponse {
    /// Exact request whose real backend produced this response.
    pub request: CapturedRequest,
    /// Actual HTTP status; a receipt alone does not imply success.
    pub status: u16,
    /// Complete original backend response.
    pub raw: Vec<u8>,
}

/// An invocation-owned response-delivery choice, never a native VM fault.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseDisposition {
    /// Deliver the original response normally.
    Deliver,
    /// Unwind the fixture producer only after successful original delivery.
    /// This does not simulate a Firecracker error or unfinished VMM command.
    UnwindAfterDelivery,
}

/// Keep this controller and its producer outside borrowed unpark observations.
pub struct ResponseControl {
    /// Real terminal backend response, before delivery to the original client.
    pub arrived: oneshot::Receiver<BackendResponse>,
    /// Losing this sender delivers normally; it never aborts accepted work.
    pub release: oneshot::Sender<ResponseDisposition>,
}

pub(super) struct PendingResponse {
    pub(super) arrived: oneshot::Sender<BackendResponse>,
    pub(super) release: oneshot::Receiver<ResponseDisposition>,
}

impl PendingResponse {
    pub(super) async fn hold(self, response: BackendResponse) -> ResponseDisposition {
        let _ = self.arrived.send(response);
        self.release.await.unwrap_or(ResponseDisposition::Deliver)
    }
}
