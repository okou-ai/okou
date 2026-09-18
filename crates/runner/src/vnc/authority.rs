//! Private VNC authority, with bounded secret ownership and no response diagnostics.

use api_contracts::generated::{
    routes::runners::runs::by_run_id::vnc as routes, types::runners::vnc::*,
};
use base64::Engine;
use rfb_client::{TrustRoots, VncPassword};
use rustls::pki_types::CertificateDer;
use serde::{Serialize, de::DeserializeOwned};
use zeroize::Zeroizing;

use super::Failure;
use crate::{http::HttpClient, ids::RunId, runner_process_identity::RunnerProcessIdentity};

const MAX_API_BYTES: usize = 512 * 1024;
const MAX_CA_BYTES: usize = 64 * 1024;
const MAX_CA_CERTIFICATES: usize = 8;

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
    pub(super) password: VncPassword,
    pub(super) roots: TrustRoots,
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
        let request = self
            .http
            .request_resolved_route(route, &self.token)
            .json(body)
            .build()
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
    ) -> Result<Credential, Failure> {
        let request = ResolveRequest {
            connection_id: connection.to_string(),
            runner_identity: ResolveRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            supported_profiles: vec![ResolveRequestSupportedProfile {
                auth_method: "vnc_password".into(),
                security_type: "x509_vnc".into(),
            }],
        };
        let response = self
            .call(
                routes::resolve::route(routes::resolve::Params {
                    run_id: &run.to_string(),
                }),
                &request,
            )
            .await?;
        let (host, port, generation, authentication, security) = match response {
            ResolveResponse::Unavailable => return Err(Failure::Unavailable),
            ResolveResponse::UnsupportedProfile => return Err(Failure::UnsupportedProfile),
            ResolveResponse::Resolved {
                host,
                port,
                generation,
                authentication,
                security,
            } => (host, port, generation, authentication, security),
        };
        let port = u16::try_from(port).map_err(|_| Failure::Authority)?;
        if port == 0 || !(1..=i64::from(i32::MAX)).contains(&generation) {
            return Err(Failure::Authority);
        }
        super::network::validate_host(&host)?;
        let ResolveResponseResolvedAuthentication::VncPassword { password } = authentication;
        let password = VncPassword::new(password.expose().to_owned())
            .map_err(|_| Failure::InvalidCredential)?;
        let ResolveResponseResolvedSecurity::X509Vnc { trust } = security;
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
            password,
            roots,
        })
    }

    pub(super) async fn check(
        &self,
        run: RunId,
        connection: uuid::Uuid,
        generation: i64,
    ) -> Result<(), Failure> {
        let request = CheckRequest {
            connection_id: connection.to_string(),
            runner_identity: CheckRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            expected_generation: generation,
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
