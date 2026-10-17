//! Native RFB and KDC own the actual protective stream and its consumer leases.

use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use api_contracts::generated::types::runners::vnc::{
    ResolveResponseResolvedTransportSecurityQemuX509GssapiKdcTransport as KdcRoute,
    ResolveResponseResolvedTransportTransport as Route,
    ResolveResponseResolvedTransportTransportCloudflareAccessCredentials as Credentials,
    ResolveResponseResolvedTransportTransportCloudflareAccessOriginTlsTrust as OriginTrust,
};
use rustls::{ClientConfig, pki_types::ServerName};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_rustls::{TlsConnector, client::TlsStream};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    Failure, Scope, VncRuntime,
    authority::Transport,
    network,
    sessions::{Run, StartEvidence},
};
use crate::{cloudflare, tailscale};

#[derive(Clone)]
pub(super) enum Configuration {
    Cloudflare {
        credentials: Arc<Credentials>,
        origin: Option<Origin>,
    },
    Tailscale(tailscale::Configuration),
}

#[derive(Clone)]
pub(super) struct Origin {
    name: ServerName<'static>,
    tls: Arc<ClientConfig>,
}

pub(super) fn parse(route: Route) -> Result<(Transport, Option<Configuration>), Failure> {
    let (id, generation) = match &route {
        Route::CloudflareAccess {
            config_id,
            generation,
            ..
        }
        | Route::Tailscale {
            config_id,
            generation,
            ..
        } => (config_id, *generation),
        _ => return Err(Failure::Authority),
    };
    let configuration = Uuid::parse_str(id).map_err(|_| Failure::Authority)?;
    if configuration.is_nil() || !(1..=i64::from(i32::MAX)).contains(&generation) {
        return Err(Failure::Authority);
    }
    match route {
        Route::CloudflareAccess {
            credentials,
            origin_tls,
            ..
        } => {
            // Validate private header values before any network or authentication.
            if !cloudflare::valid_header(credentials.client_id.expose())
                || !cloudflare::valid_header(credentials.client_secret.expose())
            {
                return Err(Failure::InvalidCredential);
            }
            let origin = origin_tls
                .map(|origin| {
                    network::validate_host(&origin.server_name)?;
                    let name =
                        ServerName::try_from(origin.server_name).map_err(|_| Failure::Authority)?;
                    let roots = match origin.trust {
                        OriginTrust::System => rfb_client::TrustRoots::public_roots(),
                        OriginTrust::CustomCa { ca_bundle } => {
                            super::authority::custom_roots(Zeroizing::new(ca_bundle))?
                        }
                    };
                    let tls = roots
                        .into_config()
                        .map_err(|_| Failure::InvalidCredential)?;
                    Ok::<_, Failure>(Origin { name, tls })
                })
                .transpose()?;
            Ok((
                Transport::Cloudflare {
                    configuration,
                    generation,
                },
                Some(Configuration::Cloudflare {
                    credentials: Arc::new(credentials),
                    origin,
                }),
            ))
        }
        Route::Tailscale {
            credentials, tags, ..
        } => {
            let native = tailscale::Configuration::new(
                configuration,
                generation,
                credentials.client_id,
                credentials.client_secret,
                tags,
            )
            .map_err(|_| Failure::InvalidCredential)?;
            Ok((
                Transport::Tailscale {
                    configuration,
                    generation,
                },
                Some(Configuration::Tailscale(native)),
            ))
        }
        _ => Err(Failure::Authority),
    }
}

/// KDC credentials are moved directly into the shared private carrier format.
/// A KDC has no origin-TLS field and cannot inherit the RFB protection wrapper.
pub(super) fn parse_kdc(
    route: KdcRoute,
    ssh: bool,
) -> Result<(Transport, Option<Configuration>), Failure> {
    let route = match route {
        KdcRoute::Direct => Route::Direct,
        KdcRoute::Ssh {
            connection_id,
            generation,
        } => Route::Ssh {
            connection_id,
            generation,
        },
        KdcRoute::CloudflareAccess {
            config_id,
            generation,
            credentials,
        } => Route::CloudflareAccess {
            config_id,
            generation,
            credentials: Credentials {
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
            },
            origin_tls: None,
        },
        KdcRoute::Tailscale {
            config_id,
            generation,
            credentials,
            tags,
        } => Route::Tailscale {
            config_id,
            generation,
            credentials: Credentials {
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
            },
            tags,
        },
    };
    super::authority::parse_transport(route, ssh)
}

