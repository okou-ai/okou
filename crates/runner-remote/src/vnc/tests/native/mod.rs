pub(crate) mod gateway;
pub(crate) mod kdc;
mod profiles;

use super::{
    harness::{CONNECTION, Harness},
    peer::Peer,
};
use gateway::{Gateway, HOST, ORIGIN};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};

pub(super) fn route(origin: Option<Value>) -> Value {
    json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7,
        "credentials":{"clientId":"private-client","clientSecret":"private-secret"},"originTls":origin})
}

fn origin(gateway: &Gateway) -> Value {
    json!({"serverName":ORIGIN,"trust":{"mode":"custom_ca","caBundle":gateway.ca}})
}

fn response(h: &Harness, transport: Value, raw: bool) -> Value {
    let mut value = json!({"outcome":if raw {"resolved_apple_vnc_password"} else {"resolved_transport"},
    "host":HOST,"port":443,"generation":7,"transport":transport,
    "authentication":{"method":"vnc_password","password":" secret "},
    "security":if raw {json!({"type":"apple_vnc_password"})} else {
        json!({"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":h.peer.ca}})
    }});
    if !raw {
        value["serverName"] = json!("vnc.example.test");
    }
    value
}

pub(crate) async fn connect_gateway(h: &Harness, gateway: &Gateway) {
    *h.network.target.lock().unwrap() = gateway.address;
    *h.network.answers.lock().unwrap() = vec!["93.184.216.34:443".parse().unwrap()];
    *h.runtime.access_tls.lock().unwrap() = Some(Arc::clone(&gateway.tls));
}

pub(crate) async fn desktop(h: &Harness, mode: &str) {
    let session = h.start(mode).await.session();
    exercise_session(h, mode, session).await;
    super::closed(h).await;
}

pub(crate) async fn exercise_session(h: &Harness, mode: &str, session: String) {
    super::mode(h, u8::from(mode == "shared")).await;
    let capture = h
        .run
        .request("vnc.capture", json!({"sessionId":session}))
        .await;
    assert!(matches!(h.peer.event().await, super::peer::Event::Capture));
    assert_eq!(capture.result()["outcome"], "captured");
    assert!(capture.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let geometry = &capture.controls[0]["data"]["geometry"];
    let click = h
        .run
        .request(
            "vnc.input",
            json!({"sessionId":session,"input":{
        "type":"click","geometry":geometry,"x":1,"y":0,"button":"left"}}),
        )
        .await;
    assert_eq!(click.result()["outcome"], "sent");
    assert!(matches!(h.peer.event().await, super::peer::Event::Capture));
    for expected in [vec![5, 1, 0, 1, 0, 0], vec![5, 0, 0, 1, 0, 0]] {
        match h.peer.event().await {
            super::peer::Event::Input(actual) => assert_eq!(actual, expected),
            _ => panic!("expected balanced pointer events"),
        }
    }
    let key = h
        .run
        .request(
            "vnc.input",
            json!({"sessionId":session,"input":{
        "type":"key_chord","keys":["Enter"]}}),
        )
        .await;
    assert_eq!(key.result()["outcome"], "sent");
    for expected in [
        vec![4, 1, 0, 0, 0, 0, 255, 13],
        vec![4, 0, 0, 0, 0, 0, 255, 13],
    ] {
        match h.peer.event().await {
            super::peer::Event::Input(actual) => assert_eq!(actual, expected),
            _ => panic!("expected balanced keyboard events"),
        }
    }
    let closed = h
        .run
        .request("vnc.session.close", json!({"sessionId":session}))
        .await;
    assert_eq!(closed.result()["outcome"], "closed");
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":session}))
            .await
            .result()["outcome"],
        "failed"
    );
}

