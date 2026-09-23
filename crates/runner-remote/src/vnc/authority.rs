//! Private VNC authority, with bounded secret ownership and no response diagnostics.

use api_contracts::generated::{
    routes::runners::runs::by_run_id::vnc as routes, types::runners::vnc::*,
};
use base64::Engine;
use rfb_client::{PlainCredentials, TrustRoots, VncPassword, X509Authentication};
use rustls::pki_types::CertificateDer;
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::Failure;
use runner_types::ids::RunId;

use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::HttpClient;

const MAX_API_BYTES: usize = 512 * 1024;
const MAX_CA_BYTES: usize = 64 * 1024;
const MAX_CA_CERTIFICATES: usize = 8;
const MAX_PLAIN_USERNAME_BYTES: usize = 255;

pub(super) struct Authority {
    http: HttpClient,
    transport: reqwest::Client,
    token: Zeroizing<String>,
    identity: RunnerProcessIdentity,
}

/// Consumed by one handshake; never cached, cloned or exposed to the guest.
pub(super) struct Credential {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) generation: i64,
    pub(super) server_name: String,
    pub(super) transport: Transport,
    pub(super) authentication: X509Authentication,
    pub(super) roots: TrustRoots,
}

#[derive(Clone, Copy)]
pub(super) enum Transport {
    Direct,
    Ssh { connection: Uuid, generation: i64 },
}

impl Authority {
    pub(super) fn new(
        http: HttpClient,
        token: String,
        identity: RunnerProcessIdentity,
    ) -> Result<Self, Failure> {
        let token = Zeroizing::new(token);
        let transport = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| Failure::Authority)?;
        Ok(Self {
            http,
            transport,
            token,
            identity,
        })
    }

    async fn call<T: DeserializeOwned>(
        &self,
        route: api_contracts::ResolvedRoute,
        body: &impl Serialize,
    ) -> Result<T, Failure> {
        let body = serde_json::to_value(body).map_err(|_| Failure::Authority)?;
        let request = self
            .http
            .json_request(route, &self.token, &body)
            .map_err(|_| Failure::Authority)?;
        let mut response = self
            .transport
            .execute(request)
            .await
            .map_err(|_| Failure::Authority)?;
        if response.status() != reqwest::StatusCode::OK
            || response
                .content_length()
                .is_some_and(|length| length > MAX_API_BYTES as u64)
        {
            return Err(Failure::Authority);
        }
        // A fixed capacity avoids leaving reallocated plaintext buffers behind.
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_API_BYTES));
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Authority)? {
            if chunk.len() > MAX_API_BYTES - bytes.len() {
                return Err(Failure::Authority);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Failure::Authority)
    }

    pub(super) async fn resolve(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        supports_ssh: bool,
    ) -> Result<Credential, Failure> {
        let mut supported_profiles = vec![
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Direct),
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::UsernamePassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Plain,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Direct),
            },
        ];
        if supports_ssh {
            supported_profiles.extend([
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                    transport_type: Some(ResolveRequestSupportedProfileTransportType::Ssh),
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::UsernamePassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509Plain,
                    transport_type: Some(ResolveRequestSupportedProfileTransportType::Ssh),
                },
            ]);
        }
        let request = ResolveRequest {
            connection_id: connection.to_string(),
            runner_identity: ResolveRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            supported_profiles,
        };
        let response = self
            .call(
                routes::resolve::route(routes::resolve::Params {
                    run_id: &run.to_string(),
                }),
                &request,
            )
            .await?;
        let (host, port, generation, server_name, transport, authentication, security) =
            match response {
                ResolveResponse::Unavailable => return Err(Failure::Unavailable),
                ResolveResponse::UnsupportedProfile => return Err(Failure::UnsupportedProfile),
                ResolveResponse::Resolved { .. } => return Err(Failure::Authority),
                ResolveResponse::ResolvedTransport {
                    host,
                    port,
                    generation,
                    server_name,
                    transport,
                    authentication,
                    security,
                } => (
                    host,
                    port,
                    generation,
                    server_name,
                    transport,
                    authentication,
                    security,
                ),
            };
        let port = u16::try_from(port).map_err(|_| Failure::Authority)?;
        if port == 0 || !(1..=i64::from(i32::MAX)).contains(&generation) {
            return Err(Failure::Authority);
        }
        super::network::validate_host(&host)?;
        let transport = match transport {
            ResolveResponseResolvedTransportTransport::Direct => Transport::Direct,
            ResolveResponseResolvedTransportTransport::Ssh {
                connection_id,
                generation,
            } => {
                if !supports_ssh || !(1..=i64::from(i32::MAX)).contains(&generation) {
                    return Err(Failure::Authority);
                }
                Transport::Ssh {
                    connection: connection_id.parse().map_err(|_| Failure::Authority)?,
                    generation,
                }
            }
        };
        let (authentication, trust) = match (authentication, security) {
            (
                ResolveResponseResolvedAuthentication::VncPassword { password },
                ResolveResponseResolvedSecurity::X509Vnc { trust },
            ) => {
                let password = VncPassword::new_zeroizing(password.into_zeroizing())
                    .map_err(|_| Failure::InvalidCredential)?;
                (X509Authentication::VncPassword(password), trust)
            }
            (
                ResolveResponseResolvedAuthentication::UsernamePassword { username, password },
                ResolveResponseResolvedSecurity::X509Plain { trust },
            ) => {
                if !(1..=MAX_PLAIN_USERNAME_BYTES).contains(&username.len())
                    || username.as_bytes().contains(&0)
                {
                    return Err(Failure::InvalidCredential);
                }
                let credentials =
                    PlainCredentials::new_zeroizing(username, password.into_zeroizing())
                        .map_err(|_| Failure::InvalidCredential)?;
                (X509Authentication::Plain(credentials), trust)
            }
            _ => return Err(Failure::Authority),
        };
        let roots = match trust {
            ResolveResponseResolvedSecurityX509VncTrust::System => TrustRoots::public_roots(),
            ResolveResponseResolvedSecurityX509VncTrust::CustomCa { ca_bundle } => {
                custom_roots(Zeroizing::new(ca_bundle))?
            }
        };
        Ok(Credential {
            host,
            port,
            generation,
            server_name,
            transport,
            authentication,
            roots,
        })
    }

    pub(super) async fn check(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        generation: i64,
        transport: Transport,
    ) -> Result<(), Failure> {
        let expected_transport = Some(match transport {
            Transport::Direct => CheckRequestExpectedTransport::Direct,
            Transport::Ssh {
                connection,
                generation,
            } => CheckRequestExpectedTransport::Ssh {
                connection_id: connection.to_string(),
                generation,
            },
        });
        let request = CheckRequest {
            connection_id: connection.to_string(),
            runner_identity: CheckRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            expected_generation: generation,
            expected_transport,
        };
        match self
            .call(
                routes::check::route(routes::check::Params {
                    run_id: &run.to_string(),
                }),
                &request,
            )
            .await?
        {
            CheckResponse::Valid => Ok(()),
            CheckResponse::Unavailable => Err(Failure::Unavailable),
            CheckResponse::ConfigurationChanged => Err(Failure::ConfigurationChanged),
        }
    }
}

