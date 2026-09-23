mod gateway;
mod live;

use super::{
    harness::{CONNECTION, Harness, PASSWORD, Reply, params},
    output, sessions, terminal, wait_for,
};
use gateway::{CLIENT, Mode, SECRET};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

fn credential(h: &Harness, password: bool, pinned: bool) -> Value {
    let direct = h.credential(pinned);
    let authentication = if password {
        json!({"method":"password","password":PASSWORD})
    } else {
        json!({"method":"private_key","privateKey":direct["privateKey"],"passphrase":null})
    };
    json!({"outcome":"resolved_access", "host":"ssh.example.com", "port":443,
        "username":"test-user", "generation":7, "learnedHostKey":direct["learnedHostKey"],
        "authentication":authentication,
        "access":{"configId":"a10df3be-c1cd-4d62-b180-4462679acf63","generation":1,"clientId":CLIENT,"clientSecret":SECRET}})
}

#[tokio::test]
async fn byte_adapter_handles_partial_writes_and_ping_during_socket_backpressure() {
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{Arc, atomic::AtomicBool};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::{
        WebSocketStream,
        tungstenite::{
            Message,
            protocol::{Role, WebSocketConfig},
        },
    };
    let (client, server) = tokio::io::duplex(64);
    let config = WebSocketConfig::default()
        .write_buffer_size(0)
        .max_write_buffer_size(64 * 1024);
    let client = WebSocketStream::from_raw_socket(client, Role::Client, Some(config)).await;
    let mut server = WebSocketStream::from_raw_socket(server, Role::Server, Some(config)).await;
    let failed = Arc::new(AtomicBool::new(false));
    let stream = super::super::access::ByteStream::new(client, Arc::clone(&failed));
    let (mut reader, mut writer) = tokio::io::split(stream);
    let bytes = vec![0x5a; 100_001];
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            async {
                writer.write_all(&bytes).await.unwrap();
                writer.flush().await.unwrap();
            },
            async {
                let mut first = [0];
                reader.read_exact(&mut first).await.unwrap();
                assert_eq!(first, [b'o']);
                let mut rest = vec![];
                reader.read_to_end(&mut rest).await.unwrap();
                assert_eq!(rest, b"k");
            },
            async {
                server
                    .send(Message::Ping(b"backpressure".to_vec().into()))
                    .await
                    .unwrap();
                let mut received = vec![];
                let mut pong = false;
                while received.len() < bytes.len() || !pong {
                    match server.next().await.unwrap().unwrap() {
                        Message::Binary(data) => {
                            assert!(data.len() <= 16 * 1024);
                            received.extend(data);
                        }
                        Message::Pong(data) => {
                            assert_eq!(data.as_ref(), b"backpressure");
                            pong = true;
                        }
                        other => panic!("unexpected frame: {other:?}"),
                    }
                }
                assert_eq!(received, bytes);
                server
                    .send(Message::Binary(b"ok".to_vec().into()))
                    .await
                    .unwrap();
                server.close(None).await.unwrap();
            },
        );
    })
    .await
    .unwrap();
    assert!(!failed.load(Ordering::Acquire));
}

#[tokio::test]
async fn access_sessions_survive_notification_outages_without_replaying_work() {
    let (mut h, gateway) = gateway::setup(Reply::Process, Mode::Proxy, "ssh.example.com").await;
    let resolve = h.resolve(credential(&h, true, true)).await;
    super::notifications::session_continuity(&h).await;
    resolve.assert_calls_async(1).await;
    h.shutdown().await;
    wait_for(|| {
        gateway.observed.closed.load(Ordering::SeqCst) == h.observed.auth.load(Ordering::SeqCst)
    })
    .await;
}

#[tokio::test]
async fn access_in_flight_exec_completes_once_across_notification_outages() {
    let (mut h, gateway) = gateway::setup(Reply::Process, Mode::Proxy, "ssh.example.com").await;
    let _resolve = h.resolve(credential(&h, true, true)).await;
    super::notifications::exec_continuity(&h).await;
    h.shutdown().await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn access_file_transfer_completes_across_notification_outages() {
    let (mut h, gateway) =
        gateway::setup(Reply::Sftp("normal"), Mode::Proxy, "ssh.example.com").await;
    let _resolve = h.resolve(credential(&h, true, true)).await;
    super::files::upload_across_notification_outages(&h).await;
    h.shutdown().await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 2).await;
}

