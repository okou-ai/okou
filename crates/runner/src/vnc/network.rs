//! Bind the complete public DNS answer set to a single selected socket address.

use async_trait::async_trait;
use std::{
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use tokio::net::TcpStream;

use super::Failure;
use crate::firewall_hostname_policy::is_public_ip_address;

#[async_trait]
pub(super) trait Network: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream>;
}

pub(super) struct PublicNetwork;

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

pub(super) fn validate_host(host: &str) -> Result<(), Failure> {
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    // Match SSH policy: canonical ASCII only, with no legacy numeric, scoped,
    // URL, escaped, bracketed or search-domain-relative interpretations.
    if host.len() > 253
        || !host.is_ascii()
        || crate::firewall_hostname_policy::is_ipv4_literal_like(host.trim_end_matches('.'))
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
        return Err(Failure::UnsafeDestination);
    }
    Ok(())
}

pub(super) async fn destination(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
) -> Result<SocketAddr, Failure> {
    validate_host(host)?;
    if port == 0 {
        return Err(Failure::UnsafeDestination);
    }
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        network
            .resolve(&format!("{host}."), port)
            .await
            .map_err(|_| Failure::Network)?
    };
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses.iter().any(|address| {
            address.port() != port
                || !is_public_ip_address(address.ip())
                || matches!(address, SocketAddr::V6(v6) if v6.scope_id() != 0 || v6.flowinfo() != 0)
        })
    {
        return Err(Failure::UnsafeDestination);
    }
    addresses.first().copied().ok_or(Failure::UnsafeDestination)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Answers(Vec<SocketAddr>);

    #[async_trait]
    impl Network for Answers {
        async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
            assert_eq!(host, "desktop.example.test.");
            assert_eq!(port, 5900);
            Ok(self.0.clone())
        }

        async fn connect(&self, _: SocketAddr) -> io::Result<TcpStream> {
            panic!("destination policy must not create a socket")
        }
    }

    #[tokio::test]
    async fn destination_binds_absolute_dns_answers_without_changing_tls_identity() {
        let address: SocketAddr = "8.8.8.8:5900".parse().unwrap();
        let network = Arc::new(Answers(vec![address]));
        assert_eq!(
            destination(network, "desktop.example.test", 5900).await,
            Ok(address)
        );
        // A literal bypasses DNS and retains its exact requested port.
        assert_eq!(
            destination(Arc::new(Answers(Vec::new())), "8.8.4.4", 5999).await,
            Ok("8.8.4.4:5999".parse().unwrap())
        );
    }

    #[tokio::test]
    async fn every_dns_answer_must_be_public_unscoped_and_use_the_saved_port() {
        let public: SocketAddr = "8.8.8.8:5900".parse().unwrap();
        for answers in [
            Vec::new(),
            vec![public; 65],
            vec![public, "127.0.0.1:5900".parse().unwrap()],
            vec![public, "10.0.0.1:5900".parse().unwrap()],
            vec![public, "169.254.169.254:5900".parse().unwrap()],
            vec![public, "8.8.4.4:5999".parse().unwrap()],
            vec![public, "[::1]:5900".parse().unwrap()],
            vec![public, "[::ffff:127.0.0.1]:5900".parse().unwrap()],
            vec![
                public,
                SocketAddr::V6(std::net::SocketAddrV6::new(
                    "2001:4860:4860::8888".parse().unwrap(),
                    5900,
                    0,
                    1,
                )),
            ],
        ] {
            assert_eq!(
                destination(Arc::new(Answers(answers)), "desktop.example.test", 5900).await,
                Err(Failure::UnsafeDestination)
            );
        }
    }

    #[tokio::test]
    async fn unsafe_literal_and_ambiguous_hosts_never_reach_dns() {
        for host in [
            "",
            "127.1",
            "2130706433",
            "0x7f000001",
            "127.0.0.1",
            "localhost.",
            "https://desktop.example.test",
            "desktop.example.test:5900",
            "desktop.example.test/path",
            "[2001:4860:4860::8888]",
            "fe80::1%eth0",
            "desktop..example.test",
            "-desktop.example.test",
            "desktop.example.test ",
            "d\u{e9}sktop.example.test",
        ] {
            assert_eq!(
                destination(Arc::new(Answers(Vec::new())), host, 5900).await,
                Err(Failure::UnsafeDestination),
                "host must be refused: {host}"
            );
        }
    }
}
