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
        created_at,
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
    pub(super) awaiting_kdc_reply: bool,
}
impl Caller {
    pub(super) fn authentication_result<T>(
        &self,
        result: Result<T, rfb_client::Error>,
    ) -> Result<T, rfb_client::Error> {
        if self.awaiting_kdc_reply
            && matches!(
                result.as_ref(),
                Err(
                    rfb_client::Error::Kerberos(kerberos_worker::Error::Deadline)
                        | rfb_client::Error::AuthenticationDeadlineExceeded { .. }
                        | rfb_client::Error::DeadlineExceeded
                )
            )
        {
            // An enclosing authentication timer can cancel exchange while its
            // socket still awaits a reply. Preserve the attempted delivery;
            // the deadline does not establish that the KDC received no bytes.
            Err(rfb_client::Error::Kerberos(
                kerberos_worker::Error::DeliveryUnknown,
            ))
        } else {
            result
        }
    }
}
impl kerberos_worker::KdcExchange for Caller {
    fn work_owner(&self) -> Option<Arc<dyn WorkOwner>> {
        Some(Arc::clone(&self.owner))
    }
    async fn authorize(&mut self) -> Result<(), kerberos_worker::Error> {
        self.scope
            .wait(self.runtime.authority.check(
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
                // The shared SSH authority permits only its attested first-use
                // host-key pin transition. Retain that generation and recheck
                // the independent KDC grant before sending any KDC bytes.
                let learned = Transport::Ssh {
                    connection,
                    generation: stream.generation(),
                };
                self.binding
                    .record_ssh_generation(&mut self.kdc, transport, learned);
                DirectOrSshStream::Ssh(Box::new(stream))
            }
        };
        self.authorize().await?;
        self.exchanges += 1;
        self.total += request.len();
        // After a write is attempted every uncertain result is terminal. No retry.
        self.awaiting_kdc_reply = true;
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
        self.awaiting_kdc_reply = false;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ssh::tests::harness::{CONNECTION, Harness, Reply, TOKEN},
        test_fixtures::http::{HttpClientConfig, http_client},
    };
    use kerberos_worker::KdcExchange;
    use serde_json::json;
    use tokio::{net::TcpStream, time::Instant};
    use tokio_util::sync::CancellationToken;

    fn caller(h: &Harness) -> Caller {
        let runtime = VncRuntime::official(
            http_client(HttpClientConfig {
                api_url: h.api.base_url(),
                vercel_bypass: None,
                client_session_id: "kerberos-kdc-forwarding".into(),
            }),
            TOKEN,
            h.identity,
        )
        .unwrap()
        .unwrap();
        let transport = Transport::Ssh {
            connection: CONNECTION.parse().unwrap(),
            generation: 7,
        };
        Caller {
            runtime,
            run: h.run,
            connection: CONNECTION.parse().unwrap(),
            generation: 11,
            rfb: Transport::Direct,
            binding: Binding {
                revision: 3,
                kdc: Some(transport),
            },
            kdc: Some(Kdc {
                host: "127.0.0.1".into(),
                port: 88,
                transport,
            }),
            realm: "EXAMPLE.TEST".into(),
            scope: Scope {
                cancelled: h.cancel.child_token(),
                sandbox: CancellationToken::new(),
                session: CancellationToken::new(),
                deadline: Instant::now() + Duration::from_secs(10),
            },
            ssh: Some(h.ssh()),
            tasks: TaskTracker::new(),
            owner: Arc::new(()),
            exchanges: 0,
            total: 0,
            awaiting_kdc_reply: false,
        }
    }

