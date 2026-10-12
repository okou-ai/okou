//! Saved-host RPC and forwarding over genuine SDK encrypted DERP/TCP.
//! Only external OAuth/control/DERP/SSH peers are synthetic.

use super::*;
use crate::ssh::tests::{
    files,
    harness::{CONNECTION, Harness, PASSWORD, Reply, params},
    sessions,
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tokio_util::sync::CancellationToken;

const OTHER: &str = "11111111-1111-4111-8111-111111111112";

#[tokio::test]
async fn native_common_cleanup_rejection_reaches_guest_rpc_without_retry_or_login() {
    let mut h = Harness::new(Reply::default()).await;
    let api = Api::secure_with_delete_status(None, 500).await;
    let home = Server::secure().await;
    let control = Control::new(ACCEPTED.to_vec(), map(&home), KeyReply::Missing, false).await;
    let dial = api.secure.as_ref().unwrap().clone();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial.clone(),
        Relay::new(&home, WriteGate::new(), Arc::clone(&descriptors)),
    ));
    let dispatcher = h.take_dispatcher();
    let resolve = h
        .resolve(credential(&h, uuid::Uuid::new_v4(), Case::Exec))
        .await;
    control.allow_all();
    let frames = bounded(h.request(params())).await;
    let terminal = &frames.last().unwrap()["data"];
    assert_eq!(terminal["failure_reason"], "network_failure", "{frames:?}");
    assert_eq!(terminal["effects"], "not_started");
    let failed = bounded(dispatcher.shutdown()).await.unwrap_err();
    assert_eq!(failed, crate::guest_rpc::CleanupError::Native);
    assert_eq!(
        failed.to_string(),
        "native SSH resource cleanup was not confirmed"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
    assert!(h.observed.queries.lock().unwrap().is_empty());
    resolve.assert_calls_async(1).await;
    assert!(descriptors.lock().unwrap().is_empty());
    control.assert_control_closed();
    dial.assert_closed(3);
    api.assert_contract(1, 1);
    home.task.abort();
    assert!(matches!(bounded(home.task).await, Err(error) if error.is_cancelled()));
    api.finish().await;
    control.finish().await;
}

#[tokio::test]
async fn native_common_exec_reuse_and_forwarding_preserve_real_binary_bytes() {
    run_case(Case::Exec).await;
}

#[tokio::test]
async fn native_common_sessions_preserve_original_b_after_closing_a() {
    run_case(Case::Sessions).await;
}

#[tokio::test]
async fn native_common_sftp_roundtrips_real_binary_files() {
    run_case(Case::Files).await;
}

#[tokio::test]
async fn native_common_password_login_preserves_binary_output_and_idle_reuse() {
    run_case(Case::Password).await;
}

#[tokio::test]
async fn native_common_wrong_host_pin_never_sends_login_or_command() {
    run_case(Case::WrongPin).await;
}

#[tokio::test]
async fn native_common_bad_password_is_independent_of_native_node_registration() {
    run_case(Case::BadPassword).await;
}

#[tokio::test]
async fn native_common_targeted_host_invalidation_preserves_original_other_host_session() {
    run_case(Case::TargetedSessions).await;
}

#[tokio::test]
async fn native_common_tofu_confirmation_advances_trust_before_password_login() {
    run_case(Case::Tofu).await;
}

#[tokio::test]
async fn native_common_tofu_configuration_race_never_sends_login_or_command() {
    run_case(Case::TofuChanged).await;
}

#[derive(Clone, Copy)]
enum Case {
    Exec,
    Sessions,
    TargetedSessions,
    Files,
    Password,
    WrongPin,
    BadPassword,
    Tofu,
    TofuChanged,
}

fn credential(h: &Harness, id: uuid::Uuid, case: Case) -> Value {
    let direct = h.credential(true);
    let mut value = json!({"outcome":"resolved_tailscale", "host":"peer.synthetic.ts.net.", "port":22,
        "username":"test-user", "generation":7, "learnedHostKey":direct["learnedHostKey"],
        "authentication":{"method":"private_key","privateKey":direct["privateKey"],"passphrase":null},
        "tailscale":{"configId":id,"generation":1,"clientId":"synthetic-client","clientSecret":"synthetic-secret","tags":["tag:ssh"]}});
    if matches!(
        case,
        Case::Password | Case::WrongPin | Case::BadPassword | Case::Tofu | Case::TofuChanged
    ) {
        value["authentication"] = json!({"method":"password", "password":
            if matches!(case, Case::BadPassword) { "wrong-password-canary" } else { PASSWORD }});
    }
    if matches!(case, Case::WrongPin) {
        use russh::keys::{Algorithm, HashAlg};
        value["learnedHostKey"]["fingerprint"] =
            crate::ssh::tests::harness::key(Algorithm::Ed25519)
                .fingerprint(HashAlg::Sha256)
                .to_string()
                .into();
    }
    if matches!(case, Case::Tofu | Case::TofuChanged) {
        value["learnedHostKey"] = Value::Null;
    }
    value
}

