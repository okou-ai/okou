use super::super::tests::{Signal, wait_for_event};
use super::*;
use std::os::unix::net::UnixDatagram;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

fn frame(v6: bool, source: u16, destination: u16) -> Vec<u8> {
    let mut ip = if v6 { vec![0u8; 40] } else { vec![0u8; 24] };
    let mut tcp = vec![0u8; 24];
    tcp[..2].copy_from_slice(&source.to_be_bytes());
    tcp[2..4].copy_from_slice(&destination.to_be_bytes());
    tcp[4..8].copy_from_slice(&123u32.to_be_bytes());
    tcp[8..12].copy_from_slice(&456u32.to_be_bytes());
    tcp[12] = 0x60; // TCP options are part of the retained header.
    tcp[13] = 0x14; // ACK + RST.
    tcp[14..16].copy_from_slice(&1024u16.to_be_bytes());
    let body = b"private-payload-must-never-be-delivered";
    if v6 {
        ip[0] = 0x60;
        ip[4..6].copy_from_slice(&((tcp.len() + body.len()) as u16).to_be_bytes());
        ip[6] = 6;
        ip[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        ip[24..40].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
    } else {
        ip[0] = 0x46; // IPv4 options, deliberately not the usual 20B header.
        let total = (ip.len() + tcp.len() + body.len()) as u16;
        ip[2..4].copy_from_slice(&total.to_be_bytes());
        ip[9] = 6;
        ip[12..16].copy_from_slice(&Ipv4Addr::LOCALHOST.octets());
        ip[16..20].copy_from_slice(&Ipv4Addr::LOCALHOST.octets());
    }
    ip.extend(tcp);
    ip.extend(body);
    ip
}

#[test]
fn kernel_filter_delivers_only_registered_tcp_headers_in_both_directions() {
    // SO_ATTACH_FILTER on a local datagram socket exercises the actual kernel
    // filter without raw-socket privileges or observing host traffic.
    let (send, receive) = UnixDatagram::pair().unwrap();
    receive.set_nonblocking(true).unwrap();
    let receive: OwnedFd = receive.into();
    let pairs: Vec<_> = (1..=MAX_CONNECTIONS as u16).map(|p| (p, 443)).collect();
    install_filter(&receive, &pairs).unwrap();
    let socket = UnixDatagram::from(receive);
    for v6 in [false, true] {
        for (source, destination) in [(128, 443), (443, 1)] {
            let packet = frame(v6, source, destination);
            send.send(&packet).unwrap();
            let mut bytes = [0u8; 512];
            let size = socket.recv(&mut bytes).unwrap();
            assert_eq!(size, if v6 { 64 } else { 48 });
            let parsed = parse(&bytes[..size], 1234).unwrap();
            assert_eq!(parsed.source.port(), source);
            assert_eq!(parsed.destination.port(), destination);
            assert_eq!(parsed.payload_bytes, 39);
            assert_eq!(parsed.flags, 0x14);
            assert_eq!(parsed.sequence, 123);
            assert_eq!(parsed.acknowledgment, 456);
            assert!(!format!("{parsed:?}").contains("private-payload"));
        }
        send.send(&frame(v6, 999, 443)).unwrap();
        assert_eq!(
            socket.recv(&mut [0; 512]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let mut unsupported = frame(v6, 1, 443);
        if v6 {
            unsupported[6] = 0;
        } else {
            unsupported[6] = 0x20;
        }
        send.send(&unsupported).unwrap();
        assert_eq!(
            socket.recv(&mut [0; 512]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(parse(&unsupported, 0).is_none());
    }
    let fd: OwnedFd = socket.into();
    install_filter(&fd, &[]).unwrap();
    let socket = UnixDatagram::from(fd);
    send.send(&frame(false, 1, 443)).unwrap();
    assert_eq!(
        socket.recv(&mut [0; 512]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[test]
fn recvmsg_retains_kernel_timestamp_and_parsed_headers_only() {
    let (send, receiver) = UnixDatagram::pair().unwrap();
    let fd: OwnedFd = receiver.into();
    install_filter(&fd, &[(1234, 443)]).unwrap();
    set_option(&fd, libc::SOL_SOCKET, libc::SO_TIMESTAMPNS, &1i32).unwrap();
    let before = unix_ns();
    send.send(&frame(false, 1234, 443)).unwrap();
    let packet = receive(&fd).unwrap().unwrap();
    assert!(packet.unix_ns >= before && packet.unix_ns <= unix_ns());
    assert_eq!(packet.payload_bytes, 39);
    assert_eq!(packet.flags, 0x14);
    assert!(!format!("{packet:?}").contains("private-payload"));
}

#[test]
fn packet_history_rejects_unowned_queued_and_repeated_tuples_and_bounds_storage() {
    let mut state = State::default();
    let tuple = Tuple {
        local: "127.0.0.1:1234".parse().unwrap(),
        remote: "127.0.0.1:443".parse().unwrap(),
    };
    state.register(tuple, Arc::from("test"));
    let mut packet = parse(&frame(false, 1234, 443), unix_ns()).unwrap();
    packet.source.set_port(1235);
    assert!(
        state.record(packet.clone()).is_none(),
        "another process using the same API IP"
    );
    packet.source.set_port(1234);
    packet.unix_ns = 0;
    assert!(
        state.record(packet.clone()).is_none(),
        "queued before registration"
    );
    packet.unix_ns = unix_ns();
    for _ in 0..MAX_PACKETS + 7 {
        assert!(state.record(packet.clone()).is_some());
    }
    assert_eq!(state.packets.len(), MAX_PACKETS);
    assert_eq!(state.evicted_packets, 7);
    assert!(state.connections.front().unwrap().last_payload.is_some());
    state.register(tuple, Arc::from("test"));
    assert!(state.connections.back().unwrap().ambiguous);
    assert!(
        state.record(packet.clone()).is_none(),
        "tuple reuse must not choose a generation"
    );
    for port in 2000..2000 + MAX_CONNECTIONS as u16 {
        state.register(
            Tuple {
                local: SocketAddr::new(tuple.local.ip(), port),
                ..tuple
            },
            Arc::from("test"),
        );
    }
    assert_eq!(state.connections.len(), MAX_CONNECTIONS);
    assert_eq!(state.evicted_connections, 1);
    assert!(
        state.record(packet).is_none(),
        "evicted tuple has no attributable history"
    );
    let mut state = State::default();
    state.register(tuple, Arc::from("test"));
    let mut syn = parse(&frame(false, 1234, 443), unix_ns()).unwrap();
    syn.flags = 2;
    assert!(state.record(syn).is_none());
    assert!(
        state.connections.front().unwrap().ambiguous,
        "a later SYN may be guest/NAT port reuse"
    );
    let data = parse(&frame(false, 1234, 443), unix_ns()).unwrap();
    assert!(
        state.record(data).is_none(),
        "do not attach the replacement TCP stream"
    );
}

#[test]
fn truncated_invalid_and_non_tcp_frames_produce_no_metadata() {
    for v6 in [false, true] {
        let mut bytes = frame(v6, 1234, 443);
        let header = if v6 { 64 } else { 48 };
        for length in 0..header {
            assert!(parse(&bytes[..length], 0).is_none());
        }
        bytes[if v6 { 6 } else { 9 }] = 17;
        assert!(parse(&bytes, 0).is_none());
    }
}

#[tokio::test]
async fn recorder_retains_packets_observed_between_failure_and_incident_admission() {
    let captured = CapturedEvents::default();
    let (signal, mut events) = mpsc::channel(128);
    let dispatch = Dispatch::new(
        tracing_subscriber::registry()
            .with(captured.clone())
            .with(Signal(signal)),
    );
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            capture_status: "ready",
            ..State::default()
        }),
        changed: Notify::new(),
        dispatch: dispatch.clone(),
        dropped_updates: AtomicU64::new(0),
    });
    shared.state().register(
        Tuple {
            local: "127.0.0.1:1234".parse().unwrap(),
            remote: "127.0.0.1:443".parse().unwrap(),
        },
        Arc::from("test"),
    );
    let (send, receiver) = UnixDatagram::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    let fd: OwnedFd = receiver.into();
    install_filter(&fd, &[(1234, 443)]).unwrap();
    set_option(&fd, libc::SOL_SOCKET, libc::SO_TIMESTAMPNS, &1i32).unwrap();
    // SAFETY: the owned descriptor remains open and stable for this AsyncFd.
    let socket =
        unsafe { AsyncFd::register_with_interest(fd, tokio::io::Interest::READABLE) }.unwrap();
    let (faults, receiver) = mpsc::channel(MAX_FAULTS);
    let task =
        tokio::spawn(record(Arc::clone(&shared), socket, receiver).with_subscriber(dispatch));
    let owner = TransportDiagnostics(Arc::new(Owner {
        shared,
        faults,
        task: Some(task),
    }));
    // Model the real handoff: failure creates an incident, then the recorder
    // reads the queued RST before selecting the incident notification.
    let fault = Fault {
        request_id: "handoff".into(),
        connection_id: 1,
        deadline: TimerInstant::now() + AFTER_FAILURE,
        observed_at: Instant::now(),
    };
    send.send(&frame(false, 1234, 443)).unwrap();
    // Reading the packet triggers this filter refresh; no private record hook
    // or scheduler timing is needed to establish the read's completion.
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("message").map(String::as_str) == Some("API TCP capture filter updated")
    })
    .await;
    owner.0.faults.send(fault).await.unwrap();
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("message").map(String::as_str) == Some("API TCP evidence started")
    })
    .await;
    let entries = captured.entries();
    let packet = entries
        .iter()
        .find(|e| e.fields.get("message").map(String::as_str) == Some("API TCP packet metadata"))
        .expect("the RST read during handoff belongs to this incident");
    assert_eq!(packet.fields["client_request_id"], "handoff");
    assert_eq!(packet.fields["flags"], "20");
    assert_eq!(packet.fields["phase"], "after_failure_observation");
}