#[tokio::test]
async fn tls_binary_carrier_preserves_key_password_output_and_idle_reuse() {
    for password in [false, true] {
        let (mut h, gateway) =
            gateway::setup(Reply::default(), Mode::Fragmented, "ssh.example.com").await;
        let resolve = h.resolve(credential(&h, password, true)).await;
        let mut notifications = h.notifications();
        for event in super::notifications::outage_events() {
            notifications.send(event).await;
            let frames = h.request(params()).await;
            assert_eq!(terminal(&frames)["type"], "finished", "{frames:?}");
            assert_eq!(terminal(&frames)["exit"]["code"], 7);
            assert_eq!(output(&frames, "stdout"), b"hello\0\xff");
            assert_eq!(output(&frames, "stderr"), b"warning\n");
            assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
        }
        resolve.assert_calls_async(1).await;
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
        assert_eq!(
            *gateway.observed.requests.lock().unwrap(),
            vec![("ssh.example.com".into(), CLIENT.into(), SECRET.into())]
        );
        assert_eq!(
            *h.observed.queries.lock().unwrap(),
            vec![("ssh.example.com.".into(), 443)]
        );
        wait_for(|| gateway.observed.pongs.load(Ordering::SeqCst) == 1).await;
        h.shutdown().await;
        wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
    }
}

#[tokio::test]
async fn gateway_failures_are_structured_without_leaking_or_ssh_fallback() {
    let mut cases = vec![];
    for status in [401, 403, 302, 200, 429, 503] {
        let response = format!(
            "HTTP/1.1 {status} Test\r\nLocation: https://elsewhere.example/\r\nX-Reflected: {SECRET}\r\nContent-Length: 0\r\n\r\n"
        );
        let reason = match status {
            401 | 403 => "access_rejected",
            429 | 503 => "network_failure",
            _ => "access_protocol_failure",
        };
        cases.push((Mode::Response(response), "ssh.example.com", reason));
    }
    cases.extend([
        (Mode::Proxy,"wrong.example.com","access_tls_failure"),
        (Mode::Extension,"ssh.example.com","access_protocol_failure"),
        (Mode::Text,"ssh.example.com","access_protocol_failure"),
        (Mode::Oversized,"ssh.example.com","access_protocol_failure"),
        (Mode::OversizedFragmented,"ssh.example.com","access_protocol_failure"),
        (Mode::Response(format!("HTTP/1.1 101 Switching Protocols\r\nX-Large: {}", "x".repeat(40*1024))),"ssh.example.com","access_protocol_failure"),
        (Mode::Response("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n".into()),"ssh.example.com","access_protocol_failure"),
    ]);
    for (mode, cert_host, reason) in cases {
        let (mut h, _gateway) = gateway::setup(Reply::default(), mode, cert_host).await;
        let dispatcher = h.take_dispatcher();
        let _resolve = h.resolve(credential(&h, true, true)).await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(
                        json!({"expectedGeneration":7,"failureReason":reason}).to_string(),
                    )
                    .body_excludes("canary");
                then.status(200).json_body(json!({"outcome":"recorded"}));
            })
            .await;
        let frames = h.request(params()).await;
        assert_eq!(terminal(&frames)["type"], "failed", "{reason}: {frames:?}");
        assert_eq!(terminal(&frames)["effects"], "not_started");
        assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
        dispatcher.shutdown().await;
        report.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn cancellation_during_tls_and_upgrade_physically_closes_the_gateway() {
    for mode in [Mode::StallTls, Mode::StallUpgrade] {
        let (mut h, gateway) = gateway::setup(Reply::default(), mode, "ssh.example.com").await;
        let _resolve = h.resolve(credential(&h, true, true)).await;
        let (_, ()) = tokio::join!(h.request(params()), async {
            wait_for(|| gateway.observed.stalled.load(Ordering::SeqCst) == 1).await;
            h.lifecycle.cancel();
        });
        // Sandbox teardown also cancels the guest stream; a terminal reply is not
        // guaranteed. Observe actual network/park cleanup and no authentication.
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        assert!(h.observed.commands.lock().unwrap().is_empty());
        wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
        wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
        drop(h.control.try_fence_normal_operations().unwrap());
        h.shutdown().await;
    }
}

