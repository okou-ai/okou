use super::{Relay, Server, WriteGate};
use crate::tailscale::{
    regional_relay::Dial,
    registration::Tls,
    tests::{derp::fixture::upgrade, fixture::bounded},
};
use std::{
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::net::{TcpSocket, TcpStream};
use ts_derp::{Client, IpUsage, ServerConnInfo, TlsValidationConfig};
use ts_keys::NodeKeyPair;

async fn retired_endpoint(server: Server, dial: &Relay) -> SocketAddr {
    let address = server.address;
    let info = ServerConnInfo {
        hostname: "derp.synthetic.invalid".into(),
        ipv4: IpUsage::FixedAddr("127.0.0.1".parse().unwrap()),
        ipv6: IpUsage::Disable,
        tls_validation_config: TlsValidationConfig::CommonName {
            common_name: "derp.synthetic.invalid".into(),
        },
        https_port: address.port(),
        stun_port: None,
        stun_only: false,
        supports_port_80: false,
    };
    let socket = bounded(dial.tcp(&info)).await.unwrap();
    let tls = bounded(
        dial.tls(&info)
            .connect("derp.synthetic.invalid".try_into().unwrap(), socket),
    )
    .await
    .unwrap();
    let upgraded = bounded(upgrade(address, tls)).await.unwrap();
    let key = NodeKeyPair::random();
    let (client, peer) =
        bounded(async { tokio::join!(Client::handshake(upgraded, &key), server.task) }).await;
    let (frames, client_key) = peer.unwrap();
    assert_eq!(client_key, key.public);
    let io = frames.into_inner().into_inner();
    let tls = io
        .downcast::<hyper_util::rt::TokioIo<tokio_rustls::server::TlsStream<TcpStream>>>()
        .unwrap()
        .io
        .into_inner();
    // Retire actual TCP without TIME_WAIT masking the endpoint's reservation.
    tls.get_ref().0.set_zero_linger().unwrap();
    drop(tls);
    drop(client.unwrap());
    address
}

#[tokio::test]
async fn retired_derp_endpoints_stay_reserved_until_the_last_regional_dialer_drops() {
    for count in [1, 2] {
        let mut servers = Vec::new();
        for _ in 0..count {
            servers.push(Server::secure().await);
        }
        let gates: Vec<_> = (0..count).map(|_| WriteGate::new()).collect();
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        let dial = if count == 1 {
            Relay::new(&servers[0], Arc::clone(&gates[0]), descriptors)
        } else {
            Relay::multiple(&servers.iter().collect::<Vec<_>>(), &gates, descriptors)
        };
        let retained = dial.clone();
        let mut addresses = Vec::new();
        for server in servers {
            addresses.push(retired_endpoint(server, &dial).await);
        }
        drop(dial);
        for address in &addresses {
            let replacement = TcpSocket::new_v4().unwrap();
            assert_eq!(
                replacement.bind(*address).unwrap_err().kind(),
                io::ErrorKind::AddrInUse
            );
            assert_eq!(
                bounded(TcpStream::connect(*address))
                    .await
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::ConnectionRefused
            );
        }
        drop(retained);
        for address in addresses {
            let replacement = TcpSocket::new_v4().unwrap();
            replacement.bind(address).unwrap();
            let listener = replacement.listen(1).unwrap();
            let (connected, accepted) =
                bounded(async { tokio::join!(TcpStream::connect(address), listener.accept()) })
                    .await;
            drop(connected.unwrap());
            drop(accepted.unwrap());
        }
    }
}
