use std::{
    collections::BTreeMap,
    os::fd::AsRawFd,
    sync::{Arc, Mutex},
};

use tokio::io::{AsyncRead, AsyncWrite};
use ts_derp::{IpUsage, ServerConnInfo};

use crate::tailscale::{
    Failure,
    regional_relay::Dial,
    registration::Tls,
    tests::derp::fixture::{PausedTcp, Server, WriteGate},
};

#[derive(Clone)]
pub(crate) struct Relay {
    targets: Arc<BTreeMap<u16, Target>>,
    descriptors: Arc<Mutex<Vec<i32>>>,
}

struct Target {
    address: std::net::SocketAddr,
    tls: Arc<rustls::ClientConfig>,
    gate: Arc<WriteGate>,
}

#[derive(Clone)]
pub(super) struct FixtureTls(Arc<rustls::ClientConfig>);

impl Tls for FixtureTls {
    async fn connect<Io>(
        &self,
        name: ts_tls_util::ServerName<'static>,
        io: Io,
    ) -> std::io::Result<ts_tls_util::TlsStream<Io>>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        assert_eq!(
            name,
            ts_tls_util::ServerName::try_from("derp.synthetic.invalid").unwrap()
        );
        tokio_rustls::TlsConnector::from(Arc::clone(&self.0))
            .connect(name, io)
            .await
    }
}

impl Relay {
    pub(super) fn new(
        server: &Server,
        gate: Arc<WriteGate>,
        descriptors: Arc<Mutex<Vec<i32>>>,
    ) -> Self {
        Self {
            targets: Arc::new(BTreeMap::from([(
                server.address.port(),
                Target {
                    address: server.address,
                    tls: server.tls.clone().unwrap(),
                    gate,
                },
            )])),
            descriptors,
        }
    }

    pub(super) fn multiple(
        servers: &[&Server],
        gates: &[Arc<WriteGate>],
        descriptors: Arc<Mutex<Vec<i32>>>,
    ) -> Self {
        Self {
            targets: Arc::new(
                servers
                    .iter()
                    .zip(gates)
                    .map(|(server, gate)| {
                        (
                            server.address.port(),
                            Target {
                                address: server.address,
                                tls: server.tls.clone().unwrap(),
                                gate: Arc::clone(gate),
                            },
                        )
                    })
                    .collect(),
            ),
            descriptors,
        }
    }
}

impl Dial for Relay {
    type Io = PausedTcp;
    async fn tcp(&self, server: &ServerConnInfo) -> Result<Self::Io, Failure> {
        assert_eq!(server.hostname, "derp.synthetic.invalid");
        assert_eq!(
            server.ipv4,
            IpUsage::FixedAddr("127.0.0.1".parse().unwrap())
        );
        assert_eq!(server.ipv6, IpUsage::Disable);
        let target = self.targets.get(&server.https_port).unwrap();
        let socket = tokio::net::TcpStream::connect(target.address)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        self.descriptors.lock().unwrap().push(socket.as_raw_fd());
        Ok(PausedTcp::new(socket, Arc::clone(&target.gate)))
    }
    fn tls(&self, server: &ServerConnInfo) -> impl Tls {
        FixtureTls(Arc::clone(
            &self.targets.get(&server.https_port).unwrap().tls,
        ))
    }
}

pub(super) fn map(server: &Server) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "Node":{"ID":1,"StableID":"local","Name":"native.synthetic.ts.net.","Key":"MATCH-REQUEST","KeyExpiry":"0001-01-01T00:00:00Z","HomeDERP":1,"Addresses":["100.64.0.1/32","fd7a:115c:a1e0::1/128"]},
        "Peers":[],
        "DERPMap":{"Regions":{"1":{"RegionID":1,"RegionCode":"synthetic","RegionName":"Synthetic","Nodes":[{"Name":"1a","RegionID":1,"HostName":"derp.synthetic.invalid","DERPPort":server.address.port(),"IPv4":"127.0.0.1","IPv6":"none"}]}}}
    })).unwrap()
}