#[tokio::test]
async fn cloudflare_verified_origin_protects_classic_apple_desktop_for_both_sharing_modes() {
    let mut h = Harness::with_authority(Peer::classic().await, None).await;
    let gateway = Gateway::new(h.peer.address, true, false, HOST).await;
    connect_gateway(&h, &gateway).await;
    let resolve = h
        .resolve_response(response(&h, route(Some(origin(&gateway))), true))
        .await;
    let check = h
        .check_route(
            CONNECTION,
            json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7}),
            "valid",
            200,
        )
        .await;
    desktop(&h, "shared").await;
    desktop(&h, "exclusive").await;
    resolve.assert_calls_async(2).await;
    assert!(check.calls_async().await >= 4);
    assert_eq!(gateway.applications.load(Ordering::SeqCst), 2);
    assert_eq!(
        *h.network.queries.lock().unwrap(),
        vec![(format!("{HOST}."), 443); 2]
    );
    assert!(
        h.network
            .attempts
            .lock()
            .unwrap()
            .iter()
            .all(|address| address.port() == 443)
    );
    h.run.shutdown().await;
}

#[tokio::test]
async fn cloudflare_keeps_inner_x509_name_roots_and_client_certificate_authentication() {
    for kind in [
        "none",
        "vnc",
        "plain",
        "certificate_none",
        "certificate_vnc",
    ] {
        let peer = match kind {
            "none" => Peer::none().await,
            "plain" => Peer::plain().await,
            "certificate_none" => Peer::certificate_none().await,
            "certificate_vnc" => Peer::certificate_vnc().await,
            _ => Peer::new().await,
        };
        let mut h = Harness::with_authority(peer, None).await;
        let gateway = Gateway::new(h.peer.address, false, false, HOST).await;
        connect_gateway(&h, &gateway).await;
        let mut value = response(&h, route(None), false);
        value["serverName"] = json!("vnc.example.test");
        let security = if kind.ends_with("none") {
            "x509_none"
        } else if kind == "plain" {
            "x509_plain"
        } else {
            "x509_vnc"
        };
        value["security"]["type"] = json!(security);
        if kind == "none" {
            value["authentication"] = json!({"method":"none"});
        }
        if kind == "plain" {
            value["authentication"] = json!({"method":"username_password","username":super::peer::PLAIN_USERNAME,"password":super::peer::PLAIN_PASSWORD});
        }
        if let Some((certificates, key)) = &h.peer.client_identity {
            value["authentication"] = json!({"method":if kind.ends_with("none") {"client_certificate"} else {"client_certificate_vnc_password"},
                "certificateChainDer":certificates,"privateKeyPkcs8Der":key});
            if !kind.ends_with("none") {
                value["authentication"]["password"] = json!(" secret ");
            }
        }
        let resolve = h.resolve_response(value).await;
        let _check = h
            .check_route(
                CONNECTION,
                json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7}),
                "valid",
                200,
            )
            .await;
        desktop(&h, "shared").await;
        resolve.assert_calls_async(1).await;
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn wrong_gateway_or_origin_name_ca_or_expiry_never_reaches_raw_vnc() {
    for fault in ["gateway_name", "origin_name", "origin_ca", "origin_expiry"] {
        let mut h = Harness::with_authority(Peer::classic().await, None).await;
        let gateway = Gateway::new(
            h.peer.address,
            true,
            fault == "origin_expiry",
            if fault == "gateway_name" {
                "wrong.example.test"
            } else {
                HOST
            },
        )
        .await;
        connect_gateway(&h, &gateway).await;
        let mut origin = origin(&gateway);
        if fault == "origin_name" {
            origin["serverName"] = json!("wrong.example.test");
        }
        if fault == "origin_ca" {
            origin["trust"]["caBundle"] = json!(h.peer.ca);
        }
        let resolve = h
            .resolve_response(response(&h, route(Some(origin)), true))
            .await;
        assert_eq!(
            h.start("shared").await.result(),
            &json!({"outcome":"failed","reason":"authentication_failed"})
        );
        assert_eq!(gateway.applications.load(Ordering::SeqCst), 0);
        assert_eq!(
            h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
            json!([])
        );
        resolve.assert_calls_async(1).await;
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn unprotected_cloudflare_and_raw_direct_are_rejected_before_any_dial() {
    for transport in [route(None), json!({"type":"direct"})] {
        for (outcome, security, authentication) in [
            (
                "resolved_apple_vnc_password",
                json!({"type":"apple_vnc_password"}),
                json!({"method":"vnc_password","password":" secret "}),
            ),
            (
                "resolved_apple_dh",
                json!({"type":"apple_dh"}),
                json!({"method":"apple_dh_username_password","username":"user","password":"secret"}),
            ),
            (
                "resolved_apple_srp",
                json!({"type":"apple_srp"}),
                json!({"method":"apple_srp_username_password","username":"user","password":"secret"}),
            ),
            (
                "resolved_apple_rsa_srp",
                json!({"type":"apple_rsa_srp"}),
                json!({"method":"apple_rsa_srp_username_password","username":"user","password":"secret"}),
            ),
            (
                "resolved_rsa_aes",
                json!({"type":"rsa_aes_ra2ne","serverKeySha256":"ab".repeat(32)}),
                json!({"method":"rsa_aes_password","password":"secret"}),
            ),
            (
                "resolved_rsa_aes",
                json!({"type":"rsa_aes_ra2ne_256","serverKeySha256":"ab".repeat(32)}),
                json!({"method":"rsa_aes_username_password","username":"user","password":"secret"}),
            ),
        ] {
            let mut h = Harness::new().await;
            let resolve = h.resolve_response(json!({"outcome":outcome,"host":HOST,"port":443,"generation":7,"transport":transport,
                "authentication":authentication,"security":security})).await;
            assert_eq!(
                h.start("shared").await.result(),
                &json!({"outcome":"failed","reason":"authority_failure"})
            );
            assert!(h.network.attempts.lock().unwrap().is_empty());
            resolve.assert_calls_async(1).await;
            h.run.shutdown().await;
        }
    }
}

fn invalidate(h: &Harness) {
    use runner_provider::AblySideMessageHandler;
    assert!(h.runtime.handle(&ably_subscriber::Message {
        name: Some("vnc-authority-invalidated".into()),
        data: json!({"runId":h.run.id,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: Some(1),
    }));
}

#[tokio::test]
async fn revocation_during_origin_tls_closes_startup_without_releasing_rfb_credentials() {
    let mut h = Harness::with_authority(Peer::classic().await, None).await;
    let gateway = Gateway::new(h.peer.address, true, false, HOST).await;
    gateway.origin_gate.acquire().await.unwrap().forget();
    connect_gateway(&h, &gateway).await;
    let resolve = h
        .resolve_response(response(&h, route(Some(origin(&gateway))), true))
        .await;
    {
        let starting = h.start("shared");
        tokio::pin!(starting);
        super::harness::bounded(async {
            tokio::select! {
                () = gateway.upgraded.notified() => {},
                result = &mut starting => panic!("start completed before cancellation: {:?}", result.result()),
            }
        }).await;
        invalidate(&h);
        assert_eq!(
            starting.await.result(),
            &json!({"outcome":"failed","reason":"cancelled"})
        );
    }
    assert_eq!(gateway.applications.load(Ordering::SeqCst), 0);
    resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn native_authority_recheck_precedes_raw_authentication_and_inner_trust_stays_independent() {
    for fault in ["configuration_changed", "inner_name", "inner_ca"] {
        let raw = fault == "configuration_changed";
        let mut h = Harness::with_authority(
            if raw {
                Peer::classic().await
            } else {
                Peer::new().await
            },
            None,
        )
        .await;
        let gateway = Gateway::new(h.peer.address, raw, false, HOST).await;
        connect_gateway(&h, &gateway).await;
        let mut value = response(&h, route(raw.then(|| origin(&gateway))), raw);
        if fault == "inner_name" {
            value["serverName"] = json!("wrong.example.test");
        }
        if fault == "inner_ca" {
            value["security"]["trust"]["caBundle"] = json!(gateway.ca);
        }
        let resolve = h.resolve_response(value).await;
        let check = h
            .check_route(
                CONNECTION,
                json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7}),
                if raw {
                    "configuration_changed"
                } else {
                    "valid"
                },
                200,
            )
            .await;
        assert_eq!(
            h.start("shared").await.result(),
            &json!({"outcome":"failed","reason":if raw {"configuration_changed"} else {"authentication_failed"}})
        );
        if !raw {
            super::closed(&h).await;
        }
        check.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        h.run.shutdown().await;
    }
}
