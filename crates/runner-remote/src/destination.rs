//! Shared syntax and complete-answer policy for direct public destinations.

use async_trait::async_trait;
use runner_types::firewall_hostname_policy::{is_ipv4_literal_like, is_public_ip_address};
use std::{
    io,
    net::{IpAddr, SocketAddr},
};
use tokio::net::TcpStream;

#[async_trait]
pub(crate) trait Network: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream>;
}

pub(crate) struct PublicNetwork;

#[async_trait]
impl Network for PublicNetwork {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        Ok(tokio::net::lookup_host((host, port))
            .await?
            .take(65)
            .collect())
    }

    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        TcpStream::connect(address).await
    }
}

/// Syntax only: private literals can still be used by separately authorized routes.
pub(crate) fn is_valid_host(host: &str) -> bool {
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    // API supplies canonical ASCII names; never reinterpret legacy numeric,
    // scoped, URL, escaped, bracketed, or search-domain-relative input.
    if host.len() > 253
        || !host.is_ascii()
        || is_ipv4_literal_like(host.trim_end_matches('.'))
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return false;
    }
    true
}

/// Select the first address only after the entire bounded answer set is safe.
pub(crate) fn select_public_address(addresses: &[SocketAddr], port: u16) -> Option<SocketAddr> {
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses.iter().any(|address| {
            address.port() != port
                || !is_public_ip_address(address.ip())
                || matches!(address, SocketAddr::V6(v6) if v6.scope_id() != 0 || v6.flowinfo() != 0)
        })
    {
        return None;
    }
    addresses.first().copied()
}