    async fn check<'a>(
        h: &'a Harness,
        generation: i64,
        outcome: &str,
        rfb_generation: Option<i64>,
    ) -> httpmock::Mock<'a> {
        h.api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/vnc/check", h.run))
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .json_body(json!({
                        "connectionId": CONNECTION,
                        "runnerIdentity": {
                            "runnerId": h.identity.runner_id(),
                            "heartbeatGeneration": 27
                        },
                        "expectedGeneration": 11,
                        "expectedTransport": rfb_generation.map_or_else(
                            || json!({"type":"direct"}),
                            |generation| json!({"type":"ssh","connectionId":CONNECTION,"generation":generation})
                        ),
                        "expectedCredentialRevision": 3,
                        "expectedKdcTransport": {
                            "type":"ssh", "connectionId":CONNECTION, "generation":generation
                        }
                    }));
                then.status(200).json_body(json!({"outcome":outcome}));
            })
            .await
    }

    async fn pin(h: &Harness) -> httpmock::Mock<'_> {
        h.api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/pin", h.run))
                    .json_body_includes(json!({"expectedGeneration":7}).to_string());
                then.status(200)
                    .json_body(json!({"outcome":"pinned","generation":8}));
            })
            .await
    }

    async fn receive(stream: &mut TcpStream) {
        assert_eq!(stream.read_u32().await.unwrap(), 4);
        let mut request = [0; 4];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(&request, b"test");
    }

    #[tokio::test]
    async fn first_kdc_ssh_pin_is_reauthorized_and_retained_for_later_exchanges() {
        let mut h = Harness::new(Reply::default()).await;
        let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
        let pin = pin(&h).await;
        let initial = check(&h, 7, "valid", None).await;
        let learned = check(&h, 8, "valid", None).await;
        let mut caller = caller(&h);
        for _ in 0..2 {
            let exchange = caller.exchange("EXAMPLE.TEST", b"test");
            let kdc = async {
                let mut stream = h.accept_forwarded().await;
                receive(&mut stream).await;
                stream.write_u32(5).await.unwrap();
                stream.write_all(b"reply").await.unwrap();
                stream.shutdown().await.unwrap();
            };
            let (reply, ()) = tokio::join!(exchange, kdc);
            assert_eq!(reply.unwrap().as_slice(), b"reply");
        }
        initial.assert_calls_async(1).await;
        learned.assert_calls_async(5).await;
        resolve.assert_calls_async(1).await;
        pin.assert_calls_async(1).await;
        learned.delete_async().await;
        let revoked = check(&h, 8, "configuration_changed", None).await;
        assert_eq!(
            caller.exchange("EXAMPLE.TEST", b"test").await.unwrap_err(),
            kerberos_worker::Error::Authority
        );
        revoked.assert_calls_async(1).await;
        drop(caller);
        h.shutdown().await;
    }

    #[tokio::test]
    async fn changed_kdc_grant_after_first_pin_denies_before_any_kdc_bytes() {
        let mut h = Harness::new(Reply::default()).await;
        let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
        let pin = pin(&h).await;
        let initial = check(&h, 7, "valid", None).await;
        let revoked = check(&h, 8, "unavailable", None).await;
        let mut caller = caller(&h);
        let exchange = caller.exchange("EXAMPLE.TEST", b"test");
        let kdc = async {
            let mut stream = h.accept_forwarded().await;
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        };
        let (result, ()) = tokio::join!(exchange, kdc);
        assert_eq!(result.unwrap_err(), kerberos_worker::Error::Authority);
        initial.assert_calls_async(1).await;
        revoked.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        pin.assert_calls_async(1).await;
        drop(caller);
        h.shutdown().await;
    }

    #[tokio::test]
    async fn shared_rfb_and_kdc_ssh_pin_preserves_both_authorized_routes() {
        let mut h = Harness::new(Reply::default()).await;
        let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
        let pin = pin(&h).await;
        let current = check(&h, 8, "valid", Some(8)).await;
        let mut caller = caller(&h);
        let original = caller.kdc.as_ref().unwrap().transport;
        let ssh = h.ssh();
        let open = ssh.open_direct_tcpip(
            CONNECTION.parse().unwrap(),
            7,
            "desktop.internal",
            5900,
            caller.scope.session.clone(),
            caller.scope.deadline,
        );
        let (rfb, rfb_peer) = tokio::join!(open, h.accept_forwarded());
        let rfb = rfb.unwrap();
        let attested = Transport::Ssh {
            connection: CONNECTION.parse().unwrap(),
            generation: rfb.generation(),
        };
        caller.rfb = attested;
        caller
            .binding
            .record_ssh_generation(&mut caller.kdc, original, attested);
        let exchange = caller.exchange("EXAMPLE.TEST", b"test");
        let kdc = async {
            let mut stream = h.accept_forwarded().await;
            receive(&mut stream).await;
            stream.write_u32(5).await.unwrap();
            stream.write_all(b"reply").await.unwrap();
            stream.shutdown().await.unwrap();
        };
        let (reply, ()) = tokio::join!(exchange, kdc);
        assert_eq!(reply.unwrap().as_slice(), b"reply");
        current.assert_calls_async(3).await;
        pin.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        drop(rfb);
        drop(rfb_peer);
        drop(caller);
        h.shutdown().await;
    }

    #[tokio::test]
    async fn authentication_deadline_after_full_kdc_send_is_delivery_unknown() {
        let mut h = Harness::new(Reply::default()).await;
        let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
        let pin = pin(&h).await;
        let initial = check(&h, 7, "valid", None).await;
        let learned = check(&h, 8, "valid", None).await;
        let mut caller = caller(&h);
        let (request_received, deadline) = tokio::sync::oneshot::channel();
        let authenticate = async {
            let result = {
                let exchange = caller.exchange("EXAMPLE.TEST", b"test");
                tokio::pin!(exchange);
                tokio::select! {
                    reply = &mut exchange => reply.map(|_| ()).map_err(rfb_client::Error::Kerberos),
                    received = deadline => {
                        received.unwrap();
                        Err(rfb_client::Error::Kerberos(kerberos_worker::Error::Deadline))
                    }
                }
            };
            caller.authentication_result(result)
        };
        let kdc = async {
            let mut stream = h.accept_forwarded().await;
            receive(&mut stream).await;
            // The enclosing authentication deadline wins only after the real
            // forwarded socket has received the complete request, without reply.
            request_received.send(()).unwrap();
            assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
        };
        let (result, ()) = tokio::join!(authenticate, kdc);
        assert_eq!(Failure::from(result.unwrap_err()), Failure::DeliveryUnknown);
        initial.assert_calls_async(1).await;
        learned.assert_calls_async(2).await;
        resolve.assert_calls_async(1).await;
        pin.assert_calls_async(1).await;
        drop(caller);
        h.shutdown().await;
    }

    #[tokio::test]
    async fn completed_kdc_reply_does_not_reclassify_a_later_authentication_deadline() {
        let mut h = Harness::new(Reply::default()).await;
        let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
        let pin = pin(&h).await;
        let initial = check(&h, 7, "valid", None).await;
        let learned = check(&h, 8, "valid", None).await;
        let mut caller = caller(&h);
        let exchange = caller.exchange("EXAMPLE.TEST", b"test");
        let kdc = async {
            let mut stream = h.accept_forwarded().await;
            receive(&mut stream).await;
            stream.write_u32(5).await.unwrap();
            stream.write_all(b"reply").await.unwrap();
            stream.shutdown().await.unwrap();
        };
        let (reply, ()) = tokio::join!(exchange, kdc);
        assert_eq!(reply.unwrap().as_slice(), b"reply");
        let error = caller
            .authentication_result::<()>(Err(rfb_client::Error::Kerberos(
                kerberos_worker::Error::Deadline,
            )))
            .unwrap_err();
        assert_eq!(Failure::from(error), Failure::TimedOut);
        initial.assert_calls_async(1).await;
        learned.assert_calls_async(2).await;
        resolve.assert_calls_async(1).await;
        pin.assert_calls_async(1).await;
        drop(caller);
        h.shutdown().await;
    }

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
