//! Real native worker contention, driven through guest RPC and external peers.
use super::super::{
    harness::{CONNECTION, Harness, TestRun, bounded},
    peer::{Event, Peer},
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
    task::JoinSet,
};
use tokio_util::task::AbortOnDropHandle;

const SECOND: &str = "27666a2c-3eec-420b-b62d-2076938b9b44";
const ORDINARY: &str = "c58d78be-32b8-43c6-9863-412ba303176c";
const QUEUED: &str = "1b35951c-d063-424f-af4b-1a85e90545c8";

fn kerberos_response(h: &Harness) -> Value {
    json!({
        "outcome":"resolved_kerberos","host":"vnc.example.test","port":5900,
        "generation":7,"credentialRevision":3,"serverName":"vnc.example.test",
        "transport":{"type":"direct"},
        "authentication":{"method":"qemu_kerberos_password","password":"synthetic-password",
            "initiator":{"realm":"CONTENTION.INVALID","components":["operator"]}},
        "security":{"type":"qemu_x509_gssapi",
            "trust":{"mode":"custom_ca","caBundle":h.peer.ca},
            "service":{"realm":"CONTENTION.INVALID","components":["vnc","desktop"]},
            "kdc":{"host":"93.184.216.35","port":88,"transport":{"type":"direct"},
                "ticketLifetimeSeconds":1200,"renewableLifetimeSeconds":0}}
    })
}

#[tokio::test]
async fn unadvertised_kerberos_handoff_is_refused_before_network() {
    let mut h = Harness::new().await;
    let resolve = h
        .resolve_profiles(CONNECTION, kerberos_response(&h), false)
        .await;
    assert_eq!(
        h.start("shared").await.result(),
        &json!({"outcome":"failed","reason":"authority_failure"})
    );
    resolve.assert_calls_async(1).await;
    assert!(h.network.attempts.lock().unwrap().is_empty());
    h.run.shutdown().await;
}