fn output(frames: &[Value], stream: &str) -> Vec<u8> {
    use base64::Engine;
    frames
        .iter()
        .filter(|f| {
            f["type"] == "event" && f["data"]["type"] == "output" && f["data"]["stream"] == stream
        })
        .flat_map(|f| {
            base64::engine::general_purpose::STANDARD
                .decode(f["data"]["data"].as_str().unwrap())
                .unwrap()
        })
        .collect()
}

async fn run_case(case: Case) {
    let mut h = Harness::new(match case {
        Case::Sessions | Case::TargetedSessions => Reply::Process,
        Case::Files => Reply::Sftp("normal"),
        _ => Reply::default(),
    })
    .await;
    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let key = NodeKeyPair::random();
    let mut value: Value = serde_json::from_slice(&map(&home)).unwrap();
    let mut peer = node(2, "peer.synthetic.ts.net.", 2, &key);
    peer["HomeDERP"] = 1.into();
    value["Peers"] = vec![peer].into();
    value["PacketFilter"] = json!([]);
    let control = Control::new(
        ACCEPTED.to_vec(),
        serde_json::to_vec(&value).unwrap(),
        KeyReply::Valid,
        false,
    )
    .await;
    let gate = WriteGate::new();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let dial = api.secure.as_ref().unwrap().clone();
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial.clone(),
        Relay::new(&home, Arc::clone(&gate), Arc::clone(&descriptors)),
    ));
    let id = uuid::Uuid::new_v4();
    let resolve = h.resolve(credential(&h, id, case)).await;
    let second = if matches!(case, Case::TargetedSessions) {
        Some(h.resolve_connection(OTHER, credential(&h, id, case)).await)
    } else {
        None
    };
    let pin = if matches!(case, Case::Tofu | Case::TofuChanged) {
        Some(
            h.pin_outcome(if matches!(case, Case::Tofu) {
                json!({"outcome":"pinned","generation":8})
            } else {
                json!({"outcome":"configuration_changed"})
            })
            .await,
        )
    } else {
        None
    };
    control.allow_all();
    let ssh = h.ssh();
    let opening = ssh.open_direct_tcpip(
        CONNECTION.parse().unwrap(),
        7,
        "desktop.internal",
        5900,
        CancellationToken::new(),
        tokio::time::Instant::now() + std::time::Duration::from_secs(15),
    );
    tokio::pin!(opening);
    let (frames, client) = bounded(async {
        tokio::select! {
            result = home.task => result.unwrap(),
            result = &mut opening => panic!("native SSH completed before external relay: {}", result.is_ok()),
        }
    }).await;
    let mut peers = Peers {
        services: vec![Service {
            task: None,
            frames: Some(frames),
            outgoing: VecDeque::new(),
            offset: 0,
            expected: key.public,
            client,
            closed: false,
            packets: 0,
        }],
        sides: vec![wire::DerpSide::new(key, client, 2)],
        destinations: vec![0],
        epoch: Instant::now(),
    };
    let channel = peers.sides[0].channel();
    let listener = peers
        .finish(channel.tcp_listen(wire::remote(2)))
        .await
        .unwrap();
    let target = *h.network.target.lock().unwrap();
    let stop = CancellationToken::new();
    let stopped = stop.clone();
    let proxy = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! { biased;
                _ = stopped.cancelled() => break,
                accepted = listener.accept() => {
                    let mut stream = accepted.unwrap();
                    connections.spawn(async move {
                        let mut ssh = tokio::net::TcpStream::connect(target).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut ssh).await;
                    });
                },
                result = connections.join_next(), if !connections.is_empty() => { result.unwrap().unwrap(); },
            }
        }
        connections.abort_all();
        while let Some(result) = connections.join_next().await {
            if let Err(error) = result {
                assert!(error.is_cancelled());
            }
        }
    });
    let opened = peers.finish(&mut opening).await;
    match case {
        Case::WrongPin | Case::BadPassword | Case::TofuChanged => {
            let expected = if matches!(case, Case::WrongPin) {
                crate::ssh::FailureReason::HostKeyMismatch
            } else if matches!(case, Case::BadPassword) {
                crate::ssh::FailureReason::AuthenticationFailed
            } else {
                crate::ssh::FailureReason::ConfigurationChanged
            };
            assert!(matches!(opened, Err(failure) if failure == expected));
            assert_eq!(
                h.observed.auth.load(Ordering::SeqCst),
                usize::from(matches!(case, Case::BadPassword))
            );
            assert!(h.observed.commands.lock().unwrap().is_empty());
        }
        _ => {
            forwarding(&mut peers, &h, opened.unwrap()).await;
            exercise(&mut peers, &h, case).await;
        }
    }
    assert!(h.observed.queries.lock().unwrap().is_empty());
    resolve.assert_calls_async(1).await;
    if let Some(second) = second {
        second.assert_calls_async(1).await;
    }
    if let Some(pin) = pin {
        pin.assert_calls_async(1).await;
    }
    peers.finish(h.shutdown()).await;
    bounded(gate.destroyed()).await;
    assert_eq!(descriptors.lock().unwrap().len(), 1);
    control.assert_control_closed();
    dial.assert_closed(2);
    api.assert_contract(1, 0);
    stop.cancel();
    bounded(proxy).await.unwrap();
    api.finish().await;
    control.finish().await;
}