#[tokio::test]
async fn gateway_authentication_does_not_replace_ssh_host_trust() {
    for outcome in ["pinned", "host_key_mismatch", "configuration_changed"] {
        let (mut h, _gateway) =
            gateway::setup(Reply::default(), Mode::Proxy, "ssh.example.com").await;
        let _resolve = h.resolve(credential(&h, true, false)).await;
        let pin = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/pin", h.run))
                    .json_body_includes(json!({"expectedGeneration":7}).to_string());
                then.status(200).json_body(if outcome == "pinned" {
                    json!({"outcome":"pinned","generation":8})
                } else {
                    json!({"outcome":outcome})
                });
            })
            .await;
        let frames = h.request(params()).await;
        pin.assert_calls_async(1).await;
        if outcome == "pinned" {
            assert_eq!(terminal(&frames)["type"], "finished");
        } else {
            assert_eq!(terminal(&frames)["failure_reason"], outcome);
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        }
        h.shutdown().await;
    }
}

#[tokio::test]
async fn invalidation_during_upgrade_closes_the_old_token_connection_without_retry() {
    let (mut h, gateway) =
        gateway::setup(Reply::default(), Mode::StallUpgrade, "ssh.example.com").await;
    let resolve = h.resolve(credential(&h, true, true)).await;
    let (frames, ()) = tokio::join!(h.request(params()), async {
        wait_for(|| gateway.observed.stalled.load(Ordering::SeqCst) == 1).await;
        h.runtime.ably_message(&ably_subscriber::Message {
            name: Some("ssh-authority-invalidated".into()),
            data: json!({"runId":h.run,"connectionId":CONNECTION}),
            id: None,
            client_id: None,
            timestamp: None,
        });
    });
    assert_eq!(terminal(&frames)["failure_reason"], "configuration_changed");
    assert_eq!(terminal(&frames)["effects"], "not_started");
    resolve.assert_calls_async(1).await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
    assert_eq!(gateway.observed.opened.load(Ordering::SeqCst), 1);
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    h.shutdown().await;
}

