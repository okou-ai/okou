//! Run-owned VNC sessions. Guest requests carry saved IDs, never authority.

mod authority;
mod network;
mod operations;
mod protocol;
mod scope;
mod sessions;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{http::HttpClient, ids::RunId, runner_process_identity::RunnerProcessIdentity};
use authority::Authority;
use network::{Network, PublicNetwork};
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
            Error::DeadlineExceeded => Self::TimedOut,
            Error::InvalidPassword | Error::InvalidTrustRoots | Error::InvalidServerName => {
                Self::InvalidCredential
            }
            Error::AuthenticationFailed | Error::Tls(_) => Self::AuthenticationFailed,
            Error::UnsupportedSecurity | Error::UnsupportedRfbVersion => Self::UnsupportedProfile,
            Error::ResourceLimit | Error::ImageTooLarge => Self::ResourceExhausted,
            _ => Self::Protocol,
        }
    }
}

pub(crate) struct VncRuntime {
    authority: Authority,
    network: Arc<dyn Network>,
    capacity: Arc<Semaphore>,
}

impl VncRuntime {
    pub(crate) fn official(
        http: HttpClient,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> Result<Option<Arc<Self>>, crate::error::RunnerError> {
        use api_contracts::generated::constants::runners::OFFICIAL_RUNNER_TOKEN_PREFIX;
        if !token.starts_with(OFFICIAL_RUNNER_TOKEN_PREFIX) {
            return Ok(None);
        }
        // The prefix chooses transport only; the API authenticates every call.
        let authority = Authority::new(http, token.to_owned(), identity).map_err(|_| {
            crate::error::RunnerError::Internal("VNC authority client initialization failed".into())
        })?;
        Ok(Some(Arc::new(Self {
            authority,
            network: Arc::new(PublicNetwork),
            capacity: Arc::new(Semaphore::new(4)),
        })))
    }

    pub(crate) fn for_run(self: &Arc<Self>, run: RunId, cancel: &CancellationToken) -> Arc<Run> {
        Arc::new(Run::new(Arc::clone(self), run, cancel.child_token()))
    }
}
