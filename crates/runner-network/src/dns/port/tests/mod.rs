use super::*;

#[test]
fn reservation_holds_tcp_and_udp_while_alive() {
    let reservation = reserve_port().unwrap();
    let port = reservation.port();

    let tcp_error = std::net::TcpListener::bind(("0.0.0.0", port)).unwrap_err();
    assert_eq!(tcp_error.kind(), std::io::ErrorKind::AddrInUse);

    let udp_error = std::net::UdpSocket::bind(("0.0.0.0", port)).unwrap_err();
    assert_eq!(udp_error.kind(), std::io::ErrorKind::AddrInUse);
}

fn bind_tcp_udp_pair() -> std::io::Result<(ReservedTcpPort, std::net::UdpSocket)> {
    const MAX_PORT_PROBE_ATTEMPTS: usize = 64;

    let mut last_addr_in_use = None;
    for _ in 0..MAX_PORT_PROBE_ATTEMPTS {
        let tcp = ReservedTcpPort::bind(0)?;
        let port = tcp.port();
        match std::net::UdpSocket::bind(("0.0.0.0", port)) {
            Ok(udp) => return Ok((tcp, udp)),
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

#[test]
fn find_available_port_retries_when_udp_candidate_is_in_use() {
    let (busy_tcp, _busy_udp) = bind_tcp_udp_pair().unwrap();
    let busy_port = busy_tcp.port();
    let (free_tcp, free_udp) = bind_tcp_udp_pair().unwrap();
    let free_port = free_tcp.port();
    let mut free_udp = Some(free_udp);

    let reservation = reserve_port_from([Ok(busy_tcp), Ok(free_tcp)], |port| {
        if port == free_port {
            let udp = free_udp.take().unwrap();
            assert_eq!(udp.local_addr()?.port(), port);
            Ok(udp)
        } else {
            assert_eq!(port, busy_port);
            std::net::UdpSocket::bind(("0.0.0.0", port))
        }
    })
    .unwrap();

    assert_eq!(reservation.port(), free_port);
}
