use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use crate::telemetry::{SandboxOpRecord, SandboxOpReporter, StorageTelemetry};
use crate::{ArchiveConnectionAttempt, ArchiveSizeMismatch};

#[derive(Serialize)]
struct Operation {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_size_mismatch: Option<ArchiveSizeMismatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_connection_attempt: Option<ArchiveConnectionAttempt>,
}

impl Operation {
    fn new(
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        at: DateTime<Utc>,
    ) -> Self {
        Self {
            ts: at.to_rfc3339_opts(SecondsFormat::Millis, true),
            action_type: action_type.to_owned(),
            duration_ms: u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
            success,
            error: error.map(str::to_owned),
            outcome: None,
            reason: None,
            archive_size_mismatch: None,
            archive_connection_attempt: None,
        }
    }
}

pub struct TestJobTelemetry {
    api_url: String,
    pending_ops: Vec<Operation>,
}

impl TestJobTelemetry {
    pub(crate) fn new(api_url: impl Into<String>) -> Self {
        Self {
            api_url: api_url.into(),
            pending_ops: Vec::new(),
        }
    }

    pub(crate) fn pending_ops_snapshot(&self) -> Vec<(String, bool, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| (op.action_type.clone(), op.success, op.error.clone()))
            .collect()
    }

    pub(crate) fn pending_ops_with_duration_snapshot(
        &self,
    ) -> Vec<(String, u64, bool, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.duration_ms,
                    op.success,
                    op.error.clone(),
                )
            })
            .collect()
    }

    pub(crate) fn pending_ops_with_outcome_snapshot(
        &self,
    ) -> Vec<(String, bool, Option<String>, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.success,
                    op.outcome.clone(),
                    op.reason.clone(),
                )
            })
            .collect()
    }

    pub(crate) fn pending_archive_connection_attempt_payloads(&self) -> Vec<serde_json::Value> {
        self.pending_ops
            .iter()
            .filter(|op| op.archive_connection_attempt.is_some())
            .map(|op| serde_json::to_value(op).unwrap())
            .collect()
    }

    pub(crate) async fn flush(self) {
        send(self.api_url, self.pending_ops).await;
    }
}

impl StorageTelemetry for TestJobTelemetry {
    fn record(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
    ) {
        self.pending_ops.push(Operation::new(
            action_type,
            duration,
            success,
            error,
            Utc::now(),
        ));
    }

    fn record_bounded_outcome(
        &mut self,
        action_type: &'static str,
        success: bool,
        outcome: &'static str,
        reason: Option<&'static str>,
    ) {
        let mut op = Operation::new(action_type, Duration::ZERO, success, None, Utc::now());
        op.outcome = Some(outcome.to_owned());
        op.reason = reason.map(str::to_owned);
        self.pending_ops.push(op);
    }

    fn record_archive_phase_at(
        &mut self,
        record: SandboxOpRecord,
        completed_at: DateTime<Utc>,
        mismatch: Option<ArchiveSizeMismatch>,
        connection_attempt: Option<ArchiveConnectionAttempt>,
    ) {
        let mut op = Operation::new(
            record.action_type,
            record.duration,
            record.success,
            record.error,
            completed_at,
        );
        op.archive_size_mismatch = mismatch;
        op.archive_connection_attempt = connection_attempt;
        self.pending_ops.push(op);
    }

    fn reporter(&self) -> SandboxOpReporter {
        let api_url = self.api_url.clone();
        SandboxOpReporter::new(move |records| {
            let api_url = api_url.clone();
            async move {
                let ops = records
                    .into_iter()
                    .map(|record| {
                        Operation::new(
                            record.action_type,
                            record.duration,
                            record.success,
                            record.error,
                            Utc::now(),
                        )
                    })
                    .collect();
                send(api_url, ops).await;
            }
        })
    }
}

async fn send(api_url: String, ops: Vec<Operation>) {
    if ops.is_empty() {
        return;
    }
    let payload = serde_json::json!({
        "runId": "00000000-0000-0000-0000-000000000000",
        "runnerVersion": env!("CARGO_PKG_VERSION"),
        "sandboxOperations": ops,
    });
    let _ = reqwest::Client::new()
        .post(format!(
            "{}/api/webhooks/agent/telemetry",
            api_url.trim_end_matches('/')
        ))
        .bearer_auth("test-token")
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await;
}
