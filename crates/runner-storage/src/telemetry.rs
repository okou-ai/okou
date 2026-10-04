use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::ArchiveConnectionAttempt;
pub(crate) use crate::ArchiveSizeMismatch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxOpRecord {
    pub action_type: &'static str,
    pub duration: Duration,
    pub success: bool,
    pub error: Option<&'static str>,
}

impl SandboxOpRecord {
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

#[derive(Clone)]
pub struct SandboxOpReporter {
    report: Arc<ReportFn>,
}

impl SandboxOpReporter {
    pub fn new<F, Fut>(report: F) -> Self
    where
        F: Fn(Vec<SandboxOpRecord>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Self {
            report: Arc::new(move |records| Box::pin(report(records))),
        }
    }

    pub async fn report(&self, records: Vec<SandboxOpRecord>) {
        (self.report)(records).await;
    }
}

pub trait StorageTelemetry: Send {
    fn record(&mut self, action_type: &str, duration: Duration, success: bool, error: Option<&str>);

    fn record_bounded_outcome(
        &mut self,
        action_type: &'static str,
        success: bool,
        outcome: &'static str,
        reason: Option<&'static str>,
    );

    fn record_archive_phase_at(
        &mut self,
        record: SandboxOpRecord,
        completed_at: DateTime<Utc>,
        mismatch: Option<ArchiveSizeMismatch>,
        connection_attempt: Option<ArchiveConnectionAttempt>,
    );

    fn reporter(&self) -> SandboxOpReporter;
}

#[cfg(not(test))]
pub(crate) type JobTelemetry = dyn StorageTelemetry;
#[cfg(test)]
pub(crate) use crate::test_telemetry::TestJobTelemetry as JobTelemetry;