/// Accept only bounded certificate blocks, never silently skip keys or junk.
/// DER parsing and trust-anchor validation stay in the TLS library.
fn custom_roots(bundle: Zeroizing<String>) -> Result<TrustRoots, Failure> {
    if bundle.len() > MAX_CA_BYTES || !bundle.is_ascii() {
        return Err(Failure::InvalidCredential);
    }
    let mut certificates = Vec::new();
    let mut remaining = bundle.trim_ascii();
    while !remaining.is_empty() {
        if certificates.len() == MAX_CA_CERTIFICATES {
            return Err(Failure::InvalidCredential);
        }
        let body = remaining
            .strip_prefix("-----BEGIN CERTIFICATE-----")
            .ok_or(Failure::InvalidCredential)?;
        let (encoded, rest) = body
            .split_once("-----END CERTIFICATE-----")
            .ok_or(Failure::InvalidCredential)?;
        let encoded: String = encoded
            .trim_ascii()
            .chars()
            .filter(|&character| character != '\r' && character != '\n')
            .collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| Failure::InvalidCredential)?;
        certificates.push(CertificateDer::from(der));
        remaining = rest.trim_ascii();
    }
    TrustRoots::custom(certificates).map_err(|_| Failure::InvalidCredential)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_trust_requires_only_bounded_complete_certificate_blocks() {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let certificate = params.self_signed(&key).unwrap();
        let certificate = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            base64::engine::general_purpose::STANDARD.encode(certificate.der())
        );
        for valid in [certificate.clone(), certificate.repeat(8)] {
            assert!(custom_roots(Zeroizing::new(valid)).is_ok());
        }
        for invalid in [
            String::new(),
            " \n\t".into(),
            "x".repeat(MAX_CA_BYTES + 1),
            "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----".into(),
            certificate.replace("CERTIFICATE", "PRIVATE KEY"),
            certificate.replace("-----END CERTIFICATE-----", ""),
            format!("junk\n{certificate}"),
            format!("{certificate}junk"),
            format!("{certificate}\u{200b}"),
            certificate.repeat(9),
        ] {
            assert!(matches!(
                custom_roots(Zeroizing::new(invalid)),
                Err(Failure::InvalidCredential)
            ));
        }
    }
}
