mod notifications;

use runner_provider::AblySideMessageHandler;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{io::AsyncWriteExt, net::TcpStream, task::JoinHandle};

use super::{
    harness::{CONNECTION, Harness, PASSWORD, Reply, TOKEN},
    terminal, wait_for,
};
use crate::guest_rpc::Runtime;
use crate::test_fixtures::{
    http::{HttpClientConfig, http_client},
    vnc::{optional_kerberos_request, supported_profiles},
};
use crate::vnc::{
    VncRuntime,
    tests::peer::{PLAIN_PASSWORD, PLAIN_USERNAME, Peer},
};

struct BridgeTask(JoinHandle<()>);

#[tokio::test]
async fn apple_endpoint_refusal_precedes_invalid_password_without_opening_ssh() {
    let mut h = Harness::new(Reply::default()).await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "apple-endpoint-refusal".into(),
        }),
        TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(vnc).await;
    let ssh_resolve = h.resolve(h.credential(true)).await;

    for (outcome, method, security) in [
        (
            "resolved_apple_vnc_password",
            "vnc_password",
            "apple_vnc_password",
        ),
        (
            "resolved_apple_dh",
            "apple_dh_username_password",
            "apple_dh",
        ),
        (
            "resolved_apple_srp",
            "apple_srp_username_password",
            "apple_srp",
        ),
        (
            "resolved_apple_rsa_srp",
            "apple_rsa_srp_username_password",
            "apple_rsa_srp",
        ),
    ] {
        for (pointer, value, reason) in [
            ("/host", json!("127.0.0.1"), "invalid_credential"),
            ("/host", json!("::1"), "invalid_credential"),
            ("/host", json!("localhost"), "authority_failure"),
            ("/host", json!("127.0.0.2"), "authority_failure"),
            ("/host", json!("0:0:0:0:0:0:0:1"), "authority_failure"),
            ("/port", json!(0), "authority_failure"),
            ("/port", json!(65536), "authority_failure"),
            ("/generation", json!(0), "authority_failure"),
            ("/generation", json!(-1), "authority_failure"),
            (
                "/generation",
                json!(i64::from(i32::MAX) + 1),
                "authority_failure",
            ),
            ("/transport", json!({"type":"direct"}), "authority_failure"),
            (
                "/transport/connectionId",
                json!("not-a-uuid"),
                "authority_failure",
            ),
            ("/transport/generation", json!(0), "authority_failure"),
            ("/transport/generation", json!(-1), "authority_failure"),
            (
                "/transport/generation",
                json!(i64::from(i32::MAX) + 1),
                "authority_failure",
            ),
        ] {
            // NUL passes the bounded handoff decoder but every Apple password
            // constructor rejects it, so endpoint-first validation is observable.
            let mut authentication = json!({"method":method,"password":"invalid\0password"});
            if method != "vnc_password" {
                authentication["username"] = json!("operator");
            }
            let mut response = json!({
                "outcome":outcome,"host":"127.0.0.1","port":5900,"generation":11,
                "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
                "authentication":authentication,"security":{"type":security}
            });
            *response.pointer_mut(pointer).unwrap() = value;
            let vnc_resolve = h.api.mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/vnc/resolve", h.run))
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .is_true(optional_kerberos_request(json!({
                        "connectionId":CONNECTION,
                        "runnerIdentity":{"runnerId":h.identity.runner_id(),"heartbeatGeneration":27},
                        "supportedProfiles":supported_profiles(true)
                    }), true));
                then.status(200)
                    .header("X-VNC-Connection-Created-At", super::harness::CREATED_AT)
                    .json_body(response);
            }).await;
            let frames = h
                .raw(
                    json!({
                        "version":1,"method":"vnc.session.start","remaining_ms":60000,
                        "params":{"connectionId":CONNECTION,"mode":"shared"}
                    })
                    .to_string(),
                )
                .await;
            assert_eq!(
                terminal(&frames),
                &json!({"outcome":"failed","reason":reason}),
                "{outcome} {pointer}"
            );
            assert!(h.observed.queries.lock().unwrap().is_empty());
            assert!(h.observed.attempts.lock().unwrap().is_empty());
            assert!(h.observed.forwards.lock().unwrap().is_empty());
            vnc_resolve.assert_calls_async(1).await;
            vnc_resolve.delete_async().await;
        }
    }
    ssh_resolve.assert_calls_async(0).await;
    h.shutdown().await;
}

