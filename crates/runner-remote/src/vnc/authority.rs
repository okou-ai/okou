//! Private VNC authority, with bounded secret ownership and no response diagnostics.

use api_contracts::generated::{
    routes::runners::runs::by_run_id::vnc as routes, types::runners::vnc::*,
};
use base64::Engine;
use rfb_client::{
    AppleDhCredentials, AppleRsaSrpCredentials, AppleSrpCredentials,
    ClientCertificateAuthentication, ClientIdentity, PlainCredentials, QemuScramCredentials,
    RsaAesCredentials, RsaAesSecurity, RsaServerKeyPin, TrustRoots, VncPassword,
    X509Authentication,
};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
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

fn client_identity(
    certificate_chain_der: Vec<String>,
    private_key_pkcs8_der: api_contracts::SecretUtf8Text<24576>,
) -> Result<ClientIdentity, Failure> {
    if !(1..=8).contains(&certificate_chain_der.len()) {
        return Err(Failure::InvalidCredential);
    }
    let mut total = 0usize;
    let mut certificates = Vec::with_capacity(certificate_chain_der.len());
    for encoded in certificate_chain_der {
        if encoded.len() > 88_000 {
            return Err(Failure::InvalidCredential);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| Failure::InvalidCredential)?;
        total += bytes.len();
        if total > 64 * 1024 {
            return Err(Failure::InvalidCredential);
        }
        certificates.push(CertificateDer::from(bytes));
    }
    let encoded = private_key_pkcs8_der.into_zeroizing();
    let mut bytes = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| Failure::InvalidCredential)?,
    );
    if !(1..=16 * 1024).contains(&bytes.len()) {
        return Err(Failure::InvalidCredential);
    }
    let key = PrivatePkcs8KeyDer::from(std::mem::take(&mut *bytes));
    ClientIdentity::from_pkcs8_der(certificates, key).map_err(|_| Failure::InvalidCredential)
}

pub(super) struct Authority {
    pub(super) http: HttpClient,
    transport: reqwest::Client,
    token: Zeroizing<String>,
    identity: RunnerProcessIdentity,
}

/// Consumed by one handshake; never cached, cloned or exposed to the guest.
pub(super) struct Credential {
    pub(super) created_at: chrono::DateTime<chrono::Utc>,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) generation: i64,
    pub(super) transport: Transport,
    pub(super) native: Option<super::native::Configuration>,
    pub(super) authentication: Authentication,
}

enum X509Choice {
    Legacy(X509Authentication),
    Certificate(ClientCertificateAuthentication, ClientIdentity),
}

pub(super) enum Authentication {
    Kerberos {
        server_name: String,
        roots: TrustRoots,
        credentials: kerberos_worker::Credentials,
        policy: kerberos_worker::TicketPolicy,
        binding: super::kerberos::Binding,
        kdc: Option<super::kerberos::Kdc>,
    },
    X509 {
        server_name: String,
        authentication: X509Authentication,
        roots: TrustRoots,
    },
    ClientCertificate {
        server_name: String,
        authentication: ClientCertificateAuthentication,
        roots: TrustRoots,
        identity: ClientIdentity,
    },
    AppleVncPassword(VncPassword),
    AppleDh(AppleDhCredentials),
    AppleSrp(AppleSrpCredentials),
    AppleRsaSrp(AppleRsaSrpCredentials),
    RsaAes {
        security: RsaAesSecurity,
        pin: RsaServerKeyPin,
        credentials: RsaAesCredentials,
    },
}

