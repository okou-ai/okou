//! Production KDC boundary over external TLS/WSS and SDK peer fixtures.
pub(crate) mod peer;

use super::{Gateway, HOST, connect_gateway};
use crate::vnc::{
    Scope,
    authority::Transport,
    kerberos::{Binding, Caller, Kdc},
    native::{self, Dialer},
    sessions::StartEvidence,
    tests::harness::{CONNECTION, Harness},
};
use kerberos_worker::{Error, KdcExchange};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncReadExt;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) struct Case {
    pub(crate) route: Value,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) rfb: Option<(Value, String, u16)>,
    pub(crate) cancel: CancellationToken,
    pub(crate) authority: &'static str,
}

fn cloudflare_route() -> Value {
    json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7,
        "credentials":{"clientId":"private-client","clientSecret":"private-secret"}})
}

pub(crate) fn snapshot(route: &Value) -> Value {
    json!({"type":route["type"],"configId":route["configId"],"generation":route["generation"]})
}

pub(crate) async fn exercise(h: &Harness, case: Case, exchanges: usize) -> Result<(), Error> {
    let expected_kdc = snapshot(&case.route);
    let expected_rfb = case
        .rfb
        .as_ref()
        .map_or_else(|| json!({"type":"direct"}), |(route, _, _)| snapshot(route));
    let check = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/check", h.run.id))
                .json_body_includes(
                    json!({"connectionId":CONNECTION,"expectedGeneration":7,
                "expectedTransport":expected_rfb,"expectedCredentialRevision":3,
                "expectedKdcTransport":snapshot(&case.route)})
                    .to_string(),
                );
            then.status(200)
                .json_body(json!({"outcome":case.authority}));
        })
        .await;
    let tasks = TaskTracker::new();
    let dialer = Dialer {
        runtime: Arc::clone(&h.runtime),
        native: h.run.native(),
        tasks: tasks.clone(),
    };
    let mut diagnostics = StartEvidence::default();
    diagnostics.vnc = Some(crate::vnc::evidence::Snapshot::default());
    let mut scope = Scope {
        cancelled: case.cancel,
        sandbox: CancellationToken::new(),
        session: CancellationToken::new(),
        native: Vec::new(),
        deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(10),
    };
    let mut rfb_stream = None;
    let rfb = if let Some((route, host, port)) = case.rfb {
        let (transport, configuration) =
            native::parse(serde_json::from_value(route).unwrap()).unwrap();
        let stream = dialer
            .dial(
                configuration.unwrap(),
                native::Destination {
                    host: &host,
                    port,
                    role: crate::vnc::evidence::Role::Rfb,
                },
                &scope,
                Arc::new(()),
                &mut diagnostics,
            )
            .await
            .unwrap();
        if let Some(guard) = stream.guard() {
            scope.native.push(guard);
        }
        rfb_stream = Some(stream);
        transport
    } else {
        Transport::Direct
    };
    let (transport, configuration) =
        native::parse_kdc(serde_json::from_value(case.route).unwrap(), false).unwrap();
    let delivery = AtomicBool::new(false);
    let mut caller = Caller {
        runtime: Arc::clone(&h.runtime),
        run: h.run.id,
        connection: CONNECTION.parse().unwrap(),
        generation: 7,
        rfb,
        binding: Binding {
            revision: 3,
            kdc: Some(transport),
        },
        kdc: Some(Kdc {
            host: case.host,
            port: case.port,
            transport,
            native: configuration.map(Box::new),
            node: None,
        }),
        realm: "EXAMPLE.TEST".into(),
        scope,
        ssh: None,
        tasks: tasks.clone(),
        owner: Arc::new(()),
        exchanges: 0,
        total: 0,
        awaiting_kdc_reply: &delivery,
        native: dialer,
        diagnostics: &mut diagnostics,
    };
    assert_eq!(
        caller.exchange("WRONG.TEST", b"test").await.unwrap_err(),
        Error::Invalid
    );
    assert_eq!(
        check.calls_async().await,
        0,
        "wrong realm cannot begin authority or network work"
    );
    let result = async {
        for _ in 0..exchanges {
            assert_eq!(
                caller.exchange("EXAMPLE.TEST", b"test").await?.as_slice(),
                b"reply"
            );
        }
        Ok(())
    }
    .await;
    if matches!(result, Err(Error::DeliveryUnknown)) {
        let attempted = caller.exchanges;
        let checks = check.calls_async().await;
        assert_eq!(
            caller.exchange("EXAMPLE.TEST", b"test").await.unwrap_err(),
            Error::DeliveryUnknown
        );
        assert_eq!(caller.exchanges, attempted);
        assert_eq!(
            check.calls_async().await,
            checks,
            "terminal delivery cannot replay or redial"
        );
        assert!(delivery.load(Ordering::Relaxed));
    }
    if result.is_ok() {
        assert!(!delivery.load(Ordering::Relaxed));
        assert_eq!(caller.exchanges, exchanges);
        let evidence = caller.diagnostics.vnc.as_ref().unwrap();
        let kdc = evidence.kdc_carrier.as_ref().unwrap();
        assert_eq!(
            kdc.configuration_id.to_string(),
            expected_kdc["configId"].as_str().unwrap()
        );
        assert_eq!(kdc.generation, expected_kdc["generation"].as_i64().unwrap());
        assert_eq!(kdc.status, crate::diagnostics::trace::Progress::Passed);
        if rfb_stream.is_some() {
            let rfb = evidence.rfb_carrier.as_ref().unwrap();
            assert_eq!(
                rfb.configuration_id.to_string(),
                expected_rfb["configId"].as_str().unwrap()
            );
            assert_eq!(rfb.generation, expected_rfb["generation"].as_i64().unwrap());
            assert_eq!(rfb.status, crate::diagnostics::trace::Progress::Passed);
            assert_ne!(rfb.attempt_id, kdc.attempt_id);
        }
        if let Some(stream) = &mut rfb_stream {
            let mut banner = [0; 12];
            stream.read_exact(&mut banner).await.unwrap();
            assert!(
                banner.starts_with(b"RFB "),
                "KDC cannot replace the independently selected RFB endpoint"
            );
        }
    }
    drop(caller);
    drop(rfb_stream);
    tasks.close();
    tasks.wait().await;
    result
}

