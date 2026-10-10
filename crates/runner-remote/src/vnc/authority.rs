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
    pub(super) transport: Transport,
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

#[derive(Clone, Copy)]
pub(super) enum Transport {
    Direct,
    Ssh { connection: Uuid, generation: i64 },
}

fn rsa_aes_credential(
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
    let transport = parse_transport(transport, supports_ssh)?;
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
        && (!matches!(transport, Transport::Ssh { .. })
            || !matches!(host.as_str(), "127.0.0.1" | "::1"))
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
        host,
        port,
        generation,
        transport,
        authentication: Authentication::RsaAes {
            security,
            pin: RsaServerKeyPin::new(pin),
            credentials,
        },
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
) -> Result<Transport, Failure> {
    match transport {
        ResolveResponseResolvedTransportTransport::Direct => Ok(Transport::Direct),
        ResolveResponseResolvedTransportTransport::Ssh {
            connection_id,
            generation,
        } => {
            if !supports_ssh || !(1..=i64::from(i32::MAX)).contains(&generation) {
                return Err(Failure::Authority);
            }
            Ok(Transport::Ssh {
                connection: connection_id.parse().map_err(|_| Failure::Authority)?,
                generation,
            })
        }
    }
}

fn apple_vnc_password_credential(
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let port = valid_port_and_generation(port, generation)?;
    if !supports_ssh || !matches!(host.as_str(), "127.0.0.1" | "::1") {
        return Err(Failure::Authority);
    }
    let transport = match parse_transport(transport, supports_ssh)? {
        ssh @ Transport::Ssh { .. } => ssh,
        Transport::Direct => return Err(Failure::Authority),
    };
    let password = match (authentication, security) {
        (
            ResolveResponseResolvedTransportAuthentication::VncPassword { password },
            ResolveResponseResolvedTransportSecurity::AppleVncPassword,
        ) => VncPassword::new_zeroizing(password.into_zeroizing())
            .map_err(|_| Failure::InvalidCredential)?,
        _ => return Err(Failure::Authority),
    };
    Ok(Credential {
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleVncPassword(password),
    })
}

fn apple_dh_credential(
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let port = valid_port_and_generation(port, generation)?;
    if !supports_ssh || !matches!(host.as_str(), "127.0.0.1" | "::1") {
        return Err(Failure::Authority);
    }
    let transport = match parse_transport(transport, supports_ssh)? {
        ssh @ Transport::Ssh { .. } => ssh,
        Transport::Direct => return Err(Failure::Authority),
    };
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
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleDh(credentials),
    })
}

fn apple_srp_credential(
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let port = valid_port_and_generation(port, generation)?;
    if !supports_ssh || !matches!(host.as_str(), "127.0.0.1" | "::1") {
        return Err(Failure::Authority);
    }
    let transport = match parse_transport(transport, supports_ssh)? {
        ssh @ Transport::Ssh { .. } => ssh,
        Transport::Direct => return Err(Failure::Authority),
    };
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
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleSrp(credentials),
    })
}

fn apple_rsa_srp_credential(
    host: String,
    port: u64,
    generation: i64,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    supports_ssh: bool,
) -> Result<Credential, Failure> {
    let port = valid_port_and_generation(port, generation)?;
    if !supports_ssh || !matches!(host.as_str(), "127.0.0.1" | "::1") {
        return Err(Failure::Authority);
    }
    let transport = match parse_transport(transport, supports_ssh)? {
        ssh @ Transport::Ssh { .. } => ssh,
        Transport::Direct => return Err(Failure::Authority),
    };
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
        host,
        port,
        generation,
        transport,
        authentication: Authentication::AppleRsaSrp(credentials),
    })
}

#[cfg(test)]
mod apple_vnc_password_tests {
    use super::*;
    use serde_json::{Value, json};

    fn response() -> Value {
        json!({
            "outcome": "resolved_apple_vnc_password",
            "host": "127.0.0.1",
            "port": 5900,
            "generation": 3,
            "transport": {
                "type": "ssh",
                "connectionId": "00000000-0000-4000-8000-000000000001",
                "generation": 4
            },
            "authentication": { "method": "vnc_password", "password": "secret" },
            "security": { "type": "apple_vnc_password" }
        })
    }

