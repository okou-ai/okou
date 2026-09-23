//! Run-owned VNC sessions. Guest requests carry saved IDs, never authority.

mod authority;
mod network;
mod operations;
mod protocol;
mod scope;
mod sessions;
#[cfg(test)]
pub(crate) mod tests;

use runner_types::ids::RunId;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{RemoteApiRequestFactory, RemoteInitError};
use authority::Authority;
use network::{Network, PublicNetwork};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use scope::Scope;
pub(crate) use sessions::Run;

/// Only these bounded categories may cross the guest boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Failure {
    Unavailable,
    #[serde(rename = "authority_failure")]
    Authority,
    ConfigurationChanged,
    UnsupportedProfile,
    InvalidCredential,
    UnsafeDestination,
    #[serde(rename = "network_failure")]
    Network,
    Protocol,
    TimedOut,
    Cancelled,
    ResourceExhausted,
    SessionNotFound,
    InvalidInput,
    StaleGeometry,
    Disconnected,
    AuthenticationFailed,
}

impl From<rfb_client::Error> for Failure {
    fn from(error: rfb_client::Error) -> Self {
        use rfb_client::Error;
        match error {
            Error::InvalidInput => Self::InvalidInput,
            Error::StaleGeometry => Self::StaleGeometry,
            Error::SessionClosed | Error::Io(_) => Self::Disconnected,
            Error::AuthenticationDeadlineExceeded { .. } | Error::DeadlineExceeded => {
                Self::TimedOut
            }
            Error::InvalidPassword
            | Error::InvalidPlainUsername
            | Error::InvalidPlainPassword
            | Error::InvalidAppleDhUsername
            | Error::InvalidAppleDhPassword
            | Error::InvalidTrustRoots
            | Error::InvalidServerName => Self::InvalidCredential,
            Error::AuthenticationFailed | Error::Tls(_) => Self::AuthenticationFailed,
            Error::UnsupportedSecurity | Error::UnsupportedRfbVersion => Self::UnsupportedProfile,
            Error::ResourceLimit | Error::ImageTooLarge => Self::ResourceExhausted,
            _ => Self::Protocol,
        }
    }
}

impl From<crate::ssh::FailureReason> for Failure {
    fn from(error: crate::ssh::FailureReason) -> Self {
        use crate::ssh::FailureReason;
        match error {
            FailureReason::Unavailable => Self::Unavailable,
            FailureReason::AuthorityFailure => Self::Authority,
            FailureReason::InvalidCredential
            | FailureReason::UnsupportedCredential
            | FailureReason::HostKeyMismatch
            | FailureReason::UnsupportedHostKey => Self::InvalidCredential,
            FailureReason::CredentialResourceLimit | FailureReason::ResourceExhausted => {
                Self::ResourceExhausted
            }
            FailureReason::UnsafeDestination => Self::UnsafeDestination,
            FailureReason::NetworkFailure
            | FailureReason::Disconnected
            | FailureReason::Transport => Self::Network,
            FailureReason::ConfigurationChanged => Self::ConfigurationChanged,
            FailureReason::AuthenticationFailed => Self::AuthenticationFailed,
            FailureReason::Protocol | FailureReason::ExecRejected => Self::Protocol,
            FailureReason::TimedOut => Self::TimedOut,
            FailureReason::Cancelled => Self::Cancelled,
        }
    }
}

pub struct VncRuntime {
    authority: Authority,
    network: Arc<dyn Network>,
    capacity: Arc<Semaphore>,
}

impl VncRuntime {
    pub fn official(
        http: impl RemoteApiRequestFactory + 'static,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> Result<Option<Arc<Self>>, RemoteInitError> {
        use api_contracts::generated::constants::runners::OFFICIAL_RUNNER_TOKEN_PREFIX;
        if !token.starts_with(OFFICIAL_RUNNER_TOKEN_PREFIX) {
            return Ok(None);
        }
        // The prefix chooses transport only; the API authenticates every call.
        let authority = Authority::new(Arc::new(http), token.to_owned(), identity)
            .map_err(|_| RemoteInitError::VncAuthority)?;
        Ok(Some(Arc::new(Self {
            authority,
            network: Arc::new(PublicNetwork),
            capacity: Arc::new(Semaphore::new(4)),
        })))
    }

    pub(crate) fn for_run(
        self: &Arc<Self>,
        run: RunId,
        cancel: &CancellationToken,
        ssh: Option<Arc<crate::ssh::Run>>,
    ) -> Arc<Run> {
        Arc::new(Run::new(Arc::clone(self), run, cancel.child_token(), ssh))
    }
}