/// Admission is separate from protection: the connected stream is checked again.
pub(super) fn raw_route_allowed(
    host: &str,
    route: Transport,
    native: Option<&Configuration>,
) -> bool {
    match (route, native) {
        (Transport::Ssh { .. }, None) => matches!(host, "127.0.0.1" | "::1"),
        (Transport::Tailscale { .. }, Some(Configuration::Tailscale(_))) => true,
        (
            Transport::Cloudflare { .. },
            Some(Configuration::Cloudflare {
                origin: Some(_), ..
            }),
        ) => true,
        _ => false,
    }
}

enum Io {
    Peer(tailscale::Stream),
    Access(Box<dyn cloudflare::ByteIo + Sync>),
    Origin(Box<TlsStream<Box<dyn cloudflare::ByteIo + Sync>>>),
}

pub(super) struct Stream {
    io: Io,
    cancellation: Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
    cancel: CancellationToken,
    node: Option<Arc<tailscale::Node>>,
    _owner: Arc<dyn kerberos_worker::WorkOwner>,
}

impl Stream {
    pub(super) fn node(&self) -> Option<Arc<tailscale::Node>> {
        self.node.clone()
    }
    pub(super) fn guard(&self) -> Option<tailscale::StreamGuard> {
        match &self.io {
            Io::Peer(stream) => Some(stream.guard()),
            _ => None,
        }
    }
    pub(super) fn require_raw_protection(&self) -> Result<(), Failure> {
        if self.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        match &self.io {
            Io::Peer(peer) if peer.is_live() => Ok(()),
            Io::Origin(_) => Ok(()),
            _ => Err(Failure::Authority),
        }
    }

    fn check(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.cancellation.as_mut().poll(cx).is_ready() {
            Err(closed())
        } else {
            Ok(())
        }
    }

    fn io(&mut self) -> &mut dyn cloudflare::ByteIo {
        match &mut self.io {
            Io::Peer(stream) => stream,
            Io::Access(stream) => stream.as_mut(),
            Io::Origin(stream) => stream.as_mut(),
        }
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check(cx)?;
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let mut bytes = [0; 4096];
        let count = out.remaining().min(bytes.len());
        let mut buffer = ReadBuf::new(bytes.get_mut(..count).ok_or_else(closed)?);
        match Pin::new(self.io()).poll_read(cx, &mut buffer) {
            Poll::Ready(Ok(())) => {
                self.check(cx)?;
                out.put_slice(buffer.filled());
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check(cx)?;
        Pin::new(self.io()).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(self.io()).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(self.io()).poll_shutdown(cx)
    }
}

pub(super) struct Dialer {
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) native: Arc<crate::native::Run>,
    pub(super) tasks: tokio_util::task::TaskTracker,
}

impl Run {
    pub(super) fn native_dialer(&self) -> Dialer {
        Dialer {
            runtime: Arc::clone(&self.runtime),
            native: Arc::clone(&self.native),
            tasks: self.tasks.clone(),
        }
    }
}

impl Dialer {
    pub(super) async fn dial(
        &self,
        configuration: Configuration,
        host: &str,
        port: u16,
        scope: &Scope,
        owner: Arc<dyn kerberos_worker::WorkOwner>,
        evidence: &mut StartEvidence,
    ) -> Result<Stream, Failure> {
        let (io, node) = match configuration {
            Configuration::Tailscale(configuration) => {
                let key = configuration.key();
                let node = self
                    .native
                    .registry
                    .acquire_configured(configuration, |configuration, journal| {
                        #[cfg(test)]
                        if let Some(services) = self
                            .runtime
                            .native_services
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .as_ref()
                        {
                            return services.work(configuration, journal);
                        }
                        tailscale::work(configuration, journal)
                    })
                    .map_err(native_failure)?;
                let trace = tailscale::evidence::Trace::new(self.native.diagnostics.enabled());
                let mut source = node.diagnostic_source(key);
                source.connection = Some(trace.clone());
                evidence.retain_native(source);
                scope.check()?;
                node.start();
                let stream = scope
                    .wait(node.dial_retained(
                        host,
                        port,
                        tailscale::Lease::new(owner.clone()),
                        trace,
                    ))
                    .await?
                    .map_err(native_failure)?;
                (Io::Peer(stream), Some(node))
            }
            Configuration::Cloudflare {
                credentials,
                origin,
            } => {
                let configuration = cloudflare::Configuration::new(
                    host,
                    u64::from(port),
                    credentials.client_id.expose(),
                    credentials.client_secret.expose(),
                )
                .ok_or(Failure::Authority)?;
                let network = Arc::clone(&self.runtime.network);
                let target = host.to_owned();
                let held = Arc::clone(&owner);
                let resolve = self.tasks.spawn(async move {
                    let _owner = held;
                    network::destination(network, &target, port).await
                });
                let address = scope.wait(resolve).await?.map_err(|_| Failure::Network)??;
                let socket = scope
                    .wait(self.runtime.network.connect(address))
                    .await?
                    .map_err(|_| Failure::Network)?;
                let tls = crate::tls::client_config().map_err(|_| Failure::Network)?;
                #[cfg(test)]
                let tls = self
                    .runtime
                    .access_tls
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or(tls);
                let trace =
                    crate::diagnostics::trace::Trace::new(self.native.diagnostics.enabled());
                let (stream, _) = scope
                    .wait(cloudflare::connect(socket, configuration, tls, &trace))
                    .await?
                    .map_err(|failure| match failure {
                        cloudflare::Failure::Tls => Failure::AuthenticationFailed,
                        cloudflare::Failure::Network => Failure::Network,
                        cloudflare::Failure::Rejected => Failure::AuthenticationFailed,
                        cloudflare::Failure::Protocol => Failure::Protocol,
                    })?;
                let stream: Box<dyn cloudflare::ByteIo + Sync> = Box::new(stream);
                let io = match origin {
                    Some(origin) => {
                        let stream = scope
                            .wait(TlsConnector::from(origin.tls).connect(origin.name, stream))
                            .await?
                            .map_err(|_| Failure::AuthenticationFailed)?;
                        Io::Origin(Box::new(stream))
                    }
                    None => Io::Access(stream),
                };
                (io, None)
            }
        };
        scope.check()?;
        Ok(Stream {
            io,
            cancellation: Box::pin(scope.session.clone().cancelled_owned()),
            cancel: scope.session.clone(),
            node,
            _owner: owner,
        })
    }
}

fn closed() -> io::Error {
    io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "native VNC stream retired",
    )
}