    fn parse(value: Value, supports_ssh: bool) -> Result<Credential, Failure> {
        let response: ResolveResponse =
            serde_json::from_value(value).map_err(|_| Failure::InvalidCredential)?;
        let ResolveResponse::ResolvedAppleVncPassword {
            host,
            port,
            generation,
            transport,
            authentication,
            security,
        } = response
        else {
            panic!("expected Apple classic password outcome");
        };
        apple_vnc_password_credential(
            host,
            port,
            generation,
            transport,
            authentication,
            security,
            supports_ssh,
        )
    }

    #[test]
    fn accepts_only_exact_ssh_loopback_and_classic_password() {
        let valid = parse(response(), true).unwrap();
        assert!(matches!(
            valid.transport,
            Transport::Ssh { generation: 4, .. }
        ));
        assert!(matches!(
            valid.authentication,
            Authentication::AppleVncPassword(_)
        ));
        let mut ipv6 = response();
        ipv6["host"] = json!("::1");
        assert!(parse(ipv6, true).is_ok());
        assert!(matches!(parse(response(), false), Err(Failure::Authority)));

        for (pointer, value) in [
            ("/host", json!("localhost")),
            ("/host", json!("mac.example.com")),
            ("/port", json!(0)),
            ("/generation", json!(0)),
            ("/transport", json!({ "type": "direct" })),
            ("/transport/generation", json!(0)),
            (
                "/authentication",
                json!({ "method": "username_password", "username": "u", "password": "secret" }),
            ),
            (
                "/security",
                json!({ "type": "x509_vnc", "trust": { "mode": "system" } }),
            ),
        ] {
            let mut invalid = response();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(parse(invalid, true).is_err(), "accepted {pointer}");
        }
        for password in ["", "ninebytes", "nonäsc", "with\0nul"] {
            let mut invalid = response();
            invalid["authentication"]["password"] = json!(password);
            assert!(matches!(
                parse(invalid, true),
                Err(Failure::InvalidCredential)
            ));
        }
    }
}

#[cfg(test)]
mod apple_dh_tests {
    use super::*;
    use serde_json::{Value, json};

    fn parse(value: Value, supports_ssh: bool) -> Result<Credential, Failure> {
        let response: ResolveResponse = serde_json::from_value(value).unwrap();
        let ResolveResponse::ResolvedAppleDh {
            host,
            port,
            generation,
            transport,
            authentication,
            security,
        } = response
        else {
            panic!("expected Apple DH outcome");
        };
        apple_dh_credential(
            host,
            port,
            generation,
            transport,
            authentication,
            security,
            supports_ssh,
        )
    }

    fn response() -> Value {
        json!({
            "outcome": "resolved_apple_dh",
            "host": "127.0.0.1",
            "port": 5900,
            "generation": 3,
            "transport": {
                "type": "ssh",
                "connectionId": "00000000-0000-4000-8000-000000000001",
                "generation": 4
            },
            "authentication": {
                "method": "apple_dh_username_password",
                "username": "operator",
                "password": "secret"
            },
            "security": { "type": "apple_dh" }
        })
    }

    #[test]
    fn accepts_only_exact_ssh_loopback_apple_tuple() {
        let valid = parse(response(), true).unwrap();
        assert!(matches!(
            valid.transport,
            Transport::Ssh { generation: 4, .. }
        ));
        assert!(matches!(valid.authentication, Authentication::AppleDh(_)));
        assert_eq!(valid.host, "127.0.0.1");
        let mut ipv6 = response();
        ipv6["host"] = json!("::1");
        assert!(parse(ipv6, true).is_ok());
        assert!(matches!(parse(response(), false), Err(Failure::Authority)));

        for (pointer, value) in [
            ("/host", json!("localhost")),
            ("/host", json!("mac.example.com")),
            ("/port", json!(0)),
            ("/generation", json!(0)),
            ("/transport", json!({ "type": "direct" })),
            ("/transport/generation", json!(0)),
            (
                "/authentication",
                json!({ "method": "username_password", "username": "operator", "password": "secret" }),
            ),
            (
                "/security",
                json!({ "type": "x509_plain", "trust": { "mode": "system" } }),
            ),
        ] {
            let mut invalid = response();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(parse(invalid, true).is_err(), "accepted {pointer}");
        }
        for (field, value) in [("username", "x".repeat(64)), ("password", "x".repeat(64))] {
            let mut invalid = response();
            invalid["authentication"][field] = json!(value);
            assert!(matches!(
                parse(invalid, true),
                Err(Failure::InvalidCredential)
            ));
        }
    }
}

