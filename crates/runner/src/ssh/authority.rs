//! Private current-authority API calls, with bounded response ownership and no body diagnostics.

use api_contracts::generated::{
    routes::runners::runs::by_run_id::ssh as routes, types::runners::ssh::*,
};
use serde::{Serialize, de::DeserializeOwned};
use std::sync::Mutex;
use zeroize::Zeroizing;

use super::{FailureReason, keys::SigningKey};
use crate::{http::HttpClient, ids::RunId, runner_process_identity::RunnerProcessIdentity};

const MAX_API_BYTES: usize = 512 * 1024;

pub(super) struct Authority {
    http: HttpClient,
    transport: reqwest::Client,
    token: Zeroizing<String>,
    identity: RunnerProcessIdentity,
}

pub(super) struct Credential {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) username: String,
    pub(super) generation: i64,
    pub(super) pin: Option<ResolveResponseResolvedLearnedHostKey>,
    pub(super) auth: CredentialAuth,
    pub(super) transport: Transport,
}

pub(super) enum Transport {
    Direct,
    CloudflareAccess(ResolveResponseResolvedAccessAccess),
}

impl Transport {
    pub(super) fn same_authority(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Direct, Self::Direct) => true,
            (Self::CloudflareAccess(a), Self::CloudflareAccess(b)) => {
                a.config_id == b.config_id && a.generation == b.generation
            }
            _ => false,
        }
    }
}

pub(super) enum CredentialAuth {
    PrivateKey {
        private_key: api_contracts::SecretText<65536>,
        passphrase: Option<api_contracts::SecretText<4096>>,
    },
    Password(api_contracts::SecretText<4096>),
}

pub(super) struct PreparedCredential {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) username: String,
    pub(super) trust: Mutex<Trust>,
    pub(super) auth: PreparedAuth,
    pub(super) transport: Transport,
}

pub(super) enum PreparedAuth {
    PrivateKey(SigningKey),
    Password(api_contracts::SecretText<4096>),
}

pub(super) struct Trust {
    pub(super) generation: i64,
    pub(super) pin: Option<ResolveResponseResolvedLearnedHostKey>,
}

impl Authority {
    pub(super) async fn observe(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        observation: super::observation::Observation,
    ) {
        let body = ObservationRequest {
            connection_id: connection.to_string(),
            runner_identity: ObservationRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            expected_generation: observation.generation,
            observed_at: observation
                .observed_at
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            failure_reason: observation.failure,
        };
        let report = async {
            let request = self
                .http
                .request_resolved_route(
                    routes::observations::route(routes::observations::Params {
                        run_id: &run.to_string(),
                    }),
                    &self.token,
                )
                .json(&body)
                .build()
                .ok()?;
            let response = self.transport.execute(request).await.ok()?;
            response.status().is_success().then_some(())
        };
        if !tokio::time::timeout(std::time::Duration::from_secs(1), report)
            .await
            .is_ok_and(|result| result.is_some())
        {
            // No raw response/error, credentials, command or output at this boundary.
            tracing::info!(run_id = %run, connection_id = %connection, "SSH observation report not confirmed");
        }
    }