impl Authentication {
    pub(super) fn requires_outer_protection(&self) -> bool {
        matches!(
            self,
            Self::AppleVncPassword(_)
                | Self::AppleDh(_)
                | Self::AppleSrp(_)
                | Self::AppleRsaSrp(_)
                | Self::RsaAes {
                    security: RsaAesSecurity::Ra2ne | RsaAesSecurity::Ra2ne256,
                    ..
                }
        )
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Transport {
    Direct,
    Ssh {
        connection: Uuid,
        generation: i64,
    },
    Cloudflare {
        configuration: Uuid,
        generation: i64,
    },
    Tailscale {
        configuration: Uuid,
        generation: i64,
    },
}

#[expect(
    clippy::too_many_arguments,
    reason = "The exact protocol handoff includes endpoint, creation identity, and authentication fields."
)]
fn rsa_aes_credential(
    created_at: chrono::DateTime<chrono::Utc>,
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let port = valid_port_and_generation(port, generation)?;
    super::network::validate_host(&host)?;
    let (transport, native) = parse_transport(transport, supports_ssh)?;
    let (security, encoded_pin) = match security {
        ResolveResponseResolvedTransportSecurity::RsaAesRa2 { server_key_sha256 } => {
            (RsaAesSecurity::Ra2, server_key_sha256)
        }
        ResolveResponseResolvedTransportSecurity::RsaAesRa2256 { server_key_sha256 } => {
            (RsaAesSecurity::Ra2_256, server_key_sha256)
        }
        ResolveResponseResolvedTransportSecurity::RsaAesRa2ne { server_key_sha256 } => {
            (RsaAesSecurity::Ra2ne, server_key_sha256)
        }
        ResolveResponseResolvedTransportSecurity::RsaAesRa2ne256 { server_key_sha256 } => {
            (RsaAesSecurity::Ra2ne256, server_key_sha256)
        }
        _ => return Err(Failure::Authority),
    };
    if matches!(security, RsaAesSecurity::Ra2ne | RsaAesSecurity::Ra2ne256)
        && !super::native::raw_route_allowed(&host, transport, native.as_ref())
    {
        return Err(Failure::Authority);
    }
    if encoded_pin.len() != 64
        || !encoded_pin
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Failure::Authority);
    }
    let mut pin = [0u8; 32];
    hex::decode_to_slice(encoded_pin, &mut pin).map_err(|_| Failure::Authority)?;
    let credentials = match authentication {
        ResolveResponseResolvedTransportAuthentication::RsaAesPassword { password } => {
            RsaAesCredentials::password_zeroizing(password.into_zeroizing())
        }
        ResolveResponseResolvedTransportAuthentication::RsaAesUsernamePassword {
            username,
            password,
        } => RsaAesCredentials::username_password_zeroizing(username, password.into_zeroizing()),
        _ => return Err(Failure::Authority),
    }
    .map_err(|_| Failure::InvalidCredential)?;
    Ok(Credential {
        created_at,
        host,
        port,
        generation,
        transport,
        authentication: Authentication::RsaAes {
            security,
            pin: RsaServerKeyPin::new(pin),
            credentials,
        },
        native,
    })
}

fn rsa_aes_profiles(supports_ssh: bool) -> Vec<ResolveRequestSupportedProfile> {
    use ResolveRequestSupportedProfileAuthMethod as Auth;
    use ResolveRequestSupportedProfileSecurityType as Security;
    use ResolveRequestSupportedProfileTransportType as Route;
    let mut profiles = Vec::with_capacity(12);
    for security in [
        Security::RsaAesRa2,
        Security::RsaAesRa2256,
        Security::RsaAesRa2ne,
        Security::RsaAesRa2ne256,
    ] {
        for auth in [Auth::RsaAesPassword, Auth::RsaAesUsernamePassword] {
            if matches!(security, Security::RsaAesRa2 | Security::RsaAesRa2256) {
                profiles.push(ResolveRequestSupportedProfile {
                    auth_method: auth,
                    security_type: security,
                    transport_type: Route::Direct,
                    kdc_transport_type: None,
                });
            }
            if supports_ssh {
                profiles.push(ResolveRequestSupportedProfile {
                    auth_method: auth,
                    security_type: security,
                    transport_type: Route::Ssh,
                    kdc_transport_type: None,
                });
            }
        }
    }
    profiles
}

pub(super) fn valid_port_and_generation(port: u64, generation: i64) -> Result<u16, Failure> {
    let port = u16::try_from(port).map_err(|_| Failure::Authority)?;
    if port == 0 || !(1..=i64::from(i32::MAX)).contains(&generation) {
        return Err(Failure::Authority);
    }
    Ok(port)
}

