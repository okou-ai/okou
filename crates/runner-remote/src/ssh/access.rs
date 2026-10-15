//! Adapt SSH authority and diagnostics to the shared Cloudflare carrier.

use api_contracts::generated::types::runners::ssh::{
    ObservationRequestFailureReason as Reason, ResolveResponseResolvedAccessAccess,
};
use std::sync::Arc;

use super::{FailureReason, io::SshSocket, observation::Attempt};
use crate::cloudflare::{self, Configuration, Failure};

pub(super) fn validate(
    host: &str,
    port: u64,
    access: &ResolveResponseResolvedAccessAccess,
) -> Result<(), FailureReason> {
    if uuid::Uuid::parse_str(&access.config_id).is_err()
        || !(1..=i64::from(i32::MAX)).contains(&access.generation)
        || Configuration::new(
            host,
            port,
            access.client_id.expose(),
            access.client_secret.expose(),
        )
        .is_none()
    {
        return Err(FailureReason::AuthorityFailure);
    }
    Ok(())
}

pub(super) async fn connect(
    stream: SshSocket,
    host: &str,
    access: &ResolveResponseResolvedAccessAccess,
    tls: Arc<rustls::ClientConfig>,
    attempt: &mut Attempt,
) -> Result<impl cloudflare::ByteIo + use<>, Reason> {
    let configuration = Configuration::new(
        host,
        443,
        access.client_id.expose(),
        access.client_secret.expose(),
    )
    .ok_or(Reason::AccessProtocolFailure)?;
    let (stream, failed) = cloudflare::connect(stream, configuration, tls, &attempt.trace)
        .await
        .map_err(|failure| match failure {
            Failure::Tls => Reason::AccessTlsFailure,
            Failure::Protocol => Reason::AccessProtocolFailure,
            Failure::Rejected => Reason::AccessRejected,
            Failure::Network => Reason::NetworkFailure,
        })?;
    attempt.access_protocol_failed = Some(failed);
    Ok(stream)
}
