//! Explicit Kerberos source and independently authorized bounded KDC transport.
mod exchange;
#[cfg(test)]
mod tests;
use super::evidence::Stage;
use super::{
    Failure, Scope, VncRuntime,
    authority::{Authentication, Credential, Transport},
    network,
};
use crate::diagnostics::trace::Progress;
use api_contracts::generated::types::runners::vnc::*;
use base64::Engine;
use kerberos_credentials::{ClientKeytab, Principal, ServiceTicketCache};
use kerberos_worker::{Credentials, Password, Source, TicketPolicy, WorkOwner};
use runner_types::ids::RunId;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio_util::task::TaskTracker;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Copy)]
pub(super) struct Binding {
    pub(super) revision: i64,
    pub(super) kdc: Option<Transport>,
}
pub(super) struct Kdc {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) transport: Transport,
    pub(super) native: Option<Box<super::native::Configuration>>,
    pub(super) node: Option<Arc<crate::tailscale::Node>>,
}
impl Binding {
    pub(super) fn record_ssh_generation(
        &mut self,
        kdc: &mut Option<Kdc>,
        original: Transport,
        attested: Transport,
    ) {
        let (
            Transport::Ssh {
                connection: before, ..
            },
            Transport::Ssh {
                connection: after, ..
            },
            Some(route),
        ) = (original, attested, kdc.as_mut())
        else {
            return;
        };
        // Update only the exact original snapshot. Another route or an already
        // different generation must still fail its independent authority check.
        if before == after && self.kdc == Some(original) && route.transport == original {
            route.transport = attested;
            self.kdc = Some(attested);
        }
    }
}

