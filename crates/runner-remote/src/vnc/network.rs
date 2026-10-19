//! Bind the complete public DNS answer set to a single selected socket address.

pub(super) use crate::destination::{Network, PublicNetwork};
use crate::destination::{is_valid_host, select_public_address};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use super::Failure;

pub(super) fn validate_host(host: &str) -> Result<(), Failure> {
    if is_valid_host(host) {
        return Ok(());
    }
    Err(Failure::UnsafeDestination)
}

pub(super) async fn destination(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
) -> Result<SocketAddr, Failure> {
    destination_traced(
        network,
        host,
        port,
        &crate::diagnostics::trace::Trace::default(),
    )
    .await
}

pub(super) async fn destination_traced(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
    trace: &crate::diagnostics::trace::Trace,
) -> Result<SocketAddr, Failure> {
    use crate::diagnostics::trace::{Progress, Stage};
    validate_host(host).inspect_err(|_| trace.set(Stage::DestinationPolicy, Progress::Failed))?;
    if port == 0 {
        trace.set(Stage::DestinationPolicy, Progress::Failed);
        return Err(Failure::UnsafeDestination);
    }
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        trace.set(Stage::Dns, Progress::Running);
        let addresses = network
            .resolve(&format!("{host}."), port)
            .await
            .map_err(|_| {
                trace.set(Stage::Dns, Progress::Failed);
                Failure::Network
            })?;
        trace.set(Stage::Dns, Progress::Passed);
        addresses
    };
    let address = select_public_address(&addresses, port).ok_or_else(|| {
        trace.set(Stage::DestinationPolicy, Progress::Failed);
        Failure::UnsafeDestination
    })?;
    trace.set(Stage::DestinationPolicy, Progress::Passed);
    trace.selected(address.ip());
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::io;
    use tokio::net::TcpStream;

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
