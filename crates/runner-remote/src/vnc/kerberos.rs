//! Explicit Kerberos source and independently authorized bounded KDC transport.
use super::{
    Failure, Scope, VncRuntime,
    authority::{Authentication, Credential, Transport},
    network,
    sessions::DirectOrSshStream,
};
use api_contracts::generated::types::runners::vnc::*;
use base64::Engine;
use kerberos_credentials::{ClientKeytab, Principal, ServiceTicketCache};
use kerberos_worker::{Credentials, Password, Source, TicketPolicy, WorkOwner};
use runner_types::ids::RunId;
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
}

pub(super) fn profiles(ssh: bool) -> Vec<ResolveRequestSupportedProfile> {
    use ResolveRequestSupportedProfileAuthMethod as A;
    use ResolveRequestSupportedProfileKdcTransportType as K;
    use ResolveRequestSupportedProfileSecurityType as S;
    use ResolveRequestSupportedProfileTransportType as R;
    let mut profiles = Vec::with_capacity(10);
    for rfb in [R::Direct, R::Ssh] {
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
            for kdc in [K::Direct, K::Ssh] {
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
    let transport = super::authority::parse_transport(transport, ssh)?;
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
        let route = match kdc.transport {
            ResolveResponseResolvedTransportSecurityQemuX509GssapiKdcTransport::Direct => {
                Transport::Direct
            }
            ResolveResponseResolvedTransportSecurityQemuX509GssapiKdcTransport::Ssh {
                connection_id,
                generation,
            } => {
                if !ssh
                    || !(1..=i64::from(i32::MAX)).contains(&generation)
                    || !matches!(kdc.host.as_str(), "127.0.0.1" | "::1")
                {
                    return Err(Failure::Authority);
                }
                Transport::Ssh {
                    connection: connection_id.parse().map_err(|_| Failure::Authority)?,
                    generation,
                }
            }
        };
        let lifetime = kdc.ticket_lifetime_seconds;
        let renewable = kdc.renewable_lifetime_seconds;
        (
            Some(Kdc {
                host: kdc.host,
                port,
                transport: route,
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
        host,
        port,
        generation,
        transport,
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

pub(super) struct Caller {
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
}
impl kerberos_worker::KdcExchange for Caller {
    fn work_owner(&self) -> Option<Arc<dyn WorkOwner>> {
        Some(Arc::clone(&self.owner))
    }
    async fn authorize(&mut self) -> Result<(), kerberos_worker::Error> {
        self.scope
            .wait(self.runtime.authority.check_kerberos(
                self.run,
                self.connection,
                self.generation,
                self.rfb,
                Some(self.binding),
            ))
            .await
            .map_err(|_| kerberos_worker::Error::Authority)?
            .map_err(|_| kerberos_worker::Error::Authority)?;
        self.scope
            .check()
            .map_err(|_| kerberos_worker::Error::Authority)
    }
    async fn exchange(
        &mut self,
        realm: &str,
        request: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, kerberos_worker::Error> {
        use kerberos_worker::Error as E;
        if realm != self.realm
            || request.is_empty()
            || request.len() > 65536
            || self.exchanges >= 16
            || self.total.saturating_add(request.len()) > 512 * 1024
        {
            return Err(E::Invalid);
        }
        self.authorize().await?;
        let route = self.kdc.as_ref().ok_or(E::Authority)?;
        let host = route.host.clone();
        let port = route.port;
        let transport = route.transport;
        let mut stream = match transport {
            Transport::Direct => {
                let network = Arc::clone(&self.runtime.network);
                let owner = Arc::clone(&self.owner);
                let resolve = self.tasks.spawn(async move {
                    let _owner = owner;
                    network::destination(network, &host, port).await
                });
                let address = self
                    .scope
                    .wait(resolve)
                    .await
                    .map_err(|_| E::Authority)?
                    .map_err(|_| E::KdcUnavailable)?
                    .map_err(|_| E::KdcUnavailable)?;
                self.authorize().await?;
                DirectOrSshStream::Direct(
                    self.scope
                        .wait(self.runtime.network.connect(address))
                        .await
                        .map_err(|_| E::Authority)?
                        .map_err(|_| E::KdcUnavailable)?,
                )
            }
            Transport::Ssh {
                connection,
                generation,
            } => {
                let ssh = self.ssh.as_ref().ok_or(E::Authority)?;
                let stream = self
                    .scope
                    .wait(ssh.open_direct_tcpip(
                        connection,
                        generation,
                        &host,
                        port,
                        self.scope.session.clone(),
                        self.scope.deadline,
                    ))
                    .await
                    .map_err(|_| E::Authority)?
                    .map_err(|_| E::KdcUnavailable)?;
                if stream.generation() != generation {
                    return Err(E::Authority);
                }
                DirectOrSshStream::Ssh(Box::new(stream))
            }
        };
        self.authorize().await?;
        self.exchanges += 1;
        self.total += request.len();
        // After a write is attempted every uncertain result is terminal. No retry.
        stream
            .write_all(&(request.len() as u32).to_be_bytes())
            .await
            .map_err(|_| E::DeliveryUnknown)?;
        self.authorize().await.map_err(|_| E::DeliveryUnknown)?;
        stream
            .write_all(request)
            .await
            .map_err(|_| E::DeliveryUnknown)?;
        stream.flush().await.map_err(|_| E::DeliveryUnknown)?;
        let size = stream.read_u32().await.map_err(|_| E::DeliveryUnknown)? as usize;
        if !(1..=65536).contains(&size) || self.total.saturating_add(size) > 512 * 1024 {
            return Err(E::DeliveryUnknown);
        }
        let mut reply = Zeroizing::new(vec![0; size]);
        stream
            .read_exact(&mut reply)
            .await
            .map_err(|_| E::DeliveryUnknown)?;
        self.total += size;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_are_ten_exact_source_rfb_kdc_tuples() {
        let full = profiles(true);
        assert_eq!(full.len(), 10);
        assert_eq!(
            full.iter()
                .filter(|p| p.kdc_transport_type
                    == Some(ResolveRequestSupportedProfileKdcTransportType::None))
                .count(),
            2
        );
        let direct = profiles(false);
        assert_eq!(direct.len(), 3);
        assert!(direct.iter().all(|p| p.transport_type
            == ResolveRequestSupportedProfileTransportType::Direct
            && p.kdc_transport_type != Some(ResolveRequestSupportedProfileKdcTransportType::Ssh)));
    }
}
