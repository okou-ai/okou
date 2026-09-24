use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{io::AsyncWriteExt, net::TcpStream, task::JoinHandle};

use super::{
    harness::{CONNECTION, Harness, PASSWORD, Reply, TOKEN},
    terminal, wait_for,
};
use crate::test_fixtures::http::{HttpClientConfig, http_client};
use crate::vnc::{
    VncRuntime,
    tests::peer::{PLAIN_PASSWORD, PLAIN_USERNAME, Peer},
};

struct BridgeTask(JoinHandle<()>);

fn password_credential(harness: &Harness) -> serde_json::Value {
    let mut credential = harness.credential(true);
    let object = credential.as_object_mut().unwrap();
    object.insert("outcome".into(), json!("resolved_password"));
    object.insert("password".into(), json!(PASSWORD));
    object.remove("privateKey");
    object.remove("passphrase");
    credential
}

#[tokio::test]
async fn vnc_uses_the_shared_generation_bound_ssh_transport_for_all_supported_profiles() {
    for (password, plain, server_name, succeeds, pinned) in [
        (false, false, "vnc.example.test", true, true),
        (true, false, "vnc.example.test", true, true),
        (false, true, "vnc.example.test", true, true),
        (false, false, "wrong.example.test", false, true),
        (false, false, "vnc.example.test", true, false),
    ] {
        let mut harness = Harness::new(Reply::default()).await;
        let peer = if plain {
            Peer::plain().await
        } else {
            Peer::new().await
        };
        let http = http_client(HttpClientConfig {
            api_url: harness.api.base_url(),
            vercel_bypass: None,
            client_session_id: "vnc-over-ssh-test".into(),
        });
        let vnc = VncRuntime::official(http, TOKEN, harness.identity)
            .unwrap()
            .unwrap();
        harness.restart_with_vnc(Arc::clone(&vnc)).await;

        let ssh_credential = if password {
            password_credential(&harness)
        } else {
            harness.credential(pinned)
        };
        let ssh_resolve = harness.resolve_for_run(harness.run, ssh_credential).await;
        let ssh_pin = if pinned {
            None
        } else {
            Some(
                harness
                    .api
                    .mock_async(|when, then| {
                        when.method("POST")
                            .path(format!("/api/runners/runs/{}/ssh/pin", harness.run))
                            .json_body_includes(json!({"expectedGeneration": 7}).to_string());
                        then.status(200)
                            .json_body(json!({"outcome":"pinned","generation":8}));
                    })
                    .await,
            )
        };
        let authentication = if plain {
            json!({
                "method": "username_password",
                "username": PLAIN_USERNAME,
                "password": PLAIN_PASSWORD
            })
        } else {
            json!({"method": "vnc_password", "password": " secret "})
        };
        let security = if plain {
            json!({
                "type": "x509_plain",
                "trust": {"mode": "custom_ca", "caBundle": peer.ca}
            })
        } else {
            json!({
                "type": "x509_vnc",
                "trust": {"mode": "custom_ca", "caBundle": peer.ca}
            })
        };
        let vnc_resolve = harness
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!(
                        "/api/runners/runs/{}/vnc/resolve",
                        harness.run
                    ))
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .json_body(json!({
                        "connectionId": CONNECTION,
                        "runnerIdentity": {
                            "runnerId": harness.identity.runner_id(),
                            "heartbeatGeneration": 27
                        },
                        "supportedProfiles": [
                            {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"direct"},
                            {"authMethod":"username_password","securityType":"x509_plain","transportType":"direct"},
                            {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"ssh"},
                            {"authMethod":"username_password","securityType":"x509_plain","transportType":"ssh"},
                            {"authMethod":"apple_dh_username_password","securityType":"apple_dh","transportType":"ssh"},
                            {"authMethod":"apple_srp_username_password","securityType":"apple_srp","transportType":"ssh"}
                        ]
                    }));
                then.status(200).json_body(json!({
                    "outcome": "resolved_transport",
                    "host": "desktop.internal",
                    "port": 5900,
                    "generation": 11,
                    "serverName": server_name,
                    "transport": {
                        "type": "ssh",
                        "connectionId": CONNECTION,
                        "generation": 7
                    },
                    "authentication": authentication,
                    "security": security
                }));
            })
            .await;
        let vnc_check = harness
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/vnc/check", harness.run))
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .json_body(json!({
                        "connectionId": CONNECTION,
                        "runnerIdentity": {
                            "runnerId": harness.identity.runner_id(),
                            "heartbeatGeneration": 27
                        },
                        "expectedGeneration": 11,
                        "expectedTransport": {
                            "type": "ssh",
                            "connectionId": CONNECTION,
                            "generation": if pinned { 7 } else { 8 }
                        }
                    }));
                then.status(200).json_body(json!({"outcome": "valid"}));
            })
            .await;

        let start = harness.raw(
            json!({
                "version": 1,
                "method": "vnc.session.start",
                "remaining_ms": 60_000,
                "params": {"connectionId": CONNECTION, "mode": "shared"}
            })
            .to_string(),
        );
        let bridge = async {
            let mut forwarded = harness.accept_forwarded().await;
            let mut target = TcpStream::connect(peer.address).await.unwrap();
            BridgeTask(tokio::spawn(async move {
                let _ = tokio::io::copy_bidirectional(&mut forwarded, &mut target).await;
                let _ = forwarded.shutdown().await;
                let _ = target.shutdown().await;
            }))
        };
        let (frames, BridgeTask(bridge)) = tokio::join!(start, bridge);
        if !succeeds {
            assert_eq!(terminal(&frames)["outcome"], "failed");
            assert_eq!(terminal(&frames)["reason"], "authentication_failed");
            assert_eq!(harness.observed.forwards.lock().unwrap().len(), 1);
            tokio::time::timeout(Duration::from_secs(5), bridge)
                .await
                .unwrap()
                .unwrap();
            ssh_resolve.assert_calls_async(1).await;
            vnc_resolve.assert_calls_async(1).await;
            vnc_check.assert_calls_async(0).await;
            harness.shutdown().await;
            continue;
        }
        assert_eq!(terminal(&frames)["outcome"], "started");
        let session = terminal(&frames)["session"]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            *harness.observed.forwards.lock().unwrap(),
            vec![("desktop.internal".into(), 5900, "127.0.0.1".into(), 0)]
        );

        let status = harness
            .raw(
                json!({
                    "version": 1,
                    "method": "vnc.session.status",
                    "remaining_ms": 60_000,
                    "params": {"sessionId": session}
                })
                .to_string(),
            )
            .await;
        assert_eq!(terminal(&status)["outcome"], "status");
        if !password {
            assert!(harness.runtime.ably_message(&ably_subscriber::Message {
                name: Some("ssh-authority-invalidated".into()),
                data: json!({
                    "runId": harness.run,
                    "connectionId": CONNECTION
                }),
                id: None,
                client_id: None,
                timestamp: None,
            }));
            wait_for(|| {
                harness
                    .observed
                    .closed
                    .load(std::sync::atomic::Ordering::SeqCst)
                    >= 1
            })
            .await;
        }
        let closed = harness
            .raw(
                json!({
                    "version": 1,
                    "method": "vnc.session.close",
                    "remaining_ms": 60_000,
                    "params": {"sessionId": session}
                })
                .to_string(),
            )
            .await;
        assert_eq!(terminal(&closed)["outcome"], "closed");
        tokio::time::timeout(Duration::from_secs(5), bridge)
            .await
            .unwrap()
            .unwrap();

        ssh_resolve.assert_calls_async(1).await;
        if let Some(pin) = ssh_pin {
            pin.assert_calls_async(1).await;
        }
        vnc_resolve.assert_calls_async(1).await;
        vnc_check.assert_calls_async(2).await;
        harness.shutdown().await;
    }
}