#[tokio::test]
async fn cloudflare_kdc_frames_are_independent_and_uncertain_delivery_never_replays() {
    for reply in [
        peer::Reply::Complete,
        peer::Reply::Empty,
        peer::Reply::Oversized,
        peer::Reply::Partial,
        peer::Reply::Cancel,
    ] {
        let mut h = Harness::new().await;
        let cancel = CancellationToken::new();
        let kdc = peer::Peer::new(reply, cancel.clone()).await;
        let gateway = Gateway::new(kdc.address, false, false, HOST).await;
        connect_gateway(&h, &gateway).await;
        let route = cloudflare_route();
        let expected = if matches!(reply, peer::Reply::Complete) {
            2
        } else {
            1
        };
        let result = exercise(
            &h,
            Case {
                route,
                host: HOST.into(),
                port: 443,
                rfb: None,
                cancel,
                authority: "valid",
            },
            expected,
        )
        .await;
        if matches!(reply, peer::Reply::Complete) {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err(), Error::DeliveryUnknown);
        }
        assert_eq!(kdc.requests.load(Ordering::SeqCst), expected);
        assert_eq!(gateway.applications.load(Ordering::SeqCst), expected);
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn denied_kdc_generation_does_not_inherit_rfb_authority_or_open_a_gateway() {
    for authority in ["unavailable", "configuration_changed"] {
        let mut h = Harness::new().await;
        let cancel = CancellationToken::new();
        let kdc = peer::Peer::new(peer::Reply::Complete, cancel.clone()).await;
        let gateway = Gateway::new(kdc.address, false, false, HOST).await;
        connect_gateway(&h, &gateway).await;
        let result = exercise(
            &h,
            Case {
                route: cloudflare_route(),
                host: HOST.into(),
                port: 443,
                rfb: None,
                cancel,
                authority,
            },
            1,
        )
        .await;
        assert_eq!(result.unwrap_err(), Error::Authority);
        assert!(h.network.attempts.lock().unwrap().is_empty());
        assert!(h.network.queries.lock().unwrap().is_empty());
        assert_eq!(kdc.requests.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.applications.load(Ordering::SeqCst), 0);
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn native_kdc_exchange_budget_stops_before_a_seventeenth_connection() {
    let mut h = Harness::new().await;
    let cancel = CancellationToken::new();
    let kdc = peer::Peer::new(peer::Reply::Complete, cancel.clone()).await;
    let gateway = Gateway::new(kdc.address, false, false, HOST).await;
    connect_gateway(&h, &gateway).await;
    let result = exercise(
        &h,
        Case {
            route: cloudflare_route(),
            host: HOST.into(),
            port: 443,
            rfb: None,
            cancel,
            authority: "valid",
        },
        17,
    )
    .await;
    assert_eq!(result.unwrap_err(), Error::Invalid);
    assert_eq!(kdc.requests.load(Ordering::SeqCst), 16);
    assert_eq!(gateway.applications.load(Ordering::SeqCst), 16);
    h.run.shutdown().await;
}