#[tokio::test]
async fn terminal_resolve_outcomes_do_not_begin_another_resolution() {
    for (response, reason) in [
        (json!({"outcome":"unavailable"}), "unavailable"),
        (json!({"outcome":"invalid"}), "authority_failure"),
    ] {
        let mut h = Harness::new().await;
        let resolve = h.resolve_profiles(CONNECTION, response, false).await;
        assert_eq!(
            h.start("shared").await.result(),
            &json!({"outcome":"failed","reason":reason})
        );
        resolve.assert_calls_async(1).await;
        h.run.shutdown().await;
    }
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; native Kerberos matrix"]
async fn kerberos_negotiation_uses_the_final_authority_response_without_another_retry() {
    for (response, reason) in [
        (json!({"outcome":"unavailable"}), "unavailable"),
        (
            json!({"outcome":"unsupported_profile"}),
            "unsupported_profile",
        ),
    ] {
        let mut h = Harness::new().await;
        let (ordinary, native) = h.resolve_kerberos(CONNECTION, response).await;
        assert_eq!(
            h.start("shared").await.result(),
            &json!({"outcome":"failed","reason":reason})
        );
        ordinary.assert_calls_async(1).await;
        native.assert_calls_async(1).await;
        assert!(h.network.attempts.lock().unwrap().is_empty());
        h.run.shutdown().await;
    }
}

struct HeldKdc {
    _task: AbortOnDropHandle<()>,
    address: std::net::SocketAddr,
    received: mpsc::UnboundedReceiver<()>,
    closed: mpsc::UnboundedReceiver<()>,
}

impl HeldKdc {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (received_tx, received) = mpsc::unbounded_channel();
        let (closed_tx, closed) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut stream, _) = accepted.unwrap();
                        let received = received_tx.clone();
                        let closed = closed_tx.clone();
                        tasks.spawn(async move {
                            let length = stream.read_u32().await.unwrap();
                            assert!((1..=65536).contains(&length));
                            let mut request = vec![0; length as usize];
                            stream.read_exact(&mut request).await.unwrap();
                            assert_eq!(request[0], 0x6a, "expected a native AS-REQ");
                            received.send(()).unwrap();
                            // Keep both real native acquisitions waiting for the KDC.
                            // Only caller cancellation closes these connections.
                            let result = stream.read(&mut [0]).await;
                            assert!(matches!(result, Ok(0)) || matches!(result,
                                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset));
                            let _ = stream.shutdown().await;
                            closed.send(()).unwrap();
                        });
                    }
                    result = tasks.join_next(), if !tasks.is_empty() => {
                        result.unwrap().unwrap();
                    }
                }
            }
        });
        Self {
            _task: AbortOnDropHandle::new(task),
            address,
            received,
            closed,
        }
    }
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; native Kerberos matrix"]
async fn busy_kerberos_handshakes_allow_ordinary_start_and_check_in_another_run() {
    let mut h = Harness::with_authority(Peer::gssapi().await, None).await;
    let mut kdc = HeldKdc::new().await;
    let ordinary = Peer::new().await;
    h.network.routes.lock().unwrap().extend([
        ("93.184.216.35:88".parse().unwrap(), kdc.address),
        ("93.184.216.36:5900".parse().unwrap(), ordinary.address),
    ]);
    let mut other = TestRun::new(&h.runtime);
    other.enable_checks(&h.runtime, &["vnc:write"]).await;
    let first_resolve = h.resolve_kerberos(CONNECTION, kerberos_response(&h)).await;
    let second_resolve = h.resolve_kerberos(SECOND, kerberos_response(&h)).await;
    let queued_resolve = h.resolve_kerberos(QUEUED, kerberos_response(&h)).await;
    let _first_authority = h
        .check_kerberos_route(
            CONNECTION,
            json!({"type":"direct"}),
            json!({"type":"direct"}),
        )
        .await;
    let _second_authority = h
        .check_kerberos_route(SECOND, json!({"type":"direct"}), json!({"type":"direct"}))
        .await;
    let ordinary_resolve = h
        .resolve_profiles(
            ORDINARY,
            json!({
                "outcome":"resolved_transport","host":"93.184.216.36","port":5900,
                "generation":7,"serverName":"vnc.example.test","transport":{"type":"direct"},
                "authentication":{"method":"vnc_password","password":" secret "},
                "security":{"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":ordinary.ca}}
            }),
            false,
        )
        .await;
    let _ordinary_authority = h.check_connection(ORDINARY, "valid", 200).await;

    let mut first = Box::pin(h.start("shared"));
    bounded(async {
        tokio::select! {
            result = &mut first => panic!("first acquisition completed: {:?}", result.result()),
            received = kdc.received.recv() => received.unwrap(),
        }
    })
    .await;
    let mut second = Box::pin(h.run.request(
        "vnc.session.start",
        json!({"connectionId":SECOND,"mode":"shared"}),
    ));
    bounded(async {
        tokio::select! {
            result = &mut second => panic!("second acquisition completed: {:?}", result.result()),
            received = kdc.received.recv() => received.unwrap(),
        }
    })
    .await;
    // Both actual native contexts remain held at observed AS-REQ boundaries.
    // The public 2000ms request leaves only 1000ms for ordinary setup.
    let started = other
        .raw(
            json!({"version":1,"method":"vnc.session.start","remaining_ms":2000,
        "params":{"connectionId":ORDINARY,"mode":"shared"}})
            .to_string(),
        )
        .await;
    let session = started.session();
    assert!(matches!(ordinary.event().await, Event::Mode(1)));
    let checked = other
        .active_check_budget(json!({"connectionId":ORDINARY,"mode":"exclusive"}), 2000)
        .await;
    assert_eq!(checked["status"], "passed", "{checked}");
    assert!(matches!(ordinary.event().await, Event::Mode(0)));
    assert!(matches!(ordinary.event().await, Event::Closed));
    ordinary_resolve.assert_calls_async(2).await;
    for (ordinary, native) in [&first_resolve, &second_resolve] {
        ordinary.assert_calls_async(1).await;
        native.assert_calls_async(1).await;
    }
    assert!(
        kdc.closed.try_recv().is_err(),
        "handshakes were released early"
    );
    assert_eq!(
        other
            .request("vnc.session.close", json!({"sessionId":session}))
            .await
            .result()["outcome"],
        "closed"
    );
    assert!(matches!(ordinary.event().await, Event::Closed));

    // A third Kerberos start still obeys the real two-worker bound. Expiry must
    // remove its queued probe, without requesting its credentials later.
    let queued = other
        .raw(
            json!({"version":1,"method":"vnc.session.start","remaining_ms":2000,
        "params":{"connectionId":QUEUED,"mode":"shared"}})
            .to_string(),
        )
        .await;
    assert_eq!(queued.result()["reason"], "timed_out");
    queued_resolve.0.assert_calls_async(1).await;
    queued_resolve.1.assert_calls_async(0).await;
    assert!(
        kdc.received.try_recv().is_err(),
        "a third native acquisition was admitted"
    );

    h.run.cancel.cancel();
    for reply in [first.await, second.await] {
        // AS requests were already sent. Cancellation must preserve uncertain
        // delivery rather than imply the KDC received nothing.
        assert_eq!(reply.result()["reason"], "delivery_unknown");
    }
    for _ in 0..2 {
        bounded(kdc.closed.recv()).await.unwrap();
    }
    // A new actual bootstrap confirms admission after physical cleanup, not
    // merely disappearance of the cancelled request waiters.
    let root = tempfile::Builder::new()
        .permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .tempdir()
        .unwrap();
    kerberos_worker::probe(
        root.path(),
        tokio::time::Instant::now() + Duration::from_secs(10),
    )
    .await
    .unwrap();
    queued_resolve.1.assert_calls_async(0).await;
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    other.shutdown().await;
    h.run.shutdown().await;
}