async fn forwarding(peers: &mut Peers, h: &Harness, mut forward: crate::ssh::DirectTcpIpStream) {
    let mut forwarded = peers.finish(h.accept_forwarded()).await;
    peers
        .finish(async {
            forward.write_all(b"client\0\xff").await.unwrap();
            let mut received = [0; 8];
            forwarded.read_exact(&mut received).await.unwrap();
            assert_eq!(&received, b"client\0\xff");
            forwarded.write_all(b"server\0\xfe").await.unwrap();
            forward.read_exact(&mut received).await.unwrap();
            assert_eq!(&received, b"server\0\xfe");
        })
        .await;
    drop(forward);
    drop(forwarded);
}

async fn exercise(peers: &mut Peers, h: &Harness, case: Case) {
    match case {
        Case::Exec | Case::Password | Case::Tofu => {
            for _ in 0..2 {
                let frames = peers.finish(h.request(params())).await;
                assert_eq!(
                    frames.last().unwrap()["data"]["type"],
                    "finished",
                    "{frames:?}"
                );
                assert_eq!(output(&frames, "stdout"), b"hello\0\xff");
                assert_eq!(output(&frames, "stderr"), b"warning\n");
            }
            assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
            // The dedicated forwarding socket retires; the two execs reuse
            // one later physical SSH transport, within the same native node.
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
        }
        Case::Sessions | Case::TargetedSessions => {
            let a = peers
                .finish(sessions::start(h, json!({"type":"shell"}), false))
                .await;
            let b = if matches!(case, Case::TargetedSessions) {
                let started = peers
                    .finish(sessions::rpc(
                        h,
                        "start",
                        json!({
                            "sshConnectionId":OTHER, "program":{"type":"shell"}, "pty":false
                        }),
                    ))
                    .await;
                assert_eq!(started["type"], "started");
                started["session_id"].clone()
            } else {
                peers
                    .finish(sessions::start(h, json!({"type":"shell"}), false))
                    .await
            };
            peers.finish(sessions::state(h, &a, "running")).await;
            peers.finish(sessions::state(h, &b, "running")).await;
            if matches!(case, Case::TargetedSessions) {
                use ably_subscriber::{Event, Message};
                let mut notifications = h.notifications();
                peers
                    .finish(notifications.send(Some(Event::Message(Message {
                        name: Some("ssh-authority-invalidated".into()),
                        data: json!({"runId":h.run,"connectionId":CONNECTION}),
                        id: None,
                        client_id: None,
                        timestamp: None,
                    }))))
                    .await;
                let failed = peers
                    .finish(sessions::rpc(h, "status", json!({"sessionId":a})))
                    .await;
                assert_eq!(failed["type"], "failed");
                assert_eq!(failed["failure_reason"], "unavailable");
                peers
                    .finish(notifications.send(Some(Event::Disconnected { reason: None })))
                    .await;
                peers
                    .finish(notifications.send(Some(Event::Error {
                        code: 40142,
                        message: "synthetic unavailable".into(),
                    })))
                    .await;
            } else {
                let closed = peers
                    .finish(sessions::rpc(h, "close", json!({"sessionId":a})))
                    .await;
                assert_eq!(closed["type"], "closed");
            }
            peers
                .finish(sessions::write(
                    h,
                    &b,
                    "printf original-b-survives\n",
                    false,
                ))
                .await;
            let read = peers
                .finish(sessions::rpc(
                    h,
                    "read",
                    json!({"sessionId":b,"cursor":0,"waitMs":5000}),
                ))
                .await;
            assert_eq!(sessions::bytes(&read), b"original-b-survives");
            peers.finish(sessions::state(h, &b, "running")).await;
        }
        Case::Files => {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("native binary file");
            let bytes: Vec<_> = (0..65539).map(|n| (n % 256) as u8).collect();
            let uploaded = peers.finish(files::upload(h, &path, &bytes, false)).await;
            assert_eq!(uploaded["type"], "completed", "{uploaded}");
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            let (downloaded, received) = peers.finish(files::download(h, &path)).await;
            assert_eq!(downloaded["type"], "completed", "{downloaded}");
            assert_eq!(received, bytes);
        }
        Case::WrongPin | Case::BadPassword | Case::TofuChanged => {
            panic!("early SSH failure must return before session assertions")
        }
    }
}
