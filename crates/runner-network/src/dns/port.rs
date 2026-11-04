/// Reserved TCP/UDP port for the runner-managed dnsmasq process.
pub struct DnsPortReservation {
    port: u16,
    _tcp: ReservedTcpPort,
    _udp: std::net::UdpSocket,
}

impl DnsPortReservation {
    /// Return the reserved port.
    pub fn port(&self) -> u16 {
        self.port
    }
}

struct ReservedTcpPort {
    port: u16,
    _socket: tokio::net::TcpSocket,
}

impl ReservedTcpPort {
    fn bind(port: u16) -> std::io::Result<Self> {
        let socket = tokio::net::TcpSocket::new_v4()?;
        socket.bind(std::net::SocketAddr::from(([0, 0, 0, 0], port)))?;
        Ok(Self {
            port: socket.local_addr()?.port(),
            _socket: socket,
        })
    }

    fn port(&self) -> u16 {
        self.port
    }
}

/// Reserve an available port by binding to port 0 without listening.
///
/// Checks both TCP and UDP because dnsmasq binds both protocols.
pub fn reserve_port() -> std::io::Result<DnsPortReservation> {
    const MAX_PORT_PROBE_ATTEMPTS: usize = 64;

    reserve_port_from(
        (0..MAX_PORT_PROBE_ATTEMPTS).map(|_| ReservedTcpPort::bind(0)),
        |port| std::net::UdpSocket::bind(("0.0.0.0", port)),
    )
}

fn reserve_port_from<I, F>(
    tcp_candidates: I,
    mut bind_udp: F,
) -> std::io::Result<DnsPortReservation>
where
    I: IntoIterator<Item = std::io::Result<ReservedTcpPort>>,
    F: FnMut(u16) -> std::io::Result<std::net::UdpSocket>,
{
    let mut last_addr_in_use = None;
    for tcp in tcp_candidates {
        let tcp = tcp?;
        let port = tcp.port();
        match bind_udp(port) {
            Ok(udp) => {
                return Ok(DnsPortReservation {
                    port,
                    _tcp: tcp,
                    _udp: udp,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                last_addr_in_use = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_addr_in_use.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "could not find a port available for both TCP and UDP",
        )
    }))
}

#[cfg(test)]
mod tests;
