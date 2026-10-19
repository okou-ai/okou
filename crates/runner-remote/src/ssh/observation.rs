//! Diagnostic connection evidence, independent of remote command outcomes.

use api_contracts::generated::types::runners::ssh::ObservationRequestFailureReason;
use chrono::{DateTime, Utc};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use super::FailureReason;

#[derive(Default)]
pub(super) struct Attempt {
    pub(super) effects: Option<crate::diagnostics::EffectObservation>,
    pub(super) trace: crate::diagnostics::trace::Trace,
    pub(super) carrier_trace: Option<crate::diagnostics::trace::Trace>,
    pub(super) native: Option<crate::diagnostics::NativeSource>,
    pub(super) created_at: Option<DateTime<Utc>>,
    pub(super) generation: Option<i64>,
    pub(super) diagnostic_generation: Option<i64>,
    pub(super) connecting: bool,
    pub(super) authenticated_at: Option<DateTime<Utc>>,
    pub(super) access_failure: Option<ObservationRequestFailureReason>,
    pub(super) access_protocol_failed: Option<Arc<AtomicBool>>,
}

pub(super) struct Observation {
    pub(super) created_at: DateTime<Utc>,
    pub(super) generation: i64,
    pub(super) observed_at: DateTime<Utc>,
    pub(super) failure: Option<ObservationRequestFailureReason>,
}

impl Attempt {
    pub(super) fn new(handle: &crate::diagnostics::Handle) -> Self {
        Self {
            trace: crate::diagnostics::trace::Trace::new(handle.enabled()),
            ..Self::default()
        }
    }
    pub(super) fn record(
        &self,
        diagnostics: &crate::diagnostics::Handle,
        connection: uuid::Uuid,
        operation: crate::diagnostics::Operation,
        session: Option<uuid::Uuid>,
        failure: Option<FailureReason>,
    ) -> Option<crate::diagnostics::Report> {
        self.record_cause(
            diagnostics,
            connection,
            operation,
            session,
            crate::diagnostics::Cause::Ssh(failure?),
        )
    }
    pub(super) fn record_cause(
        &self,
        diagnostics: &crate::diagnostics::Handle,
        connection: uuid::Uuid,
        operation: crate::diagnostics::Operation,
        session: Option<uuid::Uuid>,
        cause: crate::diagnostics::Cause,
    ) -> Option<crate::diagnostics::Report> {
        self.snapshot(diagnostics, connection, operation, session, Some(cause))
    }

    pub(super) fn snapshot(
        &self,
        diagnostics: &crate::diagnostics::Handle,
        connection: uuid::Uuid,
        operation: crate::diagnostics::Operation,
        session: Option<uuid::Uuid>,
        cause: Option<crate::diagnostics::Cause>,
    ) -> Option<crate::diagnostics::Report> {
        use crate::diagnostics::trace::{Progress, Stage};
        if let Some(failure) = self
            .carrier_trace
            .as_ref()
            .and_then(crate::diagnostics::trace::Trace::access_cause)
        {
            self.trace.access_failure(failure);
            self.trace.set(Stage::AccessWebsocket, Progress::Failed);
        }
        let status = if matches!(
            cause,
            Some(crate::diagnostics::Cause::Ssh(
                FailureReason::Cancelled | FailureReason::TimedOut
            ))
        ) {
            Progress::Unknown
        } else {
            Progress::Failed
        };
        self.trace.finish(Stage::Operation, status);
        self.trace.finish(Stage::Forwarding, status);
        if self
            .access_protocol_failed
            .as_ref()
            .is_some_and(|failed| failed.load(Ordering::Acquire))
        {
            self.trace.set(
                crate::diagnostics::trace::Stage::AccessWebsocket,
                crate::diagnostics::trace::Progress::Failed,
            );
        }
        diagnostics.record(crate::diagnostics::Record {
            effects: self.effects,
            protocol: crate::diagnostics::Protocol::Ssh,
            connection,
            operation,
            identity: crate::diagnostics::Identity {
                created_at: self.created_at,
                generation: self.generation.or(self.diagnostic_generation),
                session,
            },
            cause,
            dependency: None,
            native: self.native.clone(),
            ssh: self.trace.snapshot(),
            vnc: None,
        })
    }
    pub(super) fn finish(&self, failure: Option<FailureReason>) -> Option<Observation> {
        let generation = self.generation?;
        let created_at = self.created_at?;
        if let Some(observed_at) = self.authenticated_at {
            return Some(Observation {
                created_at,
                generation,
                observed_at,
                failure: None,
            });
        }
        use ObservationRequestFailureReason as Reason;
        if let Some(reason) = self.access_failure.or_else(|| {
            self.access_protocol_failed
                .as_ref()
                .filter(|failed| failed.load(Ordering::Acquire))
                .map(|_| Reason::AccessProtocolFailure)
        }) {
            return Some(Observation {
                created_at,
                generation,
                observed_at: Utc::now(),
                failure: Some(reason),
            });
        }
        let failure = match failure? {
            FailureReason::InvalidCredential => Reason::InvalidCredential,
            FailureReason::UnsupportedCredential => Reason::UnsupportedCredential,
            FailureReason::CredentialResourceLimit => Reason::CredentialResourceLimit,
            FailureReason::UnsafeDestination => Reason::UnsafeDestination,
            FailureReason::NetworkFailure => Reason::NetworkFailure,
            FailureReason::HostKeyMismatch => Reason::HostKeyMismatch,
            FailureReason::UnsupportedHostKey => Reason::UnsupportedHostKey,
            FailureReason::AuthenticationFailed => Reason::AuthenticationFailed,
            FailureReason::Protocol if self.connecting => Reason::Protocol,
            FailureReason::TimedOut if self.connecting => Reason::TimedOut,
            _ => return None,
        };
        Some(Observation {
            created_at,
            generation,
            observed_at: Utc::now(),
            failure: Some(failure),
        })
    }
}
