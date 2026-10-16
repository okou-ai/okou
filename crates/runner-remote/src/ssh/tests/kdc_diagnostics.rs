use crate::test_fixtures::diagnostic_report;
use base64::Engine;
use serde_json::json;
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpStream};

use super::{
    harness::{CONNECTION, CREATED_AT, Harness, Reply, TOKEN},
    terminal,
};
use crate::{
    test_fixtures::{
        http::{HttpClientConfig, http_client},
        remote_inventory,
    },
    vnc::{VncRuntime, tests::peer::Peer},
};

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime for the real Kerberos worker"]
async fn vnc_history_retains_kdc_ssh_failure_before_kerberos_conversion() {
    const VNC: &str = "ec71882f-380f-49d5-bcbd-5d08a76fa412";
    const KDC: &str = "4ba3413a-f930-48f3-a87e-284a1f78fd86";
    let mut h = Harness::new(Reply::default()).await;
    let peer = Peer::gssapi().await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "kdc-history".into(),
        }),
        TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(vnc).await;
    h.enable_diagnostics().await;
    let rfb = h.resolve(h.credential(true)).await;
    let mut credential = h.credential(true);
    credential["learnedHostKey"]["fingerprint"] = json!(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode([0_u8; 32])
    ));
    let kdc = h.resolve_connection(KDC, credential).await;
    let resolve = h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve", h.run));
        then.status(200).header("X-VNC-Connection-Created-At", CREATED_AT).json_body(json!({
            "outcome":"resolved_kerberos", "host":"desktop.internal", "port":5900, "generation":11,
            "credentialRevision":3, "serverName":"vnc.example.test",
            "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
            "authentication":{"method":"qemu_kerberos_password","initiator":{"realm":"EXAMPLE.TEST","components":["operator"]},"password":"kdc-password-canary"},
            "security":{"type":"qemu_x509_gssapi","trust":{"mode":"custom_ca","caBundle":peer.ca},
                "service":{"realm":"EXAMPLE.TEST","components":["vnc","desktop.internal"]},
                "kdc":{"host":"127.0.0.1","port":88,"transport":{"type":"ssh","connectionId":KDC,"generation":7},"ticketLifetimeSeconds":1200,"renewableLifetimeSeconds":7200}}
        }));
    }).await;
    let _check = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/check", h.run));
            then.status(200).json_body(json!({"outcome":"valid"}));
        })
        .await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(VNC, 11)], CREATED_AT));
        })
        .await;
    let ssh_inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7), (KDC, 7)], CREATED_AT));
        })
        .await;
    let start = h.raw(json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{"connectionId":VNC,"mode":"shared"}}).to_string());
    let bridge = async {
        let mut forwarded = h.accept_forwarded().await;
        let mut target = TcpStream::connect(peer.address).await.unwrap();
        let _ = tokio::io::copy_bidirectional(&mut forwarded, &mut target).await;
        let _ = forwarded.shutdown().await;
        let _ = target.shutdown().await;
    };
    let (started, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(start, bridge)
    })
    .await
    .unwrap();
    assert_eq!(terminal(&started)["reason"], "network_failure");
    let history = h
        .raw(json!({"version":1,"method":"vnc.diagnose","params":{}}).to_string())
        .await;
    let report = terminal(&history);
    assert_eq!(report["status"], "found");
    assert_eq!(
        diagnostic_report(report)["dependencies"][0]["connection_id"],
        KDC
    );
    assert_eq!(
        diagnostic_report(report)["dependencies"][0]["cause"],
        json!({"source":"ssh","code":"host_key_mismatch"})
    );
    assert_eq!(
        diagnostic_report(report)["dependencies"][0]["configuration_created_at"],
        CREATED_AT
    );
    assert!(!report.to_string().contains("kdc-password-canary"));
    assert_eq!(
        h.observed.forwards.lock().unwrap().len(),
        1,
        "KDC trust refusal must not open its forwarding channel"
    );
    resolve.assert_calls_async(1).await;
    rfb.assert_calls_async(1).await;
    kdc.assert_calls_async(1).await;
    inventory.assert_calls_async(1).await;
    ssh_inventory.assert_calls_async(1).await;
    ssh_inventory.delete_async().await;
    let recreated = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            let mut hosts = remote_inventory(&[(CONNECTION, 7), (KDC, 7)], CREATED_AT);
            hosts["identities"][1]["createdAt"] = json!("2026-09-01T00:00:00.123457Z");
            then.status(200).json_body(hosts);
        })
        .await;
    let hidden = h.raw(json!({"version":1,"method":"vnc.diagnose","params":{"attemptId":diagnostic_report(report)["attempt_id"]}}).to_string()).await;
    assert_eq!(terminal(&hidden)["status"], "authority_unavailable");
    assert!(diagnostic_report(terminal(&hidden)).is_null());
    recreated.assert_calls_async(1).await;
    h.shutdown().await;
}
