//! Trust is checked only after russh verifies the KEX proof, before user auth.

use api_contracts::generated::types::runners::ssh::{
    PinRequestObservedHostKey, PinRequestObservedHostKeyAlgorithm as ObservedAlgorithm,
    ResolveResponseResolvedLearnedHostKey,
    ResolveResponseResolvedLearnedHostKeyAlgorithm as PinnedAlgorithm,
};
use russh::{
    Channel, ChannelId,
    client::{self, ChannelOpenHandle},
    keys::{Algorithm, EcdsaCurve, HashAlg, PublicKeyOrCertificate},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use super::super::{
    FailureReason, Scope,
    authority::{Authority, PreparedCredential},
    keys,
};
use crate::ids::RunId;

pub(in crate::ssh) struct HostTrust {
    authority: Arc<Authority>,
    run: RunId,
    connection: uuid::Uuid,
    credential: Arc<PreparedCredential>,
    scope: Scope,
    pub(super) failure: Arc<Mutex<Option<FailureReason>>>,
    pub(super) authority_pending: Arc<AtomicBool>,
}

impl HostTrust {
    pub(super) fn new(
        authority: Arc<Authority>,
        run: RunId,
        connection: uuid::Uuid,
        credential: Arc<PreparedCredential>,
        scope: Scope,
    ) -> Self {
        Self {
            authority,
            run,
            connection,
            credential,
            scope,
            failure: Arc::new(Mutex::new(None)),
            authority_pending: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn verify(&self, peer: &PublicKeyOrCertificate) -> Result<(), FailureReason> {
        self.scope.check()?;
        let PublicKeyOrCertificate::PublicKey { key, .. } = peer else {
            return Err(FailureReason::UnsupportedHostKey);
        };
        keys::validate_public(key).map_err(|_| FailureReason::UnsupportedHostKey)?;
        let (observed_algorithm, pinned_algorithm) = match key.algorithm() {
            Algorithm::Ed25519 => (ObservedAlgorithm::SshEd25519, PinnedAlgorithm::SshEd25519),
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            } => (
                ObservedAlgorithm::EcdsaSha2Nistp256,
                PinnedAlgorithm::EcdsaSha2Nistp256,
            ),
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP384,
            } => (
                ObservedAlgorithm::EcdsaSha2Nistp384,
                PinnedAlgorithm::EcdsaSha2Nistp384,
            ),
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP521,
            } => (
                ObservedAlgorithm::EcdsaSha2Nistp521,
                PinnedAlgorithm::EcdsaSha2Nistp521,
            ),
            Algorithm::Rsa { .. } => (ObservedAlgorithm::SshRsa, PinnedAlgorithm::SshRsa),
            _ => return Err(FailureReason::UnsupportedHostKey),
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let generation = {
            let trust = self
                .credential
                .trust
                .lock()
                .map_err(|_| FailureReason::Protocol)?;
            if let Some(pin) = &trust.pin {
                if pin.algorithm != pinned_algorithm || pin.fingerprint != fingerprint {
                    return Err(FailureReason::HostKeyMismatch);
                }
                return Ok(());
            }
            trust.generation
        };
        // Retain this phase on failure so an outer deadline cannot blame the
        // SSH target for time spent waiting for our first-use authority API.
        self.authority_pending.store(true, Ordering::Release);
        self.scope
            .wait(self.authority.pin(
                self.run,
                self.connection,
                generation,
                PinRequestObservedHostKey {
                    algorithm: observed_algorithm,
                    fingerprint: fingerprint.clone(),
                },
            ))
            .await??;
        self.scope.check()?;
        let mut trust = self
            .credential
            .trust
            .lock()
            .map_err(|_| FailureReason::Protocol)?;
        if trust
            .pin
            .as_ref()
            .is_some_and(|pin| pin.algorithm != pinned_algorithm || pin.fingerprint != fingerprint)
        {
            return Err(FailureReason::HostKeyMismatch);
        }
        trust.generation = generation + 1;
        trust.pin = Some(ResolveResponseResolvedLearnedHostKey {
            algorithm: pinned_algorithm,
            fingerprint,
        });
        self.authority_pending.store(false, Ordering::Release);
        Ok(())
    }
}

impl client::Handler for HostTrust {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        match self.verify(key).await {
            Ok(()) => Ok(true),
            Err(failure) => {
                *self
                    .failure
                    .lock()
                    .map_err(|_| russh::Error::Inconsistent)? = Some(failure);
                Ok(false)
            }
        }
    }

    // The library defaults accept several unsolicited server channels. This
    // one-shot client never requests forwarding; dropping replies rejects them.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        _channel: Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: Channel<client::Msg>,
        _socket_path: &str,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_agent_forward(
        &mut self,
        _channel: Channel<client::Msg>,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_session(
        &mut self,
        _channel: Channel<client::Msg>,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: Channel<client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: Channel<client::Msg>,
        _socket_path: &str,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_x11(
        &mut self,
        _channel: Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn should_accept_unknown_server_channel(
        &mut self,
        _id: ChannelId,
        _channel_type: &str,
    ) -> bool {
        false
    }
}