#[cfg(test)]
mod apple_srp_tests {
    use super::*;
    use serde_json::{Value, json};

    fn parse(value: Value, supports_ssh: bool) -> Result<Credential, Failure> {
        let response: ResolveResponse =
            serde_json::from_value(value).map_err(|_| Failure::InvalidCredential)?;
        let ResolveResponse::ResolvedAppleSrp {
            host,
            port,
            generation,
            transport,
            authentication,
            security,
        } = response
        else {
            panic!("expected Apple SRP outcome");
        };
        apple_srp_credential(
            host,
            port,
            generation,
            transport,
            authentication,
            security,
            supports_ssh,
        )
    }

    fn response() -> Value {
        json!({
            "outcome": "resolved_apple_srp",
            "host": "127.0.0.1",
            "port": 5900,
            "generation": 3,
            "transport": {
                "type": "ssh",
                "connectionId": "00000000-0000-4000-8000-000000000001",
                "generation": 4
            },
            "authentication": {
                "method": "apple_srp_username_password",
                "username": "operator",
                "password": "secret"
            },
            "security": { "type": "apple_srp" }
        })
    }

    #[test]
    fn accepts_only_exact_ssh_loopback_apple_srp_tuple() {
        let valid = parse(response(), true).unwrap();
        assert!(matches!(
            valid.transport,
            Transport::Ssh { generation: 4, .. }
        ));
        assert!(matches!(valid.authentication, Authentication::AppleSrp(_)));
        let mut ipv6 = response();
        ipv6["host"] = json!("::1");
        assert!(parse(ipv6, true).is_ok());
        assert!(matches!(parse(response(), false), Err(Failure::Authority)));

        for (pointer, value) in [
            ("/host", json!("localhost")),
            ("/host", json!("mac.example.com")),
            ("/port", json!(0)),
            ("/generation", json!(0)),
            ("/transport", json!({ "type": "direct" })),
            ("/transport/generation", json!(0)),
            (
                "/authentication",
                json!({ "method": "apple_dh_username_password", "username": "operator", "password": "secret" }),
            ),
            ("/security", json!({ "type": "apple_dh" })),
        ] {
            let mut invalid = response();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(parse(invalid, true).is_err(), "accepted {pointer}");
        }
        for (field, value) in [
            ("username", "x".repeat(256)),
            ("password", "x".repeat(1024)),
        ] {
            let mut invalid = response();
            invalid["authentication"][field] = json!(value);
            assert!(
                matches!(parse(invalid, true), Err(Failure::InvalidCredential)),
                "accepted overlong {field}"
            );
        }
    }
}

#[cfg(test)]
mod apple_rsa_srp_tests {
    use super::*;
    use serde_json::{Value, json};

    fn response() -> Value {
        json!({
            "outcome": "resolved_apple_rsa_srp",
            "host": "127.0.0.1",
            "port": 5900,
            "generation": 3,
            "transport": {
                "type": "ssh",
                "connectionId": "00000000-0000-4000-8000-000000000001",
                "generation": 4
            },
            "authentication": {
                "method": "apple_rsa_srp_username_password",
                "username": "operator",
                "password": "secret"
            },
            "security": { "type": "apple_rsa_srp" }
        })
    }

    fn parse(value: Value, supports_ssh: bool) -> Result<Credential, Failure> {
        let response: ResolveResponse =
            serde_json::from_value(value).map_err(|_| Failure::InvalidCredential)?;
        let ResolveResponse::ResolvedAppleRsaSrp {
            host,
            port,
            generation,
            transport,
            authentication,
            security,
        } = response
        else {
            panic!("expected Apple RSA/SRP outcome");
        };
        apple_rsa_srp_credential(
            host,
            port,
            generation,
            transport,
            authentication,
            security,
            supports_ssh,
        )
    }