#[tokio::test]
async fn protected_handoffs_validate_recipient_and_headers_before_network() {
    let h = Harness::new(Reply::default()).await;
    for (field, value) in [
        ("host", json!("127.0.0.1")),
        ("host", json!("https://ssh.example.com")),
        ("host", json!("evil.example/#ssh.example.com")),
        ("port", json!(22)),
    ] {
        let mut body = credential(&h, true, true);
        body[field] = value;
        let resolve = h.resolve(body).await;
        let frames = h.request(params()).await;
        assert_eq!(terminal(&frames)["failure_reason"], "authority_failure");
        resolve.delete_async().await;
    }
    for token in ["", "token\r\nHost: other.example", " token", "tökén"] {
        let mut body = credential(&h, true, true);
        body["access"]["clientSecret"] = json!(token);
        let resolve = h.resolve(body).await;
        assert_eq!(
            terminal(&h.request(params()).await)["failure_reason"],
            "authority_failure"
        );
        resolve.delete_async().await;
    }
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert!(h.observed.queries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn protected_mixed_dns_and_known_host_mismatch_never_authenticate() {
    for unsafe_dns in [true, false] {
        let (mut h, gateway) =
            gateway::setup(Reply::default(), Mode::Proxy, "ssh.example.com").await;
        let mut body = credential(&h, true, true);
        if unsafe_dns {
            h.network
                .answers
                .lock()
                .unwrap()
                .push("127.0.0.1:443".parse().unwrap());
        } else {
            use base64::Engine;
            body["learnedHostKey"]["fingerprint"] = json!(format!(
                "SHA256:{}",
                base64::engine::general_purpose::STANDARD_NO_PAD.encode([0; 32])
            ));
        }
        let _resolve = h.resolve(body).await;
        let frames = h.request(params()).await;
        assert_eq!(
            terminal(&frames)["failure_reason"],
            if unsafe_dns {
                "unsafe_destination"
            } else {
                "host_key_mismatch"
            }
        );
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        if unsafe_dns {
            assert_eq!(gateway.observed.opened.load(Ordering::SeqCst), 0);
        }
        h.shutdown().await;
    }
}

#[tokio::test]
async fn access_backpressured_stdin_keeps_output_and_controls_responsive() {
    use base64::Engine;
    let (mut h, gateway) =
        gateway::setup(Reply::BlockedInput, Mode::Proxy, "ssh.example.com").await;
    let _resolve = h.resolve(credential(&h, true, true)).await;
    let id = sessions::start(&h, json!({"type":"exec","command":"hold"}), false).await;
    sessions::state(&h, &id, "running").await;
    let request = json!({"version":1,"method":"ssh.session.write","remaining_ms":3000,
        "params":{"sessionId":id,"dataBase64":base64::engine::general_purpose::STANDARD.encode(vec![b'x';16384])}}).to_string();
    let (frames, ()) = tokio::join!(h.raw(request), async {
        wait_for(|| !h.observed.input.lock().unwrap().is_empty()).await;
        let read = sessions::rpc(
            &h,
            "read",
            json!({"sessionId":id,"cursor":0,"waitMs":10000}),
        )
        .await;
        assert_eq!(sessions::bytes(&read), b"output during blocked input");
        wait_for(|| gateway.observed.pongs.load(Ordering::SeqCst) == 1).await;
    });
    assert_eq!(frames[0]["data"]["failure_reason"], "timed_out");
    assert_eq!(frames[0]["data"]["effects"], "unknown");
    assert_eq!(*h.observed.input.lock().unwrap(), b"x");
    h.shutdown().await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn session_stdin_and_invalidation_use_the_same_carrier_without_replay() {
    let (mut h, gateway) = gateway::setup(Reply::Process, Mode::Proxy, "ssh.example.com").await;
    let resolve = h.resolve(credential(&h, true, true)).await;
    let id = sessions::start(&h, json!({"type":"shell"}), false).await;
    sessions::state(&h, &id, "running").await;
    sessions::write(&h, &id, "printf 'access-session-marker\\n'\n", false).await;
    let read = sessions::rpc(
        &h,
        "read",
        json!({"sessionId":id,"cursor":0,"waitMs":10000}),
    )
    .await;
    assert!(String::from_utf8_lossy(&sessions::bytes(&read)).contains("access-session-marker"));
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
    h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    });
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
    resolve.delete_async().await;
    let mut next = credential(&h, true, true);
    next["generation"] = json!(8);
    next["access"]["generation"] = json!(2);
    next["access"]["clientSecret"] = json!("cfast_rotated-canary");
    let _resolve = h.resolve(next).await;
    let next_id = sessions::start(&h, json!({"type":"exec","command":"printf fresh"}), true).await;
    sessions::state(&h, &next_id, "finished").await;
    assert_eq!(
        gateway.observed.requests.lock().unwrap()[1].2,
        "cfast_rotated-canary"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
    h.shutdown().await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 2).await;
}

#[tokio::test]
async fn shared_token_rotation_reopens_bound_hosts_without_evicting_another_configuration() {
    let (mut h, gateway) = gateway::setup(Reply::default(), Mode::Proxy, "ssh.example.com").await;
    let ids = [
        CONNECTION.to_owned(),
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    ];
    let mut originals = vec![];
    for (index, id) in ids.iter().enumerate() {
        let mut body = credential(&h, true, true);
        if index == 2 {
            body["access"]["configId"] = json!(uuid::Uuid::new_v4());
            body["access"]["clientSecret"] = json!("cfast_independent-canary");
        }
        originals.push(
            h.api
                .mock_async(|when, then| {
                    when.method("POST")
                        .path(format!("/api/runners/runs/{}/ssh/resolve", h.run))
                        .json_body_includes(json!({"connectionId":id}).to_string());
                    then.status(200).json_body(body);
                })
                .await,
        );
        let frames = h
            .request(json!({"sshConnectionId":id,"command":"true"}))
            .await;
        assert_eq!(terminal(&frames)["type"], "finished");
    }
    let mut rotated = vec![];
    for index in 0..2 {
        originals[index].delete_async().await;
        let id = &ids[index];
        let mut body = credential(&h, true, true);
        body["generation"] = json!(8);
        body["access"]["generation"] = json!(2);
        body["access"]["clientSecret"] = json!("cfast_shared-rotated-canary");
        rotated.push(
            h.api
                .mock_async(|when, then| {
                    when.method("POST")
                        .path(format!("/api/runners/runs/{}/ssh/resolve", h.run))
                        .json_body_includes(json!({"connectionId":id}).to_string());
                    then.status(200).json_body(body);
                })
                .await,
        );
        // Before a delivered notification, the accepted Run snapshot stays usable.
        let frames = h
            .request(json!({"sshConnectionId":id,"command":"true"}))
            .await;
        assert_eq!(terminal(&frames)["type"], "finished");
        rotated[index].assert_calls_async(0).await;
        h.runtime.ably_message(&ably_subscriber::Message {
            name: Some("ssh-authority-invalidated".into()),
            data: json!({"runId":h.run,"connectionId":id}),
            id: None,
            client_id: None,
            timestamp: None,
        });
    }
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 2).await;
    for id in &ids {
        let frames = h
            .request(json!({"sshConnectionId":id,"command":"true"}))
            .await;
        assert_eq!(terminal(&frames)["type"], "finished");
    }
    for resolve in rotated {
        resolve.assert_calls_async(1).await;
    }
    originals[2].assert_calls_async(1).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 5);
    assert_eq!(
        gateway
            .observed
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.2.as_str())
            .collect::<Vec<_>>(),
        [
            SECRET,
            SECRET,
            "cfast_independent-canary",
            "cfast_shared-rotated-canary",
            "cfast_shared-rotated-canary"
        ],
    );
    h.shutdown().await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 5).await;
}

