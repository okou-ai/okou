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
