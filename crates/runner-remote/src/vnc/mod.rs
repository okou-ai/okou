//! Run-owned VNC sessions. Guest requests carry saved IDs, never authority.

mod authority;
mod diagnostics;
mod invalidation;
mod kerberos;
mod network;
mod observation;
mod operations;
mod protocol;
mod scope;
mod sessions;
#[cfg(test)]
pub(crate) mod tests;

use runner_types::ids::RunId;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::RemoteInitError;
use authority::Authority;
use network::{Network, PublicNetwork};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::HttpClient;
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
    DeliveryUnknown,
    KerberosExpired,
    KerberosNonRenewable,
    KerberosRenewalExhausted,
}

impl From<rfb_client::Error> for Failure {
    fn from(error: rfb_client::Error) -> Self {
        use rfb_client::Error;
        match error {
            Error::Kerberos(error) => match error {
                kerberos_worker::Error::DeliveryUnknown => Self::DeliveryUnknown,
                kerberos_worker::Error::Authority => Self::Authority,
                kerberos_worker::Error::Unavailable | kerberos_worker::Error::CleanupUnknown => {
                    Self::Unavailable
                }
                kerberos_worker::Error::Invalid | kerberos_worker::Error::IdentityMismatch => {
                    Self::InvalidCredential
                }
                kerberos_worker::Error::CredentialRejected => Self::AuthenticationFailed,
                kerberos_worker::Error::KdcUnavailable => Self::Network,
                kerberos_worker::Error::Expired => Self::KerberosExpired,
                kerberos_worker::Error::NonRenewable => Self::KerberosNonRenewable,
                kerberos_worker::Error::RenewalExhausted => Self::KerberosRenewalExhausted,
                kerberos_worker::Error::Deadline => Self::TimedOut,
                kerberos_worker::Error::Capacity => Self::ResourceExhausted,
                kerberos_worker::Error::Protocol => Self::Protocol,
            },
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
            | Error::InvalidAppleSrpUsername
            | Error::InvalidAppleSrpPassword
            | Error::InvalidAppleRsaSrpUsername
            | Error::InvalidAppleRsaSrpPassword
            | Error::InvalidRsaAesCredential
            | Error::InvalidTrustRoots
            | Error::InvalidServerName => Self::InvalidCredential,
            Error::AuthenticationFailed | Error::RsaServerKeyMismatch | Error::Tls(_) => {
                Self::AuthenticationFailed
            }
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
    runs: Mutex<HashMap<RunId, Weak<Run>>>,
    reports: Arc<Semaphore>,
}

impl VncRuntime {
    pub fn official(
        http: HttpClient,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> Result<Option<Arc<Self>>, RemoteInitError> {
        use api_contracts::generated::constants::runners::OFFICIAL_RUNNER_TOKEN_PREFIX;
        if !token.starts_with(OFFICIAL_RUNNER_TOKEN_PREFIX) {
            return Ok(None);
        }
        // The prefix chooses transport only; the API authenticates every call.
        let authority = Authority::new(http, token.to_owned(), identity)
            .map_err(|_| RemoteInitError::VncAuthority)?;
        Ok(Some(Arc::new(Self {
            authority,
            network: Arc::new(PublicNetwork),
            capacity: Arc::new(Semaphore::new(4)),
            runs: Mutex::new(HashMap::new()),
            reports: Arc::new(Semaphore::new(4)),
        })))
    }

    pub(crate) fn for_run(
        self: &Arc<Self>,
        run: RunId,
        cancel: &CancellationToken,
        ssh: Option<Arc<crate::ssh::Run>>,
    ) -> Arc<Run> {
        let owner = Arc::new(Run::new(Arc::clone(self), run, cancel.child_token(), ssh));
        let previous = self
            .runs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(run, Arc::downgrade(&owner))
            .and_then(|previous| previous.upgrade());
        if let Some(previous) = previous {
            previous.close();
        }
        owner
    }
}

impl runner_provider::AblySideMessageHandler for VncRuntime {
    fn handle(&self, message: &ably_subscriber::Message) -> bool {
        use api_contracts::generated::types::runners::{ssh, vnc};
        let ssh = match message.name.as_deref() {
            Some("vnc-authority-invalidated") => false,
            Some("ssh-authority-invalidated") => true,
            _ => return false,
        };
        // Generated response DTOs ignore unknown fields and default a missing
        // Option to None. Match the strict event schema before decoding so only
        // an explicit null in a valid notification can select every connection.
        if !message.data.as_object().is_some_and(|data| {
            data.len() == 2 && data.contains_key("runId") && data.contains_key("connectionId")
        }) {
            return true;
        }
        let notification = if ssh {
            serde_json::from_value::<ssh::InvalidateNotification>(message.data.clone())
                .map(|value| (value.run_id, value.connection_id))
        } else {
            serde_json::from_value::<vnc::InvalidateNotification>(message.data.clone())
                .map(|value| (value.run_id, value.connection_id))
        };
        let Ok((run, connection)) = notification else {
            return true;
        };
        let Ok(run) = run.parse::<RunId>() else {
            return true;
        };
        let connection = match connection {
            Some(value) => match value.parse::<uuid::Uuid>() {
                Ok(connection) => Some(connection),
                Err(_) => return true,
            },
            None => None,
        };
        let owner = self
            .runs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&run)
            .and_then(Weak::upgrade);
        if let Some(owner) = owner {
            owner.invalidate(connection, ssh);
        }
        true
    }
}