pub(super) fn profiles(ssh: bool) -> Vec<ResolveRequestSupportedProfile> {
    use ResolveRequestSupportedProfileAuthMethod as A;
    use ResolveRequestSupportedProfileKdcTransportType as K;
    use ResolveRequestSupportedProfileSecurityType as S;
    use ResolveRequestSupportedProfileTransportType as R;
    let mut profiles = Vec::with_capacity(36);
    for rfb in [R::Direct, R::Ssh, R::CloudflareAccess, R::Tailscale] {
        if rfb == R::Ssh && !ssh {
            continue;
        }
        profiles.push(ResolveRequestSupportedProfile {
            auth_method: A::QemuKerberosTicket,
            security_type: S::QemuX509Gssapi,
            transport_type: rfb,
            kdc_transport_type: Some(K::None),
        });
        for auth in [A::QemuKerberosKeytab, A::QemuKerberosPassword] {
            for kdc in [K::Direct, K::Ssh, K::CloudflareAccess, K::Tailscale] {
                if kdc == K::Ssh && !ssh {
                    continue;
                }
                profiles.push(ResolveRequestSupportedProfile {
                    auth_method: auth,
                    security_type: S::QemuX509Gssapi,
                    transport_type: rfb,
                    kdc_transport_type: Some(kdc),
                });
            }
        }
    }
    profiles
}
fn material(encoded: api_contracts::SecretUtf8Text<87384>) -> Result<Vec<u8>, Failure> {
    let encoded = encoded.into_zeroizing();
    let mut bytes = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| Failure::InvalidCredential)?,
    );
    if bytes.len() > 65536 {
        return Err(Failure::InvalidCredential);
    }
    Ok(std::mem::take(&mut *bytes))
}
#[allow(clippy::too_many_arguments)]
pub(super) fn credential(
    created_at: chrono::DateTime<chrono::Utc>,
    host: String,
    port: u64,
    generation: i64,
    revision: i64,
    server_name: String,
    transport: ResolveResponseResolvedTransportTransport,
    authentication: ResolveResponseResolvedTransportAuthentication,
    security: ResolveResponseResolvedTransportSecurity,
    ssh: bool,
) -> Result<Credential, Failure> {
    let port = super::authority::valid_port_and_generation(port, generation)?;
    if !(1..=i64::from(i32::MAX)).contains(&revision) {
        return Err(Failure::Authority);
    }
    network::validate_host(&host)?;
    let (transport, native) = super::authority::parse_transport(transport, ssh)?;
    let ResolveResponseResolvedTransportSecurity::QemuX509Gssapi {
        trust,
        service,
        kdc,
    } = security
    else {
        return Err(Failure::Authority);
    };
    let target = Principal::new(service.realm, service.components)
        .map_err(|_| Failure::InvalidCredential)?;
    let (initiator, source, offline) = match authentication {
        ResolveResponseResolvedTransportAuthentication::QemuKerberosTicket {
            initiator,
            service,
            ticket_cache,
        } => {
            let initiator = Principal::new(initiator.realm, initiator.components)
                .map_err(|_| Failure::InvalidCredential)?;
            let selected = Principal::new(service.realm, service.components)
                .map_err(|_| Failure::InvalidCredential)?;
            if selected != target {
                return Err(Failure::Authority);
            }
            let now = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|_| Failure::InvalidCredential)?
                .as_secs();
            let cache = ServiceTicketCache::parse(
                material(ticket_cache)?,
                &initiator,
                &target,
                u32::try_from(now).map_err(|_| Failure::InvalidCredential)?,
            )
            .map_err(|_| Failure::InvalidCredential)?;
            (initiator, Source::Ticket(cache), true)
        }
        ResolveResponseResolvedTransportAuthentication::QemuKerberosKeytab {
            initiator,
            keytab,
        } => {
            let initiator = Principal::new(initiator.realm, initiator.components)
                .map_err(|_| Failure::InvalidCredential)?;
            let keytab = ClientKeytab::parse(material(keytab)?, &initiator)
                .map_err(|_| Failure::InvalidCredential)?;
            (initiator, Source::Keytab(keytab), false)
        }
        ResolveResponseResolvedTransportAuthentication::QemuKerberosPassword {
            initiator,
            password,
        } => {
            let initiator = Principal::new(initiator.realm, initiator.components)
                .map_err(|_| Failure::InvalidCredential)?;
            (
                initiator,
                Source::Password(
                    Password::new(password.into_zeroizing())
                        .map_err(|_| Failure::InvalidCredential)?,
                ),
                false,
            )
        }
        _ => return Err(Failure::Authority),
    };
    if offline != kdc.is_none() {
        return Err(Failure::Authority);
    }
    let (kdc, policy) = if let Some(kdc) = kdc {
        let port = u16::try_from(kdc.port)
            .ok()
            .filter(|p| *p > 0)
            .ok_or(Failure::Authority)?;
        network::validate_host(&kdc.host)?;
        let (route, native) = super::native::parse_kdc(kdc.transport, ssh)?;
        if matches!(route, Transport::Ssh { .. })
            && !matches!(kdc.host.as_str(), "127.0.0.1" | "::1")
        {
            return Err(Failure::Authority);
        }
        let lifetime = kdc.ticket_lifetime_seconds;
        let renewable = kdc.renewable_lifetime_seconds;
        (
            Some(Kdc {
                host: kdc.host,
                port,
                transport: route,
                native: native.map(Box::new),
                node: None,
            }),
            TicketPolicy::new(
                Duration::from_secs(lifetime),
                Duration::from_secs(renewable),
            )
            .map_err(|_| Failure::Authority)?,
        )
    } else {
        (
            None,
            TicketPolicy::new(Duration::from_secs(1), Duration::ZERO)
                .map_err(|_| Failure::Authority)?,
        )
    };
    let roots = match trust {
        ResolveResponseResolvedTransportSecurityX509VncTrust::System => {
            rfb_client::TrustRoots::public_roots()
        }
        ResolveResponseResolvedTransportSecurityX509VncTrust::CustomCa { ca_bundle } => {
            super::authority::custom_roots(Zeroizing::new(ca_bundle))?
        }
    };
    let binding = Binding {
        revision,
        kdc: kdc.as_ref().map(|route| route.transport),
    };
    let credentials =
        Credentials::new(initiator, target, source).map_err(|_| Failure::InvalidCredential)?;
    Ok(Credential {
        created_at,
        host,
        port,
        generation,
        transport,
        native,
        authentication: Authentication::Kerberos {
            server_name,
            roots,
            credentials,
            policy,
            binding,
            kdc,
        },
    })
}

pub(super) struct Caller<'a> {
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) run: RunId,
    pub(super) connection: Uuid,
    pub(super) generation: i64,
    pub(super) rfb: Transport,
    pub(super) binding: Binding,
    pub(super) kdc: Option<Kdc>,
    pub(super) realm: String,
    pub(super) scope: Scope,
    pub(super) ssh: Option<Arc<crate::ssh::Run>>,
    pub(super) tasks: TaskTracker,
    pub(super) owner: Arc<dyn WorkOwner>,
    pub(super) exchanges: usize,
    pub(super) total: usize,
    pub(super) awaiting_kdc_reply: &'a AtomicBool,
    pub(super) native: super::native::Dialer,
    pub(super) diagnostics: &'a mut super::sessions::StartEvidence,
}
impl Caller<'_> {
    pub(super) fn authentication_result<T>(
        &self,
        result: Result<T, rfb_client::Error>,
    ) -> Result<T, rfb_client::Error> {
        if self.awaiting_kdc_reply.load(Ordering::Relaxed) && result.is_err() {
            // Any enclosing failure can cancel a partially sent exchange.
            // Preserve uncertainty until one complete reply is admitted.
            Err(rfb_client::Error::Kerberos(
                kerberos_worker::Error::DeliveryUnknown,
            ))
        } else {
            result
        }
    }
}
