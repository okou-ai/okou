mod admission;

use super::*;
use crate::{
    ssh::tests::harness::{CONNECTION, Harness, Reply, TOKEN},
    test_fixtures::http::{HttpClientConfig, http_client},
};
use kerberos_worker::KdcExchange;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::{net::TcpStream, time::Instant};
use tokio_util::sync::CancellationToken;

fn caller<'a>(
    h: &Harness,
    diagnostics: &'a mut super::super::sessions::StartEvidence,
    delivery: &'a AtomicBool,
) -> Caller<'a> {
    let runtime = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "kerberos-kdc-forwarding".into(),
        }),
        TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    let transport = Transport::Ssh {
        connection: CONNECTION.parse().unwrap(),
        generation: 7,
    };
    Caller {
        runtime: Arc::clone(&runtime),
        run: h.run,
        connection: CONNECTION.parse().unwrap(),
        generation: 11,
        rfb: Transport::Direct,
        binding: Binding {
            revision: 3,
            kdc: Some(transport),
        },
        kdc: Some(Kdc {
            host: "127.0.0.1".into(),
            port: 88,
            transport,
            native: None,
            node: None,
        }),
        realm: "EXAMPLE.TEST".into(),
        scope: Scope {
            cancelled: h.cancel.child_token(),
            sandbox: CancellationToken::new(),
            session: CancellationToken::new(),
            native: Vec::new(),
            deadline: Instant::now() + Duration::from_secs(10),
        },
        ssh: Some(h.ssh()),
        tasks: TaskTracker::new(),
        owner: Arc::new(()),
        exchanges: 0,
        total: 0,
        awaiting_kdc_reply: delivery,
        native: super::super::native::Dialer {
            runtime: Arc::clone(&runtime),
            native: h.native(),
            tasks: TaskTracker::new(),
        },
        diagnostics,
    }
}

async fn check<'a>(
    h: &'a Harness,
    generation: i64,
    outcome: &str,
    rfb_generation: Option<i64>,
) -> httpmock::Mock<'a> {
    h.api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/check", h.run))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({
                    "connectionId": CONNECTION,
                    "runnerIdentity": {
                        "runnerId": h.identity.runner_id(),
                        "heartbeatGeneration": 27
                    },
                    "expectedGeneration": 11,
                    "expectedTransport": rfb_generation.map_or_else(
                        || json!({"type":"direct"}),
                        |generation| json!({"type":"ssh","connectionId":CONNECTION,"generation":generation})
                    ),
                    "expectedCredentialRevision": 3,
                    "expectedKdcTransport": {
                        "type":"ssh", "connectionId":CONNECTION, "generation":generation
                    }
                }));
            then.status(200).json_body(json!({"outcome":outcome}));
        })
        .await
}

async fn pin(h: &Harness) -> httpmock::Mock<'_> {
    h.api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/pin", h.run))
                .json_body_includes(json!({"expectedGeneration":7}).to_string());
            then.status(200)
                .json_body(json!({"outcome":"pinned","generation":8}));
        })
        .await
}

async fn receive(stream: &mut TcpStream) {
    assert_eq!(stream.read_u32().await.unwrap(), 4);
    let mut request = [0; 4];
    stream.read_exact(&mut request).await.unwrap();
    assert_eq!(&request, b"test");
}

#[tokio::test]
async fn first_kdc_ssh_pin_is_reauthorized_and_retained_for_later_exchanges() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
    let pin = pin(&h).await;
    let initial = check(&h, 7, "valid", None).await;
    let learned = check(&h, 8, "valid", None).await;
    let mut diagnostics = super::super::sessions::StartEvidence::default();
    let delivery = AtomicBool::new(false);
    let mut caller = caller(&h, &mut diagnostics, &delivery);
    for _ in 0..2 {
        let exchange = caller.exchange("EXAMPLE.TEST", b"test");
        let kdc = async {
            let mut stream = h.accept_forwarded().await;
            receive(&mut stream).await;
            stream.write_u32(5).await.unwrap();
            stream.write_all(b"reply").await.unwrap();
            stream.shutdown().await.unwrap();
        };
        let (reply, ()) = tokio::join!(exchange, kdc);
        assert_eq!(reply.unwrap().as_slice(), b"reply");
    }
    initial.assert_calls_async(1).await;
    learned.assert_calls_async(5).await;
    resolve.assert_calls_async(1).await;
    pin.assert_calls_async(1).await;
    learned.delete_async().await;
    let revoked = check(&h, 8, "configuration_changed", None).await;
    assert_eq!(
        caller.exchange("EXAMPLE.TEST", b"test").await.unwrap_err(),
        kerberos_worker::Error::Authority
    );
    revoked.assert_calls_async(1).await;
    drop(caller);
    h.shutdown().await;
}

