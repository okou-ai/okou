//! Bounded connection evidence; never session operations or raw protocol causes.
use api_contracts::generated::types::runners::vnc::ObservationRequestFailureReason;
use chrono::{DateTime, Utc};

use super::{Failure, authority::Transport, kerberos::Binding};

pub(super) struct Attempt {
    pub(super) generation: i64,
    pub(super) transport: Transport,
    pub(super) kerberos: Option<Binding>,
    pub(super) authenticated_at: Option<DateTime<Utc>>,
}

pub(super) struct Observation {
    pub(super) attempt: Attempt,
    pub(super) observed_at: DateTime<Utc>,
    pub(super) failure: Option<ObservationRequestFailureReason>,
}

impl Attempt {
    pub(super) fn finish(self, failure: Option<Failure>) -> Option<Observation> {
        if let Some(observed_at) = self.authenticated_at {
            return Some(Observation {
                attempt: self,
                observed_at,
                failure: None,
            });
        }
        use ObservationRequestFailureReason as Reason;
        let failure = match failure? {
            Failure::InvalidCredential => Reason::InvalidCredential,
            Failure::UnsafeDestination => Reason::UnsafeDestination,
            Failure::Network => Reason::NetworkFailure,
            Failure::Protocol => Reason::Protocol,
            Failure::TimedOut => Reason::TimedOut,
            Failure::Disconnected => Reason::Disconnected,
            Failure::AuthenticationFailed => Reason::AuthenticationFailed,
            Failure::UnsupportedProfile => Reason::UnsupportedProfile,
            Failure::KerberosExpired => Reason::KerberosExpired,
            Failure::KerberosNonRenewable => Reason::KerberosNonRenewable,
            Failure::KerberosRenewalExhausted => Reason::KerberosRenewalExhausted,
            _ => return None,
        };
        Some(Observation {
            attempt: self,
            observed_at: Utc::now(),
            failure: Some(failure),
        })
    }
}
