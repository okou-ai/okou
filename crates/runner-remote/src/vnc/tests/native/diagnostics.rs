use super::*;
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use crate::vnc::tests::{closed, harness::CREATED_AT, mode};

#[tokio::test]
async fn cloudflare_checks_initialize_both_modes_and_preserve_native_failure_history() {
    let mut h = Harness::with_authority(Peer::classic().await, None).await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    let gateway = Gateway::new(h.peer.address, true, false, HOST).await;
    connect_gateway(&h, &gateway).await;
    let _resolve = h
        .resolve_response(response(&h, route(Some(origin(&gateway))), true))
        .await;
    let _authority = h
        .check_route(
            CONNECTION,
            json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7}),
            "valid",
            200,
        )
        .await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    h.peer.refuse.store(true, Ordering::SeqCst);
    let failure = h.start("shared").await;
    assert_eq!(failure.result()["reason"], "authentication_failed");
    let automatic = diagnostic_text(failure.result());
    assert!(
        automatic.contains(&format!(
            "VNC RFB carrier: configuration {CONNECTION}; generation 7;"
        )),
        "{automatic}"
    );
    assert!(automatic.contains("origin TLS passed."), "{automatic}");
    assert!(
        automatic.contains("VNC authentication: failed."),
        "{automatic}"
    );
    closed(&h).await;
    let before = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(diagnostic_text(&before), automatic);
    h.peer.refuse.store(false, Ordering::SeqCst);
    let foreground = h.start("shared").await.session();
    mode(&h, 1).await;
    for (sharing, flag) in [("shared", 1), ("exclusive", 0)] {
        let checked = h
            .run
            .active_check(json!({"connectionId":CONNECTION,"mode":sharing}))
            .await;
        assert_eq!(checked["status"], "passed", "{checked}");
        let text = diagnostic_text(&checked);
        for stage in [
            "dns",
            "destination policy",
            "tcp",
            "access tls",
            "access websocket",
        ] {
            assert!(
                text.contains(&format!("VNC RFB carrier {stage}: passed.")),
                "{text}"
            );
        }
        assert!(text.contains("VNC initialization: passed."), "{text}");
        assert!(text.contains("Check-owned cleanup: passed."), "{text}");
        assert!(text.len() <= 8192);
        // Capture or input would appear instead of this exact mode/close sequence.
        mode(&h, flag).await;
        closed(&h).await;
        assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
        assert_eq!(
            h.run.request("vnc.session.list", json!({})).await.result()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    h.run
        .request("vnc.session.close", json!({"sessionId":foreground}))
        .await;
    closed(&h).await;
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":diagnostic_attempt(&before)}),
        )
        .await;
    assert_eq!(retained, before);
    for secret in ["private-client", "private-secret", " secret ", &gateway.ca] {
        assert!(!retained.to_string().contains(secret));
    }
    h.run.shutdown().await;
}