pub(super) fn parse_transport(
    transport: ResolveResponseResolvedTransportTransport,
    supports_ssh: bool,
) -> Result<(Transport, Option<super::native::Configuration>), Failure> {
    match transport {
        ResolveResponseResolvedTransportTransport::Direct => Ok((Transport::Direct, None)),
        ResolveResponseResolvedTransportTransport::Ssh {
            connection_id,
            generation,
        } => {
            if !supports_ssh || !(1..=i64::from(i32::MAX)).contains(&generation) {
                return Err(Failure::Authority);
            }
            Ok((
                Transport::Ssh {
                    connection: connection_id.parse().map_err(|_| Failure::Authority)?,
                    generation,
                },
                None,
            ))
        }
        native => super::native::parse(native),
    }
}

fn apple_endpoint(
    host: &str,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    supports_ssh: bool,
) -> Result<(u16, Transport, Option<super::native::Configuration>), Failure> {
    let port = valid_port_and_generation(port, generation)?;
    super::network::validate_host(host)?;
    let (transport, native) = parse_transport(transport, supports_ssh)?;
    if !super::native::raw_route_allowed(host, transport, native.as_ref()) {
        return Err(Failure::Authority);
    }
    Ok((port, transport, native))
}

#[expect(
    clippy::too_many_arguments,
    reason = "The exact protocol handoff includes endpoint, creation identity, and authentication fields."
)]
fn apple_vnc_password_credential(
    created_at: chrono::DateTime<chrono::Utc>,
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let (port, transport, native) =
        apple_endpoint(&host, port, generation, transport, supports_ssh)?;
    let password = match (authentication, security) {
        (
            ResolveResponseResolvedTransportAuthentication::VncPassword { password },
            ResolveResponseResolvedTransportSecurity::AppleVncPassword,
        ) => VncPassword::new_zeroizing(password.into_zeroizing())
            .map_err(|_| Failure::InvalidCredential)?,
        _ => return Err(Failure::Authority),
    };
    Ok(Credential {
        created_at,
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleVncPassword(password),
        native,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "The exact protocol handoff includes endpoint, creation identity, and authentication fields."
)]
fn apple_dh_credential(
    created_at: chrono::DateTime<chrono::Utc>,
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let (port, transport, native) =
        apple_endpoint(&host, port, generation, transport, supports_ssh)?;
    let credentials = match (authentication, security) {
        (
            ResolveResponseResolvedTransportAuthentication::AppleDhUsernamePassword {
                username,
                password,
            },
            ResolveResponseResolvedTransportSecurity::AppleDh,
        ) => AppleDhCredentials::new_zeroizing(username, password.into_zeroizing())
            .map_err(|_| Failure::InvalidCredential)?,
        _ => return Err(Failure::Authority),
    };
    Ok(Credential {
        created_at,
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleDh(credentials),
        native,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "The exact protocol handoff includes endpoint, creation identity, and authentication fields."
)]
fn apple_srp_credential(
    created_at: chrono::DateTime<chrono::Utc>,
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let (port, transport, native) =
        apple_endpoint(&host, port, generation, transport, supports_ssh)?;
    let credentials = match (authentication, security) {
        (
            ResolveResponseResolvedTransportAuthentication::AppleSrpUsernamePassword {
                username,
                password,
            },
            ResolveResponseResolvedTransportSecurity::AppleSrp,
        ) => AppleSrpCredentials::new_zeroizing(username, password.into_zeroizing())
            .map_err(|_| Failure::InvalidCredential)?,
        _ => return Err(Failure::Authority),
    };
    Ok(Credential {
        created_at,
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleSrp(credentials),
        native,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "The exact protocol handoff includes endpoint, creation identity, and authentication fields."
)]
fn apple_rsa_srp_credential(
    created_at: chrono::DateTime<chrono::Utc>,
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let (port, transport, native) =
        apple_endpoint(&host, port, generation, transport, supports_ssh)?;
    let credentials = match (authentication, security) {
        (
            ResolveResponseResolvedTransportAuthentication::AppleRsaSrpUsernamePassword {
                username,
                password,
            },
            ResolveResponseResolvedTransportSecurity::AppleRsaSrp,
        ) => AppleRsaSrpCredentials::new_zeroizing(username, password.into_zeroizing())
            .map_err(|_| Failure::InvalidCredential)?,
        _ => return Err(Failure::Authority),
    };
    Ok(Credential {
        created_at,
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleRsaSrp(credentials),
        native,
    })
}

#[cfg(test)]
mod apple_vnc_password_tests;

#[cfg(test)]
mod apple_dh_tests;

#[cfg(test)]
mod apple_srp_tests;

#[cfg(test)]
mod apple_rsa_srp_tests;

impl Authority {
    pub(super) async fn observe(
        &self,
        run: RunId,
        connection: Uuid,
        observation: super::observation::Observation,
    ) {
        let transport = |route| match route {
            Transport::Direct => ObservationRequestExpectedTransport::Direct,
            Transport::Cloudflare {
                configuration,
                generation,
            } => ObservationRequestExpectedTransport::CloudflareAccess {
                config_id: configuration.to_string(),
                generation,
            },
            Transport::Tailscale {
                configuration,
                generation,
            } => ObservationRequestExpectedTransport::Tailscale {
                config_id: configuration.to_string(),
                generation,
            },
            Transport::Ssh {
                connection,
                generation,
            } => ObservationRequestExpectedTransport::Ssh {
                connection_id: connection.to_string(),
                generation,
            },
        };
        let request = ObservationRequest {
            expected_created_at: observation
                .attempt
                .created_at
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            connection_id: connection.to_string(),
            runner_identity: ObservationRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            expected_generation: observation.attempt.generation,
            expected_transport: transport(observation.attempt.transport),
            expected_credential_revision: observation
                .attempt
                .kerberos
                .map(|binding| binding.revision),
            expected_kdc_transport: observation
                .attempt
                .kerberos
                .and_then(|binding| binding.kdc)
                .map(|route| match route {
                    Transport::Direct => ObservationRequestExpectedKdcTransport::Direct,
                    Transport::Cloudflare {
                        configuration,
                        generation,
                    } => ObservationRequestExpectedKdcTransport::CloudflareAccess {
                        config_id: configuration.to_string(),
                        generation,
                    },
                    Transport::Tailscale {
                        configuration,
                        generation,
                    } => ObservationRequestExpectedKdcTransport::Tailscale {
                        config_id: configuration.to_string(),
                        generation,
                    },
                    Transport::Ssh {
                        connection,
                        generation,
                    } => ObservationRequestExpectedKdcTransport::Ssh {
                        connection_id: connection.to_string(),
                        generation,
                    },
                }),
            observed_at: observation
                .observed_at
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            failure_reason: observation.failure,
        };
        let report = async {
            let body = serde_json::to_value(request).ok()?;
            let request = self
                .http
                .json_request(
                    routes::observations::route(routes::observations::Params {
                        run_id: &run.to_string(),
                    }),
                    &self.token,
                    &body,
                )
                .ok()?;
            let response = self.transport.execute(request).await.ok()?;
            response.status().is_success().then_some(())
        };
        // Reporting outages never change connection results.
        if !tokio::time::timeout(std::time::Duration::from_secs(1), report)
            .await
            .is_ok_and(|result| result.is_some())
        {
            // No raw response/error, credentials, session or output at this boundary.
            tracing::info!(run_id = %run, connection_id = %connection, "VNC observation report not confirmed");
        }
    }

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
    ) -> Result<(T, Option<chrono::DateTime<chrono::Utc>>), Failure> {
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
        let created_at = response
            .headers()
            .get("x-vnc-connection-created-at")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&chrono::Utc));
        // A fixed capacity avoids leaving reallocated plaintext buffers behind.
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_API_BYTES));
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Authority)? {
            if chunk.len() > MAX_API_BYTES - bytes.len() {
                return Err(Failure::Authority);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(|body| (body, created_at))
            .map_err(|_| Failure::Authority)
    }

    pub(super) async fn resolve(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        supports_ssh: bool,
        kerberos_probe: Option<(
            &std::path::Path,
            std::sync::Arc<dyn kerberos_worker::WorkOwner>,
            tokio::time::Instant,
        )>,
        diagnostic_identity: &mut crate::diagnostics::Identity,
    ) -> Result<Credential, Failure> {
        let mut supported_profiles = vec![
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::None,
                security_type: ResolveRequestSupportedProfileSecurityType::X509None,
                transport_type: ResolveRequestSupportedProfileTransportType::Direct,
                kdc_transport_type: None,
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                transport_type: ResolveRequestSupportedProfileTransportType::Direct,
                kdc_transport_type: None,
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::UsernamePassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Plain,
                transport_type: ResolveRequestSupportedProfileTransportType::Direct,
                kdc_transport_type: None,
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::QemuScramSha256,
                security_type: ResolveRequestSupportedProfileSecurityType::QemuX509Sasl,
                transport_type: ResolveRequestSupportedProfileTransportType::Direct,
                kdc_transport_type: None,
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::ClientCertificate,
                security_type: ResolveRequestSupportedProfileSecurityType::X509None,
                transport_type: ResolveRequestSupportedProfileTransportType::Direct,
                kdc_transport_type: None,
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::ClientCertificateVncPassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                transport_type: ResolveRequestSupportedProfileTransportType::Direct,
                kdc_transport_type: None,
            },
        ];
        if supports_ssh {
            supported_profiles.extend([
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::None,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509None,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::UsernamePassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509Plain,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::QemuScramSha256,
                    security_type: ResolveRequestSupportedProfileSecurityType::QemuX509Sasl,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::ClientCertificate,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509None,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method:
                        ResolveRequestSupportedProfileAuthMethod::ClientCertificateVncPassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::AppleVncPassword,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::AppleDhUsernamePassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::AppleDh,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method: ResolveRequestSupportedProfileAuthMethod::AppleSrpUsernamePassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::AppleSrp,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
                ResolveRequestSupportedProfile {
                    auth_method:
                        ResolveRequestSupportedProfileAuthMethod::AppleRsaSrpUsernamePassword,
                    security_type: ResolveRequestSupportedProfileSecurityType::AppleRsaSrp,
                    transport_type: ResolveRequestSupportedProfileTransportType::Ssh,
                    kdc_transport_type: None,
                },
            ]);
        }
        supported_profiles.extend(rsa_aes_profiles(supports_ssh));
        supported_profiles.extend(super::native::profiles());
        let kerberos_admitted = if let Some((root, owner, deadline)) = kerberos_probe {
            Box::pin(kerberos_worker::probe_owned(root, deadline, Some(owner)))
                .await
                .is_ok()
        } else {
            false
        };
        if kerberos_admitted {
            supported_profiles.extend(super::kerberos::profiles(supports_ssh));
        }
        let request = ResolveRequest {
            connection_id: connection.to_string(),
            runner_identity: ResolveRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            supported_profiles,
        };
        let (response, created_at) = self
            .call::<ResolveResponse>(
                routes::resolve::route(routes::resolve::Params {
                    run_id: &run.to_string(),
                }),
                &request,
            )
            .await?;
        // Credential parsing can fail after the API has identified the exact
        // configuration. Preserve that identity for the passive failure report.
        diagnostic_identity.created_at = created_at;
        diagnostic_identity.generation = match &response {
            ResolveResponse::ResolvedKerberos { generation, .. }
            | ResolveResponse::ResolvedRsaAes { generation, .. }
            | ResolveResponse::ResolvedAppleVncPassword { generation, .. }
            | ResolveResponse::ResolvedAppleDh { generation, .. }
            | ResolveResponse::ResolvedAppleSrp { generation, .. }
            | ResolveResponse::ResolvedAppleRsaSrp { generation, .. }
            | ResolveResponse::ResolvedTransport { generation, .. } => (1..=i64::from(i32::MAX))
                .contains(generation)
                .then_some(*generation),
            ResolveResponse::Unavailable | ResolveResponse::UnsupportedProfile => None,
        };
        let (host, port, generation, server_name, transport, authentication, security) =
            match response {
                ResolveResponse::Unavailable => return Err(Failure::Unavailable),
                ResolveResponse::UnsupportedProfile => return Err(Failure::UnsupportedProfile),
                ResolveResponse::ResolvedKerberos {
                    host,
                    port,
                    generation,
                    credential_revision,
                    server_name,
                    transport,
                    authentication,
                    security,
                } => {
                    if !kerberos_admitted {
                        return Err(Failure::Authority);
                    }
                    return super::kerberos::credential(
                        created_at.ok_or(Failure::Authority)?,
                        host,
                        port,
                        generation,
                        credential_revision,
                        server_name,
                        transport,
                        authentication,
                        security,
                        supports_ssh,
                    );
                }
                ResolveResponse::ResolvedRsaAes {
                    host,
                    port,
                    generation,
                    transport,
                    authentication,
                    security,
                } => {
                    return rsa_aes_credential(
                        created_at.ok_or(Failure::Authority)?,
                        host,
                        port,
                        generation,
                        transport,
                        authentication,
                        security,
                        supports_ssh,
                    );
                }
                ResolveResponse::ResolvedAppleVncPassword {
                    host,
                    port,
                    generation,
                    transport,
                    authentication,
                    security,
                } => {
                    return apple_vnc_password_credential(
                        created_at.ok_or(Failure::Authority)?,
                        host,
                        port,
                        generation,
                        transport,
                        authentication,
                        security,
                        supports_ssh,
                    );
                }
                ResolveResponse::ResolvedAppleDh {
                    host,
                    port,
                    generation,
                    transport,
                    authentication,
                    security,
                } => {
                    return apple_dh_credential(
                        created_at.ok_or(Failure::Authority)?,
                        host,
                        port,
                        generation,
                        transport,
                        authentication,
                        security,
                        supports_ssh,
                    );
                }
                ResolveResponse::ResolvedAppleSrp {
                    host,
                    port,
                    generation,
                    transport,
                    authentication,
                    security,
                } => {
                    return apple_srp_credential(
                        created_at.ok_or(Failure::Authority)?,
                        host,
                        port,
                        generation,
                        transport,
                        authentication,
                        security,
                        supports_ssh,
                    );
                }
                ResolveResponse::ResolvedAppleRsaSrp {
                    host,
                    port,
                    generation,
                    transport,
                    authentication,
                    security,
                } => {
                    return apple_rsa_srp_credential(
                        created_at.ok_or(Failure::Authority)?,
                        host,
                        port,
                        generation,
                        transport,
                        authentication,
                        security,
                        supports_ssh,
                    );
                }
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
        let port = valid_port_and_generation(port, generation)?;
        super::network::validate_host(&host)?;
        let (transport, native) = parse_transport(transport, supports_ssh)?;
        let (authentication, trust) = match (authentication, security) {
            (
                ResolveResponseResolvedTransportAuthentication::None,
                ResolveResponseResolvedTransportSecurity::X509None { trust },
            ) => (X509Choice::Legacy(X509Authentication::None), trust),
            (
                ResolveResponseResolvedTransportAuthentication::VncPassword { password },
                ResolveResponseResolvedTransportSecurity::X509Vnc { trust },
            ) => {
                let password = VncPassword::new_zeroizing(password.into_zeroizing())
                    .map_err(|_| Failure::InvalidCredential)?;
                (
                    X509Choice::Legacy(X509Authentication::VncPassword(password)),
                    trust,
                )
            }
            (
                ResolveResponseResolvedTransportAuthentication::UsernamePassword {
                    username,
                    password,
                },
                ResolveResponseResolvedTransportSecurity::X509Plain { trust },
            ) => {
                if !(1..=MAX_PLAIN_USERNAME_BYTES).contains(&username.len())
                    || username.as_bytes().contains(&0)
                {
                    return Err(Failure::InvalidCredential);
                }
                let credentials =
                    PlainCredentials::new_zeroizing(username, password.into_zeroizing())
                        .map_err(|_| Failure::InvalidCredential)?;
                (
                    X509Choice::Legacy(X509Authentication::Plain(credentials)),
                    trust,
                )
            }
            (
                ResolveResponseResolvedTransportAuthentication::QemuScramSha256 {
                    username,
                    password,
                },
                ResolveResponseResolvedTransportSecurity::QemuX509Sasl { trust },
            ) => {
                let credentials =
                    QemuScramCredentials::new_zeroizing(username, password.into_zeroizing())
                        .map_err(|_| Failure::InvalidCredential)?;
                (
                    X509Choice::Legacy(X509Authentication::QemuScramSha256(credentials)),
                    trust,
                )
            }
            (
                ResolveResponseResolvedTransportAuthentication::ClientCertificate {
                    certificate_chain_der,
                    private_key_pkcs8_der,
                },
                ResolveResponseResolvedTransportSecurity::X509None { trust },
            ) => (
                X509Choice::Certificate(
                    ClientCertificateAuthentication::None,
                    client_identity(certificate_chain_der, private_key_pkcs8_der)?,
                ),
                trust,
            ),
            (
                ResolveResponseResolvedTransportAuthentication::ClientCertificateVncPassword {
                    certificate_chain_der,
                    private_key_pkcs8_der,
                    password,
                },
                ResolveResponseResolvedTransportSecurity::X509Vnc { trust },
            ) => {
                let password = VncPassword::new_zeroizing(password.into_zeroizing())
                    .map_err(|_| Failure::InvalidCredential)?;
                (
                    X509Choice::Certificate(
                        ClientCertificateAuthentication::VncPassword(password),
                        client_identity(certificate_chain_der, private_key_pkcs8_der)?,
                    ),
                    trust,
                )
            }
            _ => return Err(Failure::Authority),
        };
        let roots = match trust {
            ResolveResponseResolvedTransportSecurityX509VncTrust::System => {
                TrustRoots::public_roots()
            }
            ResolveResponseResolvedTransportSecurityX509VncTrust::CustomCa { ca_bundle } => {
                custom_roots(Zeroizing::new(ca_bundle))?
            }
        };
        Ok(Credential {
            created_at: created_at.ok_or(Failure::Authority)?,
            host,
            port,
            generation,
            transport,
            native,
            authentication: match authentication {
                X509Choice::Legacy(authentication) => Authentication::X509 {
                    server_name,
                    authentication,
                    roots,
                },
                X509Choice::Certificate(authentication, identity) => {
                    Authentication::ClientCertificate {
                        server_name,
                        authentication,
                        roots,
                        identity,
                    }
                }
            },
        })
    }

    pub(super) async fn check(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        generation: i64,
        transport: Transport,
        kerberos: Option<super::kerberos::Binding>,
    ) -> Result<(), Failure> {
        let expected_transport = match transport {
            Transport::Direct => CheckRequestExpectedTransport::Direct,
            Transport::Cloudflare {
                configuration,
                generation,
            } => CheckRequestExpectedTransport::CloudflareAccess {
                config_id: configuration.to_string(),
                generation,
            },
            Transport::Tailscale {
                configuration,
                generation,
            } => CheckRequestExpectedTransport::Tailscale {
                config_id: configuration.to_string(),
                generation,
            },
            Transport::Ssh {
                connection,
                generation,
            } => CheckRequestExpectedTransport::Ssh {
                connection_id: connection.to_string(),
                generation,
            },
        };
        let request = CheckRequest {
            connection_id: connection.to_string(),
            runner_identity: CheckRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            expected_generation: generation,
            expected_transport,
            expected_credential_revision: kerberos.map(|binding| binding.revision),
            expected_kdc_transport: kerberos.and_then(|binding| binding.kdc).map(
                |route| match route {
                    Transport::Direct => CheckRequestExpectedKdcTransport::Direct,
                    Transport::Cloudflare {
                        configuration,
                        generation,
                    } => CheckRequestExpectedKdcTransport::CloudflareAccess {
                        config_id: configuration.to_string(),
                        generation,
                    },
                    Transport::Tailscale {
                        configuration,
                        generation,
                    } => CheckRequestExpectedKdcTransport::Tailscale {
                        config_id: configuration.to_string(),
                        generation,
                    },
                    Transport::Ssh {
                        connection,
                        generation,
                    } => CheckRequestExpectedKdcTransport::Ssh {
                        connection_id: connection.to_string(),
                        generation,
                    },
                },
            ),
        };
        match self
            .call::<CheckResponse>(
                routes::check::route(routes::check::Params {
                    run_id: &run.to_string(),
                }),
                &request,
            )
            .await?
            .0
        {
            CheckResponse::Valid => Ok(()),
            CheckResponse::Unavailable => Err(Failure::Unavailable),
            CheckResponse::ConfigurationChanged => Err(Failure::ConfigurationChanged),
        }
    }
}

/// Accept only bounded certificate blocks, never silently skip keys or junk.
/// DER parsing and trust-anchor validation stay in the TLS library.
pub(super) fn custom_roots(bundle: Zeroizing<String>) -> Result<TrustRoots, Failure> {
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
mod rsa_aes_tests;

#[cfg(test)]
mod tests;