#[tokio::test]
async fn repeated_kdc_exchanges_accumulate_timing_inside_inclusive_authentication() {
    use crate::diagnostics::{Cause, Handle, Identity, Operation, Protocol, Record};
    use crate::vnc::evidence::Snapshot;
    let mut h = Harness::new(Reply::default()).await;
    let _resolve = h.resolve_for_run(h.run, h.credential(false)).await;
    let _pin = pin(&h).await;
    let _initial = check(&h, 7, "valid", None).await;
    let _learned = check(&h, 8, "valid", None).await;
    let mut diagnostics = super::super::sessions::StartEvidence::default();
    diagnostics.vnc = Some(Snapshot::default());
    diagnostics.begin(Stage::Authentication);
    let delivery = AtomicBool::new(false);
    let mut caller = caller(&h, &mut diagnostics, &delivery);
    for _ in 0..2 {
        let exchange = caller.exchange("EXAMPLE.TEST", b"test");
        let kdc = async {
            let mut stream = h.accept_forwarded().await;
            receive(&mut stream).await;
            tokio::time::pause();
            tokio::time::advance(Duration::from_millis(180)).await;
            tokio::time::resume();
            stream.write_u32(5).await.unwrap();
            stream.write_all(b"reply").await.unwrap();
            stream.shutdown().await.unwrap();
        };
        let (reply, ()) = tokio::join!(exchange, kdc);
        assert_eq!(reply.unwrap().as_slice(), b"reply");
    }
    drop(caller);
    diagnostics.begin(Stage::Initialization);
    let handle = Handle::new(h.run, true);
    let report = handle
        .record(Record {
            effects: None,
            protocol: Protocol::Vnc,
            connection: CONNECTION.parse().unwrap(),
            operation: Operation::Start,
            identity: Identity::default(),
            cause: Some(Cause::Vnc(Failure::Protocol)),
            dependency: None,
            native: None,
            ssh: None,
            vnc: diagnostics.vnc.take(),
        })
        .unwrap();
    let text = report.message().unwrap();
    assert!(
        text.contains("VNC kdc transport: passed.\n  Elapsed:"),
        "{text}"
    );
    assert!(
        text.contains("VNC kdc exchange: passed.\n  Elapsed:"),
        "{text}"
    );
    let evidence = report.evidence().unwrap();
    let elapsed = |stage| {
        evidence["vnc"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["stage"] == stage)
            .unwrap()["elapsed_ms"]
            .as_u64()
            .unwrap()
    };
    assert!(elapsed("kdc_exchange") >= 360, "{text}");
    assert!(
        elapsed("authentication") >= elapsed("kdc_exchange"),
        "{text}"
    );
    assert!(!delivery.load(Ordering::Relaxed));
    h.shutdown().await;
}

#[tokio::test]
async fn changed_kdc_grant_after_first_pin_denies_before_any_kdc_bytes() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
    let pin = pin(&h).await;
    let initial = check(&h, 7, "valid", None).await;
    let revoked = check(&h, 8, "unavailable", None).await;
    let mut diagnostics = super::super::sessions::StartEvidence::default();
    let delivery = AtomicBool::new(false);
    let mut caller = caller(&h, &mut diagnostics, &delivery);
    let exchange = caller.exchange("EXAMPLE.TEST", b"test");
    let kdc = async {
        let mut stream = h.accept_forwarded().await;
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    };
    let (result, ()) = tokio::join!(exchange, kdc);
    assert_eq!(result.unwrap_err(), kerberos_worker::Error::Authority);
    initial.assert_calls_async(1).await;
    revoked.assert_calls_async(1).await;
    resolve.assert_calls_async(1).await;
    pin.assert_calls_async(1).await;
    drop(caller);
    h.shutdown().await;
}

#[tokio::test]
async fn shared_rfb_and_kdc_ssh_pin_preserves_both_authorized_routes() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
    let pin = pin(&h).await;
    let current = check(&h, 8, "valid", Some(8)).await;
    let mut diagnostics = super::super::sessions::StartEvidence::default();
    let delivery = AtomicBool::new(false);
    let mut caller = caller(&h, &mut diagnostics, &delivery);
    let original = caller.kdc.as_ref().unwrap().transport;
    let ssh = h.ssh();
    let open = ssh.open_direct_tcpip(
        CONNECTION.parse().unwrap(),
        7,
        "desktop.internal",
        5900,
        caller.scope.session.clone(),
        caller.scope.deadline,
    );
    let (rfb, rfb_peer) = tokio::join!(open, h.accept_forwarded());
    let rfb = rfb.unwrap();
    let attested = Transport::Ssh {
        connection: CONNECTION.parse().unwrap(),
        generation: rfb.generation(),
    };
    caller.rfb = attested;
    caller
        .binding
        .record_ssh_generation(&mut caller.kdc, original, attested);
    let exchange = caller.exchange("EXAMPLE.TEST", b"test");
    let kdc = async {
        let mut stream = h.accept_forwarded().await;
        receive(&mut stream).await;
        stream.write_u32(5).await.unwrap();
        stream.write_all(b"reply").await.unwrap();
        stream.shutdown().await.unwrap();
    };
    let (reply, ()) = tokio::join!(exchange, kdc);
    assert_eq!(reply.unwrap().as_slice(), b"reply");
    current.assert_calls_async(3).await;
    pin.assert_calls_async(1).await;
    resolve.assert_calls_async(1).await;
    drop(rfb);
    drop(rfb_peer);
    drop(caller);
    h.shutdown().await;
}