    #[test]
    fn exact_ssh_loopback_and_rsa_username_bound_fail_closed() {
        let valid = parse(response(), true).unwrap();
        assert!(matches!(
            valid.transport,
            Transport::Ssh { generation: 4, .. }
        ));
        assert!(matches!(
            valid.authentication,
            Authentication::AppleRsaSrp(_)
        ));
        let mut ipv6 = response();
        ipv6["host"] = json!("::1");
        assert!(parse(ipv6, true).is_ok());
        assert!(matches!(parse(response(), false), Err(Failure::Authority)));

        for (pointer, value) in [
            ("/host", json!("localhost")),
            ("/host", json!("mac.example.com")),
            ("/port", json!(0)),
            ("/generation", json!(0)),
            ("/transport", json!({ "type": "direct" })),
            ("/transport/generation", json!(0)),
            (
                "/authentication",
                json!({ "method": "apple_srp_username_password", "username": "operator", "password": "secret" }),
            ),
            ("/security", json!({ "type": "apple_srp" })),
        ] {
            let mut invalid = response();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(parse(invalid, true).is_err(), "accepted {pointer}");
        }
        for (field, value) in [
            ("username", "ü".repeat(118)),
            ("password", "x".repeat(1024)),
        ] {
            let mut invalid = response();
            invalid["authentication"][field] = json!(value);
            assert!(matches!(
                parse(invalid, true),
                Err(Failure::InvalidCredential)
            ));
        }
        let mut boundary = response();
        boundary["authentication"]["username"] = json!("ü".repeat(117));
        assert!(parse(boundary, true).is_ok());
    }
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
        Ok(self.call_versioned(route, body).await?.0)
    }

    async fn call_versioned<T: DeserializeOwned>(
        &self,
        route: api_contracts::ResolvedRoute,
        body: &impl Serialize,
    ) -> Result<(T, bool), Failure> {
        let body = serde_json::to_value(body).map_err(|_| Failure::Authority)?;
        let mut request = self
            .http
            .json_request(route, &self.token, &body)
            .map_err(|_| Failure::Authority)?;
        request.headers_mut().insert(
            "X-VNC-Profile-Version",
            reqwest::header::HeaderValue::from_static("kerberos-v1"),
        );
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
        let version = response
            .headers()
            .get("X-VNC-Profile-Version")
            .is_some_and(|value| value == "kerberos-v1");
        // A fixed capacity avoids leaving reallocated plaintext buffers behind.
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_API_BYTES));
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Authority)? {
            if chunk.len() > MAX_API_BYTES - bytes.len() {
                return Err(Failure::Authority);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((
            serde_json::from_slice(&bytes).map_err(|_| Failure::Authority)?,
            version,
        ))
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
        let mut request = ResolveRequest {
            connection_id: connection.to_string(),
            runner_identity: ResolveRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            supported_profiles,
        };
        let (mut response, version) = self
            .call_versioned::<ResolveResponse>(
                routes::resolve::route(routes::resolve::Params {
                    run_id: &run.to_string(),
                }),
                &request,
            )
            .await?;
        let mut kerberos_admitted = false;
        if matches!(response, ResolveResponse::UnsupportedProfile)
            && version
            && let Some((root, owner, deadline)) = kerberos_probe
        {
            Box::pin(kerberos_worker::probe_owned(root, deadline, Some(owner)))
                .await
                .map_err(|_| Failure::Unavailable)?;
            request.supported_profiles = super::kerberos::profiles(supports_ssh);
            kerberos_admitted = true;
            response = self
                .call(
                    routes::resolve::route(routes::resolve::Params {
                        run_id: &run.to_string(),
                    }),
                    &request,
                )
                .await?;
        }
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
        let transport = parse_transport(transport, supports_ssh)?;
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
            host,
            port,
            generation,
            transport,
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

    pub(super) async fn check_kerberos(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        generation: i64,
        transport: Transport,
        kerberos: Option<super::kerberos::Binding>,
    ) -> Result<(), Failure> {
        let expected_transport = match transport {
            Transport::Direct => CheckRequestExpectedTransport::Direct,
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
mod rsa_aes_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_rsa_capabilities_and_generated_handoff_preserve_modes_and_255_byte_fields() {
        assert_eq!(rsa_aes_profiles(false).len(), 4);
        let profiles = rsa_aes_profiles(true);
        assert_eq!(profiles.len(), 12);
        for profile in profiles {
            let mode = match profile.security_type {
                ResolveRequestSupportedProfileSecurityType::RsaAesRa2 => "rsa_aes_ra2",
                ResolveRequestSupportedProfileSecurityType::RsaAesRa2256 => "rsa_aes_ra2_256",
                ResolveRequestSupportedProfileSecurityType::RsaAesRa2ne => "rsa_aes_ra2ne",
                ResolveRequestSupportedProfileSecurityType::RsaAesRa2ne256 => "rsa_aes_ra2ne_256",
                _ => panic!("unexpected RSA capability"),
            };
            let authentication = match profile.auth_method {
                ResolveRequestSupportedProfileAuthMethod::RsaAesPassword => {
                    json!({"method":"rsa_aes_password","password":"界".repeat(85)})
                }
                ResolveRequestSupportedProfileAuthMethod::RsaAesUsernamePassword => {
                    json!({"method":"rsa_aes_username_password","username":"界".repeat(85),"password":"界".repeat(85)})
                }
                _ => panic!("unexpected RSA credential"),
            };
            let transport = match profile.transport_type {
                ResolveRequestSupportedProfileTransportType::Direct => {
                    assert!(!mode.contains("ra2ne"));
                    json!({"type":"direct"})
                }
                ResolveRequestSupportedProfileTransportType::Ssh => {
                    json!({"type":"ssh","connectionId":"10000000-0000-4000-8000-000000000001","generation":1})
                }
            };
            let response: ResolveResponse = serde_json::from_value(json!({"outcome":"resolved_rsa_aes","host":"127.0.0.1","port":5900,"generation":1,"transport":transport,"authentication":authentication,"security":{"type":mode,"serverKeySha256":"ab".repeat(32)}})).unwrap();
            let ResolveResponse::ResolvedRsaAes {
                host,
                port,
                generation,
                transport,
                authentication,
                security,
            } = response
            else {
                panic!("wrong private handoff");
            };
            let credential = rsa_aes_credential(
                host,
                port,
                generation,
                transport,
                authentication,
                security,
                true,
            )
            .unwrap_or_else(|_| panic!("valid exact handoff rejected"));
            assert!(matches!(
                credential.authentication,
                Authentication::RsaAes { .. }
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certificate_handoff_requires_bounded_matching_pkcs8_before_network() {
        let key = rcgen::KeyPair::generate().unwrap();
        let certificate = rcgen::CertificateParams::new(vec!["client.example.test".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let encoded_cert = base64::engine::general_purpose::STANDARD.encode(certificate.der());
        let encoded_key = base64::engine::general_purpose::STANDARD.encode(key.serialize_der());
        let parse = |certificates: Vec<String>, encoded: String| {
            let secret = serde_json::from_value(serde_json::json!(encoded)).unwrap();
            client_identity(certificates, secret)
        };
        assert!(parse(vec![encoded_cert.clone()], encoded_key.clone()).is_ok());
        let wrong_key = rcgen::KeyPair::generate().unwrap();
        assert!(matches!(
            parse(
                vec![encoded_cert.clone()],
                base64::engine::general_purpose::STANDARD.encode(wrong_key.serialize_der())
            ),
            Err(Failure::InvalidCredential)
        ));
        for certificates in [vec![], vec![encoded_cert.clone(); 9], vec!["AAAA".into()]] {
            assert!(matches!(
                parse(certificates, encoded_key.clone()),
                Err(Failure::InvalidCredential)
            ));
        }
        assert!(matches!(
            parse(vec![encoded_cert], "AAAA".into()),
            Err(Failure::InvalidCredential)
        ));
    }

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