#[tokio::test]
async fn cloudflare_gateway_and_origin_trust_failures_keep_their_distinct_stages_after_teardown() {
    for gateway_failure in [true, false] {
        let mut h = Harness::with_authority(Peer::classic().await, None).await;
        h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
        let gateway = Gateway::new(
            h.peer.address,
            true,
            false,
            if gateway_failure {
                "wrong.example.test"
            } else {
                HOST
            },
        )
        .await;
        connect_gateway(&h, &gateway).await;
        let mut origin = origin(&gateway);
        if !gateway_failure {
            origin["trust"]["caBundle"] = json!(h.peer.ca);
        }
        let _resolve = h
            .resolve_response(response(&h, route(Some(origin)), true))
            .await;
        let _inventory = h
            .api
            .mock_async(|when, then| {
                when.method("GET").path("/api/vnc/hosts");
                then.status(200)
                    .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
            })
            .await;
        let failure = h.start("shared").await;
        assert_eq!(failure.result()["reason"], "authentication_failed");
        let automatic = diagnostic_text(failure.result());
        assert!(
            automatic.contains("VNC authentication: not reached."),
            "{automatic}"
        );
        if gateway_failure {
            assert!(
                automatic.contains("VNC RFB first Cloudflare Access failure: tls."),
                "{automatic}"
            );
            assert!(
                automatic.contains("VNC RFB carrier access tls: failed."),
                "{automatic}"
            );
            assert!(automatic.contains("origin TLS not reached."), "{automatic}");
        } else {
            assert!(
                automatic.contains("VNC RFB carrier access websocket: passed."),
                "{automatic}"
            );
            assert!(automatic.contains("origin TLS failed."), "{automatic}");
        }
        assert_eq!(gateway.applications.load(Ordering::SeqCst), 0);
        let before = h.run.passive("vnc.diagnose", json!({})).await;
        assert_eq!(diagnostic_text(&before), automatic);
        let checked = h
            .run
            .active_check(json!({"connectionId":CONNECTION,"mode":"exclusive"}))
            .await;
        assert_eq!(checked["status"], "failed", "{checked}");
        assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
        drop(gateway);
        assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
        h.run.shutdown().await;
    }
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime for the real Kerberos worker"]
async fn native_kdc_trust_failure_keeps_separate_rfb_and_kdc_configuration_receipts() {
    const KDC: &str = "4ba3413a-f930-48f3-a87e-284a1f78fd86";
    let mut h = Harness::with_authority(Peer::gssapi().await, None).await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    let gateway = Gateway::new(h.peer.address, false, false, HOST).await;
    connect_gateway(&h, &gateway).await;
    let _resolve = h.resolve_response(json!({
        "outcome":"resolved_kerberos", "host":HOST,"port":443,"generation":7,
        "credentialRevision":3,"serverName":"vnc.example.test","transport":route(None),
        "authentication":{"method":"qemu_kerberos_password","initiator":{"realm":"EXAMPLE.TEST","components":["operator"]},"password":"kdc-password-canary"},
        "security":{"type":"qemu_x509_gssapi","trust":{"mode":"custom_ca","caBundle":h.peer.ca},
            "service":{"realm":"EXAMPLE.TEST","components":["vnc","desktop.internal"]},
            "kdc":{"host":"kdc.access.example.test","port":443,
                "transport":{"type":"cloudflare_access","configId":KDC,"generation":9,
                    "credentials":{"clientId":"private-client","clientSecret":"private-secret"}},
                "ticketLifetimeSeconds":1200,"renewableLifetimeSeconds":7200}}
    })).await;
    let _authority = h
        .check_kerberos_route(
            CONNECTION,
            json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7}),
            json!({"type":"cloudflare_access","configId":KDC,"generation":9}),
        )
        .await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let failure = h.start("shared").await;
    assert_eq!(
        failure.result()["reason"],
        "network_failure",
        "{}",
        failure.result()
    );
    let automatic = diagnostic_text(failure.result());
    assert!(
        automatic.contains(&format!(
            "VNC RFB carrier: configuration {CONNECTION}; generation 7;"
        )),
        "{automatic}"
    );
    assert!(
        automatic.contains(&format!(
            "VNC KDC carrier: configuration {KDC}; generation 9;"
        )),
        "{automatic}"
    );
    assert!(
        automatic.contains("VNC RFB carrier access websocket: passed."),
        "{automatic}"
    );
    assert!(
        automatic.contains("VNC KDC carrier access tls: failed."),
        "{automatic}"
    );
    assert!(
        automatic.contains("VNC KDC first Cloudflare Access failure: tls."),
        "{automatic}"
    );
    assert!(
        automatic.contains("VNC kdc transport: failed."),
        "{automatic}"
    );
    assert!(
        automatic.contains("VNC initialization: not reached."),
        "{automatic}"
    );
    closed(&h).await;
    let before = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(diagnostic_text(&before), automatic);
    let checked = h
        .run
        .active_check(json!({"connectionId":CONNECTION,"mode":"exclusive"}))
        .await;
    assert_eq!(checked["status"], "failed", "{checked}");
    assert!(diagnostic_text(&checked).contains("VNC KDC carrier access tls: failed."));
    closed(&h).await;
    assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
    assert_eq!(
        gateway.applications.load(Ordering::SeqCst),
        2,
        "independent KDC gateway TLS refusal must not reach either application"
    );
    for secret in [
        "private-client",
        "private-secret",
        "kdc-password-canary",
        &h.peer.ca,
    ] {
        assert!(!automatic.contains(secret));
    }
    h.run.shutdown().await;
}