#[tokio::test]
async fn authentication_deadline_after_full_kdc_send_is_delivery_unknown() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
    let pin = pin(&h).await;
    let initial = check(&h, 7, "valid", None).await;
    let learned = check(&h, 8, "valid", None).await;
    let mut diagnostics = super::super::sessions::StartEvidence::default();
    let delivery = AtomicBool::new(false);
    let mut caller = caller(&h, &mut diagnostics, &delivery);
    let (request_received, deadline) = tokio::sync::oneshot::channel();
    let authenticate = async {
        let result = {
            let exchange = caller.exchange("EXAMPLE.TEST", b"test");
            tokio::pin!(exchange);
            tokio::select! {
                reply = &mut exchange => reply.map(|_| ()).map_err(rfb_client::Error::Kerberos),
                received = deadline => {
                    received.unwrap();
                    Err(rfb_client::Error::Kerberos(kerberos_worker::Error::Deadline))
                }
            }
        };
        caller.authentication_result(result)
    };
    let kdc = async {
        let mut stream = h.accept_forwarded().await;
        receive(&mut stream).await;
        // The enclosing authentication deadline wins only after the real
        // forwarded socket has received the complete request, without reply.
        request_received.send(()).unwrap();
        assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
    };
    let (result, ()) = tokio::join!(authenticate, kdc);
    assert_eq!(Failure::from(result.unwrap_err()), Failure::DeliveryUnknown);
    initial.assert_calls_async(1).await;
    learned.assert_calls_async(2).await;
    resolve.assert_calls_async(1).await;
    pin.assert_calls_async(1).await;
    drop(caller);
    h.shutdown().await;
}

#[tokio::test]
async fn completed_kdc_reply_does_not_reclassify_a_later_authentication_deadline() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve_for_run(h.run, h.credential(false)).await;
    let pin = pin(&h).await;
    let initial = check(&h, 7, "valid", None).await;
    let learned = check(&h, 8, "valid", None).await;
    let mut diagnostics = super::super::sessions::StartEvidence::default();
    let delivery = AtomicBool::new(false);
    let mut caller = caller(&h, &mut diagnostics, &delivery);
    let exchange = caller.exchange("EXAMPLE.TEST", b"test");
    let kdc = async {
        let mut stream = h.accept_forwarded().await;
        receive(&mut stream).await;
        stream.write_u32(5).await.unwrap();
        stream.write_all(b"reply").await.unwrap();
        stream.shutdown().await.unwrap();
    };
    let (reply, ()) = tokio::join!(exchange, kdc);
    assert_eq!(reply.unwrap().as_slice(), b"reply");
    let error = caller
        .authentication_result::<()>(Err(rfb_client::Error::Kerberos(
            kerberos_worker::Error::Deadline,
        )))
        .unwrap_err();
    assert_eq!(Failure::from(error), Failure::TimedOut);
    initial.assert_calls_async(1).await;
    learned.assert_calls_async(2).await;
    resolve.assert_calls_async(1).await;
    pin.assert_calls_async(1).await;
    drop(caller);
    h.shutdown().await;
}

#[test]
fn all_installed_rfb_and_kdc_tuples_remain_exact_and_bounded() {
    let full = profiles(true);
    assert_eq!(full.len(), 36);
    assert_eq!(
        full.iter()
            .filter(|p| p.kdc_transport_type
                == Some(ResolveRequestSupportedProfileKdcTransportType::None))
            .count(),
        4
    );
    let direct = profiles(false);
    assert_eq!(direct.len(), 21);
    assert_eq!(
        full.len()
            + crate::test_fixtures::vnc::supported_profiles(true)
                .as_array()
                .unwrap()
                .len(),
        100
    );
    assert_eq!(
        direct.len()
            + crate::test_fixtures::vnc::supported_profiles(false)
                .as_array()
                .unwrap()
                .len(),
        67
    );
    let unique: std::collections::HashSet<_> = full
        .iter()
        .map(|profile| serde_json::to_string(profile).unwrap())
        .collect();
    assert_eq!(unique.len(), full.len());
    assert!(direct.iter().all(|p| p.transport_type
        != ResolveRequestSupportedProfileTransportType::Ssh
        && p.kdc_transport_type != Some(ResolveRequestSupportedProfileKdcTransportType::Ssh)));
    assert!(full.iter().all(|p| matches!(
        p.kdc_transport_type,
        Some(
            ResolveRequestSupportedProfileKdcTransportType::None
                | ResolveRequestSupportedProfileKdcTransportType::Direct
                | ResolveRequestSupportedProfileKdcTransportType::Ssh
                | ResolveRequestSupportedProfileKdcTransportType::CloudflareAccess
                | ResolveRequestSupportedProfileKdcTransportType::Tailscale
        )
    )));
}