async fn desktop(
    h: &Harness,
    peer: &Peer,
    connection: &str,
    vnc: Arc<VncRuntime>,
) -> (Runtime, String, JoinHandle<()>) {
    h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve", h.run))
            .json_body_includes(json!({"connectionId":connection}).to_string());
            then.status(200).header("X-VNC-Connection-Created-At", super::harness::CREATED_AT).json_body(json!({
            "outcome":"resolved_transport","host":"desktop.internal","port":5900,"generation":11,
            "serverName":"vnc.example.test","transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
            "authentication":{"method":"vnc_password","password":" secret "},
            "security":{"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":peer.ca}}
        }));
    }).await;
    h.api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/check", h.run))
                .json_body_includes(
                    json!({"connectionId":connection,"expectedGeneration":11,
                "expectedTransport":{"type":"ssh","connectionId":CONNECTION,"generation":7}})
                    .to_string(),
                );
            then.status(200).json_body(json!({"outcome":"valid"}));
        })
        .await;
    let start = h.raw(
        json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,
        "params":{"connectionId":connection,"mode":"shared"}})
        .to_string(),
    );
    let bridge = async {
        let mut forwarded = h.accept_forwarded().await;
        let mut target = TcpStream::connect(peer.address).await.unwrap();
        BridgeTask(tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut forwarded, &mut target).await;
            let _ = forwarded.shutdown().await;
            let _ = target.shutdown().await;
        }))
    };
    let (started, BridgeTask(bridge)) = tokio::join!(start, bridge);
    assert_eq!(terminal(&started)["outcome"], "started");
    let session = terminal(&started)["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    (
        Runtime::new(Some(Arc::clone(&h.runtime)), Some(vnc), None),
        session,
        bridge,
    )
}

#[tokio::test]
async fn vnc_revocation_and_cleanup_preserve_ssh_peers_while_ssh_revocation_retires_its_dependent_vnc()
 {
    use super::sessions::{bytes, rpc, state, write};
    const VNC: &str = "2d4b8991-a043-4d4d-a79d-d0051ca09aee";
    const INDEPENDENT: &str = "58629e7e-6504-46f7-a294-ce1732b83b82";
    for action in ["vnc", "close", "ssh"] {
        let mut h = Harness::new(Reply::Process).await;
        let peer = Peer::new().await;
        let vnc = VncRuntime::official(
            http_client(HttpClientConfig {
                api_url: h.api.base_url(),
                vercel_bypass: None,
                client_session_id: "vnc-isolation".into(),
            }),
            TOKEN,
            h.identity,
        )
        .unwrap()
        .unwrap();
        h.restart_with_vnc(Arc::clone(&vnc)).await;
        let resolve = h.resolve(h.credential(true)).await;
        let independent = h.resolve_connection(INDEPENDENT, h.credential(true)).await;
        let (runtime, session, bridge) = desktop(&h, &peer, VNC, vnc).await;
        let ssh_id = if action == "ssh" {
            INDEPENDENT
        } else {
            CONNECTION
        };
        let shell = rpc(
            &h,
            "start",
            json!({"sshConnectionId":ssh_id,"program":{"type":"shell"},"pty":false}),
        )
        .await;
        assert_eq!(shell["type"], "started");
        let shell = shell["session_id"].clone();
        state(&h, &shell, "running").await;
        let directory = tempfile::tempdir().unwrap();
        let release = directory.path().join("release");
        let mut request = super::harness::params();
        request["sshConnectionId"] = json!(ssh_id);
        request["command"] = json!(format!(
            "while [ ! -e '{}' ]; do sleep 0.01; done; printf once",
            release.display()
        ));
        let (exec, ()) = tokio::join!(h.request(request), async {
            wait_for(|| h.observed.commands.lock().unwrap().len() == 1).await;
            if action == "close" {
                let closed = h
                    .raw(
                        json!({"version":1,"method":"vnc.session.close","remaining_ms":60000,
                    "params":{"sessionId":session}})
                        .to_string(),
                    )
                    .await;
                assert_eq!(terminal(&closed)["outcome"], "closed");
            } else {
                assert!(runtime.handle(&ably_subscriber::Message {
                    name: Some(format!("{action}-authority-invalidated")),
                    data: json!({"runId":h.run,"connectionId":if action=="vnc" {VNC} else {CONNECTION}}),
                    id: None, client_id: None, timestamp: None,
                }));
            }
            tokio::time::timeout(Duration::from_secs(5), bridge)
                .await
                .unwrap()
                .unwrap();
            assert!(!h.cancel.is_cancelled());
            let listed = h.raw(json!({"version":1,"method":"vnc.session.list","remaining_ms":60000,"params":{}}).to_string()).await;
            assert_eq!(terminal(&listed)["sessions"], json!([]));
            write(&h, &shell, "printf live; exit 0\n", false).await;
            state(&h, &shell, "finished").await;
            assert_eq!(
                bytes(&rpc(&h, "read", json!({"sessionId":shell,"cursor":0})).await),
                b"live"
            );
            std::fs::write(&release, []).unwrap();
        });
        assert_eq!(terminal(&exec)["type"], "finished");
        assert_eq!(super::output(&exec, "stdout"), b"once");
        resolve.assert_calls_async(1).await;
        independent
            .assert_calls_async(usize::from(action == "ssh"))
            .await;
        h.shutdown().await;
    }
}

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
                    .path(format!("/api/runners/runs/{}/vnc/resolve", harness.run))
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .is_true(optional_kerberos_request(
                        json!({
                            "connectionId": CONNECTION,
                            "runnerIdentity": {
                                "runnerId": harness.identity.runner_id(),
                                "heartbeatGeneration": 27
                            },
                            "supportedProfiles": supported_profiles(true)
                        }),
                        true,
                    ));
                then.status(200)
                    .header("X-VNC-Connection-Created-At", super::harness::CREATED_AT)
                    .json_body(json!({
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
        vnc_check.assert_calls_async(1).await;
        harness.shutdown().await;
    }
}
