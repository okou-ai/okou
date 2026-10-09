use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::ArchiveConnectionAttempt;
pub(crate) use crate::ArchiveSizeMismatch;

/// Caller-supplied data for a timed sandbox operation or a zero-duration marker.
///
/// This value carries no run identity, completion timestamp, or structured
/// archive diagnostics. Ordinary background reporting through
/// [`SandboxOpReporter`] therefore does not preserve the operation's completion
/// time. Archive phases supply that information separately through
/// [`StorageTelemetry::record_archive_phase_at`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxOpRecord {
    /// Fixed operation name used to classify the record.
    pub action_type: &'static str,
    /// Caller-measured elapsed time, or zero for an untimed marker.
    pub duration: Duration,
    /// Whether the operation or marker represents a successful outcome.
    pub success: bool,
    /// Optional bounded error label, not a raw error message or object identity.
    pub error: Option<&'static str>,
}

impl SandboxOpRecord {
    /// Store the supplied values without measuring time or reporting the record.
    pub const fn new(
        action_type: &'static str,
        duration: Duration,
        success: bool,
        error: Option<&'static str>,
    ) -> Self {
        Self {
            action_type,
            duration,
            success,
            error,
        }
    }
}

type ReportFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type ReportFn = dyn Fn(Vec<SandboxOpRecord>) -> ReportFuture + Send + Sync;

/// Cloneable callback wrapper for reporting operations independently of a sink.
///
/// Clones share the same callback. The callback owns its reporting context,
/// including any run attribution; the wrapper itself contains no run identity.
/// It adds no background worker, retry policy, persistence, or delivery
/// acknowledgement. Callers own any tasks used to await [`Self::report`].
#[derive(Clone)]
pub struct SandboxOpReporter {
    report: Arc<ReportFn>,
}

impl SandboxOpReporter {
    /// Wrap an asynchronous callback and its owned reporting context.
    ///
    /// The callback must not borrow the originating mutable sink. Scheduling,
    /// transport, and failure handling remain the callback's or caller's concern.
    pub fn new<F, Fut>(report: F) -> Self
    where
        F: Fn(Vec<SandboxOpRecord>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Self {
            report: Arc::new(move |records| Box::pin(report(records))),
        }
    }

    /// Invoke the shared callback with these records and await it on this task.
    ///
    /// Returning `()` means the callback completed, not that a receiver accepted
    /// or durably stored the records. There is no delivery result from this wrapper.
    pub async fn report(&self, records: Vec<SandboxOpRecord>) {
        (self.report)(records).await;
    }
}

/// Run-attributed telemetry boundary used by storage planning and cache work.
///
/// Implementations retain the distinction between timed operations, untimed
/// outcome markers, and archive phases with explicit event times and diagnostics.
/// [`Self::reporter`] supplies independently usable background reporting with the
/// originating run attribution; buffering and delivery policy belong to the adapter.
pub trait StorageTelemetry: Send {
    /// Record an operation with caller-measured elapsed time and its outcome.
    ///
    /// Use recording time as the event timestamp; this method receives no earlier
    /// completion time. Use [`Self::record_archive_phase_at`] for delayed collection
    /// of archive phases. Action and optional error labels should be bounded and
    /// must not include credentials, URLs, or object identities.
    fn record(&mut self, action_type: &str, duration: Duration, success: bool, error: Option<&str>);

    /// Record a zero-duration marker with fixed, low-cardinality outcome dimensions.
    ///
    /// `outcome` and optional `reason` classify the result; they are not elapsed
    /// time or raw counts. Callers must use a bounded label set rather than embed
    /// dynamic data. Static string lifetimes alone do not enforce low cardinality.
    fn record_bounded_outcome(
        &mut self,
        action_type: &'static str,
        success: bool,
        outcome: &'static str,
        reason: Option<&'static str>,
    );

    /// Record an archive phase at its captured completion time with its diagnostics.
    ///
    /// Preserve `completed_at` as the event timestamp even when the owner drains
    /// the record later or upload happens later. Preserve optional `mismatch` and
    /// `connection_attempt` metadata alongside the operation; `None` means no
    /// diagnostic observation is supplied, not a zero-valued observation.
    ///
    /// See the [host archive phase diagnostics guide](https://github.com/okou-ai/okou/blob/9813db4b51faa42c982dcfec1720caf5bd5b1b82/docs/host-archive-phase-diagnostics.md)
    /// for phase boundaries, event-time semantics, and diagnostic interpretation.
    fn record_archive_phase_at(
        &mut self,
        record: SandboxOpRecord,
        completed_at: DateTime<Utc>,
        mismatch: Option<ArchiveSizeMismatch>,
        connection_attempt: Option<ArchiveConnectionAttempt>,
    );

    /// Create a reporter that retains this sink's originating run attribution.
    ///
    /// It must remain usable after the mutable sink is dropped and report
    /// independently of that sink's pending records. Storage callers may retain
    /// one reporter per subscriber and await reports in their own background tasks.
    /// [`SandboxOpRecord`] has no completion timestamp, so these ordinary reports
    /// do not have the explicit event-time guarantee of [`Self::record_archive_phase_at`].
    fn reporter(&self) -> SandboxOpReporter;
}

#[cfg(not(test))]
pub(crate) type JobTelemetry = dyn StorageTelemetry;
#[cfg(test)]
pub(crate) use crate::test_telemetry::TestJobTelemetry as JobTelemetry;