    pub(super) fn new(
        http: HttpClient,
        token: String,
        identity: RunnerProcessIdentity,
    ) -> Result<Self, FailureReason> {
        let transport = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| FailureReason::AuthorityFailure)?;
        Ok(Self {
            http,
            transport,
            token: Zeroizing::new(token),
            identity,
        })
    }

    async fn call<T: DeserializeOwned>(
        &self,
        route: api_contracts::ResolvedRoute,
        body: &impl Serialize,
    ) -> Result<T, FailureReason> {
        let request = self
            .http
            .request_resolved_route(route, &self.token)
            .json(body)
            .build()
            .map_err(|_| FailureReason::AuthorityFailure)?;
        let mut response = self
            .transport
            .execute(request)
            .await
            .map_err(|_| FailureReason::AuthorityFailure)?;
        if response.status() != reqwest::StatusCode::OK
            || response
                .content_length()
                .is_some_and(|len| len > MAX_API_BYTES as u64)
        {
            return Err(FailureReason::AuthorityFailure);
        }
        // Fixed capacity avoids leaving reallocated plaintext response buffers behind.
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_API_BYTES));
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| FailureReason::AuthorityFailure)?
        {
            if chunk.len() > MAX_API_BYTES - bytes.len() {
                return Err(FailureReason::AuthorityFailure);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| FailureReason::AuthorityFailure)
    }

    pub(super) async fn resolve(
        &self,
        run: RunId,
        connection: uuid::Uuid,
    ) -> Result<Credential, FailureReason> {
        let body = ResolveRequest {
            connection_id: connection.to_string(),
            runner_identity: ResolveRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
        };
        let response = self
            .call(
                routes::resolve::route(routes::resolve::Params {
                    run_id: &run.to_string(),
                }),
                &body,
            )
            .await?;
        let (host, port, username, generation, learned_host_key, auth, transport) = match response {
            ResolveResponse::Unavailable => return Err(FailureReason::Unavailable),
            ResolveResponse::ResolvedAccess {
                host,
                port,
                username,
                generation,
                learned_host_key,
                authentication,
                access,
            } => {
                super::access::validate(&host, port, &access)?;
                let auth = match authentication {
                    ResolveResponseResolvedAccessAuthentication::PrivateKey {
                        private_key,
                        passphrase,
                    } => CredentialAuth::PrivateKey {
                        private_key,
                        passphrase,
                    },
                    ResolveResponseResolvedAccessAuthentication::Password { password } => {
                        CredentialAuth::Password(password)
                    }
                };
                (
                    host,
                    port,
                    username,
                    generation,
                    learned_host_key,
                    auth,
                    Transport::CloudflareAccess(access),
                )
            }
            ResolveResponse::Resolved {
                host,
                port,
                username,
                generation,
                learned_host_key,
                private_key,
                passphrase,
            } => (
                host,
                port,
                username,
                generation,
                learned_host_key,
                CredentialAuth::PrivateKey {
                    private_key,
                    passphrase,
                },
                Transport::Direct,
            ),
            ResolveResponse::ResolvedPassword {
                host,
                port,
                username,
                generation,
                learned_host_key,
                password,
            } => (
                host,
                port,
                username,
                generation,
                learned_host_key,
                CredentialAuth::Password(password),
                Transport::Direct,
            ),
        };
        let port = u16::try_from(port).map_err(|_| FailureReason::AuthorityFailure)?;
        if port == 0
            || host.is_empty()
            || host.len() > 253
            || username.is_empty()
            || username.encode_utf16().count() > 255
            || !(1..=i64::from(i32::MAX)).contains(&generation)
            || learned_host_key
                .as_ref()
                .is_some_and(|pin| !valid_fingerprint(&pin.fingerprint))
        {
            return Err(FailureReason::AuthorityFailure);
        }
        Ok(Credential {
            host,
            port,
            username,
            generation,
            pin: learned_host_key,
            auth,
            transport,
        })
    }

    pub(super) async fn pin(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        generation: i64,
        observed: PinRequestObservedHostKey,
    ) -> Result<(), FailureReason> {
        let body = PinRequest {
            connection_id: connection.to_string(),
            runner_identity: PinRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            expected_generation: generation,
            observed_host_key: observed,
        };
        let result = self
            .call(
                routes::pin::route(routes::pin::Params {
                    run_id: &run.to_string(),
                }),
                &body,
            )
            .await?;
        match result {
            PinResponse::Pinned { generation: actual }
            | PinResponse::Matched { generation: actual }
                if actual == generation + 1 =>
            {
                Ok(())
            }
            PinResponse::HostKeyMismatch => Err(FailureReason::HostKeyMismatch),
            PinResponse::ConfigurationChanged => Err(FailureReason::ConfigurationChanged),
            PinResponse::Unavailable => Err(FailureReason::Unavailable),
            _ => Err(FailureReason::AuthorityFailure),
        }
    }
}

fn valid_fingerprint(value: &str) -> bool {
    use base64::Engine;
    let Some(digest) = value.strip_prefix("SHA256:") else {
        return false;
    };
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(digest)
        .is_ok_and(|bytes| bytes.len() == 32)
}