fn native_failure(failure: tailscale::Failure) -> Failure {
    match failure {
        tailscale::Failure::ResourceExhausted => Failure::ResourceExhausted,
        tailscale::Failure::Cancelled => Failure::Cancelled,
        _ => Failure::Network,
    }
}

pub(super) fn profiles()
-> Vec<api_contracts::generated::types::runners::vnc::ResolveRequestSupportedProfile> {
    use api_contracts::generated::types::runners::vnc::{
        ResolveRequestSupportedProfile as Profile, ResolveRequestSupportedProfileAuthMethod as A,
        ResolveRequestSupportedProfileSecurityType as S,
        ResolveRequestSupportedProfileTransportType as R,
    };
    let mut profiles = Vec::with_capacity(36);
    for transport_type in [R::CloudflareAccess, R::Tailscale] {
        for (auth_method, security_type) in [
            (A::None, S::X509None),
            (A::VncPassword, S::X509Vnc),
            (A::UsernamePassword, S::X509Plain),
            (A::QemuScramSha256, S::QemuX509Sasl),
            (A::ClientCertificate, S::X509None),
            (A::ClientCertificateVncPassword, S::X509Vnc),
            (A::VncPassword, S::AppleVncPassword),
            (A::AppleDhUsernamePassword, S::AppleDh),
            (A::AppleSrpUsernamePassword, S::AppleSrp),
            (A::AppleRsaSrpUsernamePassword, S::AppleRsaSrp),
        ] {
            profiles.push(Profile {
                auth_method,
                security_type,
                transport_type,
                kdc_transport_type: None,
            });
        }
        for security_type in [
            S::RsaAesRa2,
            S::RsaAesRa2256,
            S::RsaAesRa2ne,
            S::RsaAesRa2ne256,
        ] {
            for auth_method in [A::RsaAesPassword, A::RsaAesUsernamePassword] {
                profiles.push(Profile {
                    auth_method,
                    security_type,
                    transport_type,
                    kdc_transport_type: None,
                });
            }
        }
    }
    profiles
}
