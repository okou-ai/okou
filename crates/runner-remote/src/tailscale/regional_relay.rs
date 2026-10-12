//! Map-derived TCP/TLS/SDK DERP composition; no independent SDK dial or UDP.

use std::time::Duration;

use tokio_util::sync::CancellationToken;
use ts_derp::{IpUsage, ServerConnInfo, TlsValidationConfig};
use ts_http_util::{Client, EmptyBody, Upgraded};
use ts_keys::NodeKeyPair;

use super::{Failure, relay::Relay, relay_driver::Connector};

pub(super) trait Dial: Clone + 'static {
    type Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static;
    async fn tcp(&self, server: &ServerConnInfo) -> Result<Self::Io, Failure>;
    fn tls(&self, server: &ServerConnInfo) -> impl super::registration::Tls;
}

#[derive(Clone)]
pub(super) struct Verified(pub(super) super::resolver::Resolver);

impl Dial for Verified {
    type Io = tokio::net::TcpStream;
    async fn tcp(&self, server: &ServerConnInfo) -> Result<tokio::net::TcpStream, Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        let v4 = async {
            match server.ipv4 {
                IpUsage::Disable => std::future::pending().await,
                IpUsage::FixedAddr(ip) => {
                    tokio::net::TcpStream::connect((ip, server.https_port)).await
                }
                IpUsage::UseDns => dns(&self.0, server, false).await,
            }
        };
        let v6 = async {
            match server.ipv6 {
                IpUsage::Disable => std::future::pending().await,
                IpUsage::FixedAddr(ip) => {
                    tokio::net::TcpStream::connect((ip, server.https_port)).await
                }
                IpUsage::UseDns => dns(&self.0, server, true).await,
            }
        };
        // Both owned branches remain within the retained runtime; dropping a
        // losing resolver future does not release the node's physical receipt.
        tokio::pin!(v4, v6);
        let result = tokio::select! {
            result = &mut v4 => match result { Ok(io) => Ok(io), Err(_) => v6.await },
            result = &mut v6 => match result { Ok(io) => Ok(io), Err(_) => v4.await },
        };
        let io = result.map_err(|_| Failure::DomainFailed)?;
        io.set_nodelay(true).map_err(|_| Failure::DomainFailed)?;
        Ok(io)
    }

    fn tls(&self, _server: &ServerConnInfo) -> impl super::registration::Tls {
        super::registration::VerifiedTls
    }
}

async fn dns(
    resolver: &super::resolver::Resolver,
    server: &ServerConnInfo,
    ipv6: bool,
) -> std::io::Result<tokio::net::TcpStream> {
    let addresses = resolver
        .resolve(&server.hostname, server.https_port)
        .await
        .map_err(|_| std::io::Error::other("native resolver unavailable"))?;
    let mut tried = 0;
    for address in addresses
        .into_iter()
        .filter(|address| address.is_ipv6() == ipv6)
    {
        tried += 1;
        if tried > 16 {
            break;
        }
        if let Ok(io) = tokio::net::TcpStream::connect(address).await {
            return Ok(io);
        }
    }
    Err(std::io::ErrorKind::NotConnected.into())
}

pub(super) struct Regional<D> {
    pub(super) servers: Vec<ServerConnInfo>,
    pub(super) keys: NodeKeyPair,
    pub(super) cancelled: CancellationToken,
    pub(super) dial: D,
}

impl<D: Dial> Connector for Regional<D> {
    async fn connect(&mut self) -> Result<Relay<Upgraded>, Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        for server in &self.servers {
            if server.stun_only
                || (server.ipv4 == IpUsage::Disable && server.ipv6 == IpUsage::Disable)
            {
                continue;
            }
            let TlsValidationConfig::CommonName { common_name } = &server.tls_validation_config
            else {
                return Err(Failure::DomainFailed);
            };
            if !super::region_map::hostname(&server.hostname)
                || !super::region_map::hostname(common_name)
            {
                return Err(Failure::DomainFailed);
            }
            let attempt = async {
                let raw = self.dial.tcp(server).await?;
                let name = ts_tls_util::ServerName::try_from(common_name.clone())
                    .map_err(|_| Failure::DomainFailed)?;
                let mut url = ts_control::DEFAULT_CONTROL_SERVER.clone();
                url.set_host(Some(&server.hostname))
                    .map_err(|_| Failure::DomainFailed)?;
                url.set_port(Some(server.https_port))
                    .map_err(|_| Failure::DomainFailed)?;
                url.set_path("/derp");
                let tls = self.dial.tls(server);
                Relay::connect(raw, &self.keys, self.cancelled.clone(), |raw| async move {
                    use super::registration::Tls;
                    let io = tls
                        .connect(name, raw)
                        .await
                        .map_err(|_| Failure::DomainFailed)?;
                    let client = ts_http_util::http1::connect::<EmptyBody>(io)
                        .await
                        .map_err(|_| Failure::DomainFailed)?;
                    let request = ts_http_util::make_upgrade_req(&url, "DERP", None)
                        .map_err(|_| Failure::DomainFailed)?;
                    let response = client
                        .send(request)
                        .await
                        .map_err(|_| Failure::DomainFailed)?;
                    ts_http_util::do_upgrade(response)
                        .await
                        .map_err(|_| Failure::DomainFailed)
                })
                .await
            };
            let result = tokio::select! { biased;
                _ = self.cancelled.cancelled() => return Err(Failure::Cancelled),
                result = tokio::time::timeout(Duration::from_secs(10), attempt) => result.unwrap_or(Err(Failure::DomainFailed)),
            };
            if result.is_ok() {
                return result;
            }
        }
        Err(Failure::DomainFailed)
    }
}