#[tokio::test]
async fn recorder_bounds_fault_output_finishes_its_window_and_aborts_with_its_owner() {
    let captured = CapturedEvents::default();
    let (signal, mut events) = mpsc::channel(128);
    let subscriber = tracing_subscriber::registry()
        .with(captured.clone())
        .with(Signal(signal));
    let dispatch = Dispatch::new(subscriber);
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            capture_status: "ready",
            ..State::default()
        }),
        changed: Notify::new(),
        dispatch: dispatch.clone(),
        dropped_updates: AtomicU64::new(0),
    });
    let tuple = Tuple {
        local: "127.0.0.1:1234".parse().unwrap(),
        remote: "127.0.0.1:443".parse().unwrap(),
    };
    shared.state().register(tuple, Arc::from("test"));
    let (send, receiver) = UnixDatagram::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    let fd: OwnedFd = receiver.into();
    install_filter(&fd, &[(1234, 443)]).unwrap();
    set_option(&fd, libc::SOL_SOCKET, libc::SO_TIMESTAMPNS, &1i32).unwrap();
    // SAFETY: the owned descriptor remains stable and open for this AsyncFd.
    let socket =
        unsafe { AsyncFd::register_with_interest(fd, tokio::io::Interest::READABLE) }.unwrap();
    let (faults, receiver) = mpsc::channel(MAX_FAULTS);
    let task =
        tokio::spawn(record(Arc::clone(&shared), socket, receiver).with_subscriber(dispatch));
    let owner = TransportDiagnostics(Arc::new(Owner {
        shared: Arc::clone(&shared),
        faults,
        task: Some(task),
    }));
    let make_fault = |name: &str| Fault {
        request_id: name.into(),
        connection_id: 1,
        deadline: TimerInstant::now() + AFTER_FAILURE,
        observed_at: Instant::now(),
    };
    owner.0.faults.send(make_fault("first")).await.unwrap();
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("message").map(String::as_str) == Some("API TCP evidence started")
    })
    .await;
    let bulk_limit = MAX_AFTER - RESERVED_CLOSE_PACKETS;
    let bulk_limit_label = bulk_limit.to_string();
    let mut bulk = frame(false, 1234, 443);
    bulk[24 + 13] = 0x18;
    for _ in 0..bulk_limit + 1 {
        send.send(&bulk).unwrap();
    }
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("client_request_id").map(String::as_str) == Some("first")
            && e.fields.get("bulk_packet_limit") == Some(&bulk_limit_label)
    })
    .await;
    send.send(&frame(false, 1234, 443)).unwrap();
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("flags").map(String::as_str) == Some("20")
    })
    .await;
    owner.0.faults.send(make_fault("burst")).await.unwrap();
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("detail_status").map(String::as_str) == Some("rate_limited")
    })
    .await;
    raw_http_test_support::clock::advance_timer_phase(AFTER_FAILURE + Duration::from_secs(1)).await;
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("ended_by_deadline").map(String::as_str) == Some("true")
    })
    .await;
    let entries = captured.entries();
    assert_eq!(
        entries
            .iter()
            .filter(
                |e| e.fields.get("message").map(String::as_str) == Some("API TCP packet metadata")
            )
            .count(),
        bulk_limit + 1
    );
    let ended = entries
        .iter()
        .find(|e| e.fields.get("message").map(String::as_str) == Some("API TCP evidence ended"))
        .unwrap();
    assert_eq!(ended.fields["after_truncated"], "true");
    assert_eq!(ended.fields["after_seen"], (bulk_limit + 2).to_string());
    owner
        .0
        .faults
        .send(make_fault("interrupted"))
        .await
        .unwrap();
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("client_request_id").map(String::as_str) == Some("interrupted")
            && e.fields.get("message").map(String::as_str) == Some("API TCP evidence started")
    })
    .await;
    // Exhaust the close quota while ordinary data still has room. Reporting
    // this as a bulk limit would give the wrong reason for missing FIN/RSTs.
    for _ in 0..RESERVED_CLOSE_PACKETS {
        send.send(&frame(false, 1234, 443)).unwrap();
    }
    let partial_bulk = bulk_limit - RESERVED_CLOSE_PACKETS;
    for _ in 0..partial_bulk {
        send.send(&bulk).unwrap();
    }
    send.send(&frame(false, 1234, 443)).unwrap();
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("client_request_id").map(String::as_str) == Some("interrupted")
            && e.fields.contains_key("bulk_packet_limit")
    })
    .await;
    let entries = captured.entries();
    let limit = entries
        .iter()
        .find(|e| {
            e.fields.get("client_request_id").map(String::as_str) == Some("interrupted")
                && e.fields.contains_key("bulk_packet_limit")
        })
        .unwrap();
    assert_eq!(
        limit.fields["message"],
        "API TCP evidence packet limit reached"
    );
    assert_eq!(
        limit.fields["close_packet_limit"],
        RESERVED_CLOSE_PACKETS.to_string()
    );
    let after: Vec<_> = entries
        .iter()
        .filter(|e| {
            e.fields.get("client_request_id").map(String::as_str) == Some("interrupted")
                && e.fields.get("phase").map(String::as_str) == Some("after_failure_observation")
        })
        .collect();
    assert_eq!(after.len(), RESERVED_CLOSE_PACKETS + partial_bulk);
    assert_eq!(
        after.iter().filter(|e| e.fields["flags"] == "20").count(),
        RESERVED_CLOSE_PACKETS
    );
    let weak = Arc::downgrade(&owner.0);
    drop(owner);
    assert!(
        weak.upgrade().is_none(),
        "the background recorder must not retain its owner"
    );
    wait_for_event(&captured, &mut events, |e| {
        e.fields.get("client_request_id").map(String::as_str) == Some("interrupted")
            && e.fields.get("ended_by_deadline").map(String::as_str) == Some("false")
    })
    .await;
    assert!(entries.iter().all(|e| e.level == tracing::Level::INFO));
}
