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
    pub(super) generation: Option<i64>,
    pub(super) connecting: bool,
    pub(super) authenticated_at: Option<DateTime<Utc>>,
    pub(super) access_failure: Option<ObservationRequestFailureReason>,
    pub(super) access_protocol_failed: Option<Arc<AtomicBool>>,
}

pub(super) struct Observation {
    pub(super) generation: i64,
    pub(super) observed_at: DateTime<Utc>,
    pub(super) failure: Option<ObservationRequestFailureReason>,
}

impl Attempt {
    pub(super) fn finish(&self, failure: Option<FailureReason>) -> Option<Observation> {
        let generation = self.generation?;
        if let Some(observed_at) = self.authenticated_at {
            return Some(Observation {
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
            generation,
            observed_at: Utc::now(),
            failure: Some(failure),
        })
    }
}