#[tokio::test]
async fn sftp_files_preserve_bytes_through_bounded_origin_reads() {
    use sha2::{Digest, Sha256};
    for password in [false, true] {
        let (mut h, gateway) = gateway::setup(
            Reply::Sftp("normal"),
            Mode::BoundedOrigin,
            "ssh.example.com",
        )
        .await;
        let _resolve = h.resolve(credential(&h, password, true)).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bounded origin file");
        let bytes: Vec<u8> = (0..256 * 1024 + 17).map(|n| (n % 251) as u8).collect();
        let upload = super::files::upload(&h, &path, &bytes, false).await;
        assert_eq!(upload["type"], "completed", "{upload}");
        assert_eq!(upload["sha256"], hex::encode(Sha256::digest(&bytes)));
        assert_eq!(upload["bytes"], bytes.len());
        assert_eq!(upload["effects"], "completed");
        assert!(upload["residue"].is_null());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let (download, received) = super::files::download(&h, &path).await;
        assert_eq!(download["type"], "completed", "{download}");
        assert_eq!(download["bytes"], bytes.len());
        assert_eq!(download["sha256"], upload["sha256"]);
        assert_eq!(received, bytes);
        wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
        h.shutdown().await;
        wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 2).await;
    }
}

#[tokio::test]
async fn sftp_files_roundtrip_over_access_with_real_bytes_and_hashes() {
    use sha2::{Digest, Sha256};
    let (mut h, gateway) =
        gateway::setup(Reply::Sftp("normal"), Mode::Fragmented, "ssh.example.com").await;
    let _resolve = h.resolve(credential(&h, true, true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file with spaces");
    for size in [0, 1024 * 1024 + 17] {
        let bytes: Vec<u8> = (0..size).map(|n| (n % 256) as u8).collect();
        let upload = super::files::upload(&h, &path, &bytes, size != 0).await;
        assert_eq!(upload["type"], "completed", "{upload}");
        assert_eq!(upload["sha256"], hex::encode(Sha256::digest(&bytes)));
        let (download, received) = super::files::download(&h, &path).await;
        assert_eq!(download["type"], "completed", "{download}");
        assert_eq!(download["sha256"], upload["sha256"]);
        assert_eq!(received, bytes);
    }
    h.shutdown().await;
    wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 4).await;
}
