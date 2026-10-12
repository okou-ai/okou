//! Fixed, content-free Host observations for one storage apply call.

use std::time::Duration;

/// Caller-owned observations, separate from the operation's result or authority.
///
/// A missing phase was not observed, rather than taking zero time. Completed
/// attempts can be retained when the call returns an error. Dropping an ongoing
/// future does not manufacture a completed phase or terminal result.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageManifestTiming {
    /// Policy checks and guest-client acquisition before the accepted call.
    pub admission: Option<Duration>,
    /// The fixed request/response phases on the existing connection.
    pub request: StorageManifestRequestTiming,
    /// Existing resource evidence serialization/logging after result decoding.
    pub resource_log: Option<Duration>,
}

/// Host wall durations from one dedicated storage request.
///
/// These include Host scheduling. Response wait includes Guest execution and
/// response work plus Host reader framing, copying, dispatch and wake-up; it
/// can overlap Guest execution that began while the request was still writing.
/// It is not pure transport and must not alone be reduced by the Guest duration.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageManifestRequestTiming {
    /// Normal-operation reservation and pending-response registration.
    pub setup: Option<Duration>,
    /// Wait for the shared frame-builder gate before encoding.
    pub frame_builder_wait: Option<Duration>,
    /// Existing bounded request validation and frame construction.
    pub frame_encode: Option<Duration>,
    /// Canonical writer-lock wait, excluding write admission.
    pub writer_wait: Option<Duration>,
    /// Canonical frame write, excluding unlock/observation and write admission.
    pub frame_write: Option<Duration>,
    /// Complete request write through the original terminal-result wait.
    pub response_wait: Option<Duration>,
    /// Core result/resource validation and owned output construction.
    pub result_decode: Option<Duration>,
}
