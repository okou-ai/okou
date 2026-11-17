use std::time::Duration;

/// Content-free Host wall observations for one normal Guest request.
///
/// Missing phases were not observed; measured zero is retained. Completed
/// attempts survive returned errors. Response wait includes Guest work and Host
/// scheduling/dispatch, and can overlap Guest work started during frame writing.
/// These observations are not a measurement of pure transport latency.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RequestTiming {
    /// Normal-operation reservation and pending-response registration.
    pub setup: Option<Duration>,
    /// Shared frame-builder gate wait.
    pub frame_builder_wait: Option<Duration>,
    /// Bounded validation and frame construction.
    pub frame_encode: Option<Duration>,
    /// Writer-lock wait, excluding write admission.
    pub writer_wait: Option<Duration>,
    /// Frame write, excluding unlock/observation and write admission.
    pub frame_write: Option<Duration>,
    /// Complete request write through terminal-result wait.
    pub response_wait: Option<Duration>,
    /// Core result validation and owned output construction.
    pub result_decode: Option<Duration>,
}
