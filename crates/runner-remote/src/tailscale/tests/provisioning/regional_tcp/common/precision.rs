//! Caller-visible distinctions using real production SDK/TLS/DERP/TCP boundaries.

use super::*;
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use futures_util::{SinkExt, StreamExt};

#[derive(Clone, Copy)]
enum Scenario {
    SilentPeer,
    ControlsOnly,
    TargetGone,
    UnrelatedGone,
    TcpReset,
    SshSilent,
    RelayPending,
    RelayFailure,
    RelayWritePending,
    RelayMove,
    MapFailure,
    Concurrent,
}

#[tokio::test]
async fn native_known_map_failure_precedes_generic_pending_tcp_guidance() {
    exercise(Scenario::MapFailure).await;
}

#[tokio::test]
async fn native_live_peer_region_change_updates_the_retained_operation_path() {
    exercise(Scenario::RelayMove).await;
}

#[tokio::test]
async fn native_partial_relay_write_keeps_queued_distinct_from_flushed() {
    exercise(Scenario::RelayWritePending).await;
}

#[tokio::test]
async fn native_same_peer_concurrency_shares_transport_but_never_private_tcp_replies() {
    exercise(Scenario::Concurrent).await;
}

#[tokio::test]
async fn native_timeout_keeps_flushed_peer_silence_distinct_from_unobserved_tcp() {
    exercise(Scenario::SilentPeer).await;
}

#[tokio::test]
async fn native_control_only_relay_activity_does_not_prove_online_peer_tunnel_progress() {
    exercise(Scenario::ControlsOnly).await;
}

#[tokio::test]
async fn native_selected_peer_gone_keeps_offline_map_facts_and_immutable_history() {
    exercise(Scenario::TargetGone).await;
}

#[tokio::test]
async fn native_unrelated_peer_gone_never_becomes_target_evidence() {
    exercise(Scenario::UnrelatedGone).await;
}

#[tokio::test]
async fn native_authenticated_tcp_reset_is_not_an_ssh_authentication_failure() {
    exercise(Scenario::TcpReset).await;
}

#[tokio::test]
async fn native_tcp_success_with_a_silent_ssh_server_keeps_the_later_pending_boundary() {
    exercise(Scenario::SshSilent).await;
}

#[tokio::test]
async fn native_non_home_relay_pending_tls_is_visible_after_home_readiness() {
    exercise(Scenario::RelayPending).await;
}

#[tokio::test]
async fn native_non_home_relay_setup_failure_is_retained_after_home_readiness() {
    exercise(Scenario::RelayFailure).await;
}

async fn exercise(scenario: Scenario) {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_diagnostics().await;
    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let mut other = if matches!(
        scenario,
        Scenario::RelayPending | Scenario::RelayFailure | Scenario::RelayMove
    ) {
        Some(Server::secure().await)
    } else {
        None
    };
    if matches!(scenario, Scenario::RelayFailure) {
        // Both advertised families target a physically closed external listener.
        let other = other.as_mut().unwrap();
        other.task.abort();
        assert!(matches!((&mut other.task).await, Err(error) if error.is_cancelled()));
    }
    let key = NodeKeyPair::random();
    let peer_key = key.public;
    let mut value: Value = serde_json::from_slice(&map(&home)).unwrap();
    let mut peer = node(2, "peer.synthetic.ts.net.", 2, &key);
    peer["HomeDERP"] = if other.is_some() { 2.into() } else { 1.into() };
    if matches!(scenario, Scenario::TargetGone) {
        peer["Online"] = false.into();
        peer["LastSeen"] = "2026-10-18T03:20:00Z".into();
    } else if matches!(scenario, Scenario::SilentPeer | Scenario::UnrelatedGone) {
        peer.as_object_mut().unwrap().remove("Online");
    }
    value["Peers"] = vec![peer].into();
    value["PacketFilter"] = json!([]);
    if let Some(other) = &other {
        let mut region = value["DERPMap"]["Regions"]["1"].clone();
        region["RegionID"] = 2.into();
        region["Nodes"][0]["RegionID"] = 2.into();
        region["Nodes"][0]["Name"] = "2a".into();
        region["Nodes"][0]["DERPPort"] = other.address.port().into();
        if matches!(scenario, Scenario::RelayFailure) {
            region["Nodes"][0]["IPv6"] = "::1".into();
        }
        value["DERPMap"]["Regions"]["2"] = region;
    }
    let control = Control::new(
        ACCEPTED.to_vec(),
        serde_json::to_vec(&value).unwrap(),
        KeyReply::Valid,
        false,
    )
    .await;
    let home_gate = WriteGate::new();
    let other_gate = WriteGate::new();
    if matches!(scenario, Scenario::RelayPending) {
        other_gate.pause_after(0);
    }
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let mut servers = vec![&home];
    let mut gates = vec![Arc::clone(&home_gate)];
    if let Some(other) = &other {
        servers.push(other);
        gates.push(Arc::clone(&other_gate));
    }
    let dial = api.secure.as_ref().unwrap().clone();
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial.clone(),
        Relay::multiple(&servers, &gates, Arc::clone(&descriptors)).production_tcp(),
    ));
    let id = uuid::Uuid::new_v4();
    let resolve = h.resolve(credential(&h, id, Case::Exec)).await;
    let other_resolve = if matches!(scenario, Scenario::Concurrent) {
        let mut credential = credential(&h, id, Case::Exec);
        credential["port"] = 23.into();
        Some(h.resolve_connection(OTHER, credential).await)
    } else {
        None
    };
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200).json_body(remote_inventory(
                &[(CONNECTION, 7), (OTHER, 7)],
                crate::ssh::tests::harness::CREATED_AT,
            ));
        })
        .await;
    control.allow_all();
    let mut retained_relay = None;
    let result = {
        let operation = h.raw(
            json!({"version":1,"method":"ssh.exec","remaining_ms":2500,"params":params()})
                .to_string(),
        );
        tokio::pin!(operation);
        let (mut frames, client) = bounded(async {
            tokio::select! {
                result = home.task => result.unwrap(),
                result = &mut operation => panic!("operation ended before home DERP: {result:?}"),
            }
        })
        .await;
        match scenario {
            Scenario::SilentPeer
            | Scenario::ControlsOnly
            | Scenario::TargetGone
            | Scenario::UnrelatedGone => {
                // Consume actual DERP output but withhold all external peer replies.
                let mut injected = matches!(scenario, Scenario::SilentPeer);
                let result = loop {
                    tokio::select! {
                        result = &mut operation => break result,
                        frame = frames.next() => {
                            let frame = frame.unwrap().unwrap();
                            assert!(frame.get().as_type::<frame::SendPacket>().is_some()
                                || frame.get().as_type::<frame::Pong>().is_some());
                            if !injected {
                                injected = true;
                                #[allow(deprecated)]
                                let keep_alive = frame::RawFrame { header: frame::Header::new(frame::FrameType::KeepAlive, 0).unwrap(), raw_body: &[] };
                                frames.send((keep_alive, &[][..])).await.unwrap();
                                frames.send((frame::RawFrame::from_body(&frame::Ping { payload: *b"control!" }, 0).unwrap(), &[][..])).await.unwrap();
                                if matches!(scenario, Scenario::TargetGone | Scenario::UnrelatedGone) {
                                    let gone = frame::PeerGone {
                                        key: if matches!(scenario, Scenario::TargetGone) { key.public } else { client },
                                        raw_reason: frame::PeerGoneReason::Disconnected.into(),
                                    };
                                    frames.send((frame::RawFrame::from_body(&gone, 0).unwrap(), &[][..])).await.unwrap();
                                }
                            }
                        }
                    }
                };
                retained_relay = Some(frames);
                result
            }
            Scenario::RelayPending | Scenario::RelayFailure => operation.await,
            Scenario::MapFailure => {
                tokio::select! {
                    result = &mut operation => panic!("operation ended before native traffic: {result:?}"),
                    frame = frames.next() => assert!(frame.unwrap().unwrap().get().as_type::<frame::SendPacket>().is_some()),
                }
                control
                    .update_map(json!({"Peers":[{"ID":2,"Name":"private-map-canary"}]}))
                    .await;
                operation.await
            }
            Scenario::TcpReset
            | Scenario::SshSilent
            | Scenario::RelayWritePending
            | Scenario::RelayMove
            | Scenario::Concurrent => {
                let mut services = vec![Service {
                    task: None,
                    frames: Some(frames),
                    outgoing: VecDeque::new(),
                    offset: 0,
                    expected: key.public,
                    client,
                    closed: false,
                    packets: 0,
                }];
                if matches!(scenario, Scenario::RelayMove) {
                    services.push(Service {
                        task: Some(other.take().unwrap().task),
                        frames: None,
                        outgoing: VecDeque::new(),
                        offset: 0,
                        expected: key.public,
                        client,
                        closed: false,
                        packets: 0,
                    });
                }
                let mut peers = Peers {
                    destinations: vec![0; services.len()],
                    services,
                    sides: vec![wire::DerpSide::with_ports(key, client, 2, vec![22, 23])],
                    epoch: Instant::now(),
                };
                // No listener gives a genuine encrypted TCP RST. An idle listener
                // completes TCP but never supplies an SSH banner or authentication.
                let listener = if matches!(
                    scenario,
                    Scenario::SshSilent | Scenario::RelayMove | Scenario::Concurrent
                ) {
                    Some(
                        peers
                            .finish(peers.sides[0].channel().tcp_listen(wire::remote(2)))
                            .await
                            .unwrap(),
                    )
                } else {
                    None
                };
                let result = if matches!(scenario, Scenario::Concurrent) {
                    let mut other_params = params();
                    other_params["sshConnectionId"] = OTHER.into();
                    let (first, second) = peers.finish(async {
                        tokio::join!(operation, h.raw(json!({"version":1,"method":"ssh.exec","remaining_ms":2500,"params":other_params}).to_string()))
                    }).await;
                    let second = &second.last().unwrap()["data"];
                    assert_eq!(second["failure_reason"], "network_failure");
                    let text = diagnostic_text(second);
                    assert!(
                        observed(text, "this TCP connection: authenticated TCP RST received") > 0,
                        "{text}"
                    );
                    assert_eq!(
                        observed(
                            text,
                            "this TCP connection: authenticated TCP SYN-ACK received"
                        ),
                        0,
                        "{text}"
                    );
                    assert!(
                        text.contains("private tcp endpoint: 100.64.0.2:23;"),
                        "{text}"
                    );
                    let history = h.raw(json!({"version":1,"method":"ssh.diagnose","params":{"attemptId":diagnostic_attempt(second)}}).to_string()).await;
                    assert_eq!(diagnostic_text(&history.last().unwrap()["data"]), text);
                    first
                } else if matches!(scenario, Scenario::RelayMove) {
                    let accepted = peers
                        .finish(async {
                            tokio::select! {
                                result = &mut operation => panic!("operation ended before TCP accept: {result:?}"),
                                accepted = listener.as_ref().unwrap().accept() => accepted.unwrap(),
                            }
                        })
                        .await;
                    assert!(
                        peers.services[1].packets > 0,
                        "TCP used the original region"
                    );
                    value["Peers"][0]["HomeDERP"] = 1.into();
                    control
                        .update_map(json!({"PeersChanged":value["Peers"]}))
                        .await;
                    // Actual old non-home IO destruction proves the authenticated
                    // map was adopted; the original TCP and SSH wait stay alive.
                    peers.finish(other_gate.destroyed()).await;
                    let result = peers.finish(operation).await;
                    drop(accepted);
                    result
                } else if matches!(scenario, Scenario::RelayWritePending) {
                    // Complete a genuine reset first, leaving shared crypto and
                    // DERP ready. Gate the next operation's actual TLS writer.
                    let first = peers.finish(operation).await;
                    assert_eq!(
                        first.last().unwrap()["data"]["failure_reason"],
                        "network_failure"
                    );
                    home_gate.pause_after(12);
                    let second = h.raw(json!({"version":1,"method":"ssh.exec","remaining_ms":2500,"params":params()}).to_string());
                    peers
                        .finish(async {
                            tokio::pin!(second);
                            tokio::select! {
                                result = &mut second => panic!("operation ended before partial TLS write: {result:?}"),
                                () = home_gate.pending() => {}
                            }
                            second.await
                        })
                        .await
                } else {
                    peers.finish(operation).await
                };
                drop(listener);
                result
            }
        }
    };
    let result = &result.last().unwrap()["data"];
    assert_eq!(result["type"], "failed", "{result}");
    assert_eq!(result["effects"], "not_started");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
    let text = diagnostic_text(result);
    assert!(
        text.contains("Actual path: embedded Tailscale over DERP"),
        "{text}"
    );
    assert!(text.contains("shared regional dependency"), "{text}");
    assert!(
        observed(text, "this TCP connection: TCP SYN produced") > 0,
        "{text}"
    );
    match scenario {
        Scenario::SilentPeer
        | Scenario::ControlsOnly
        | Scenario::TargetGone
        | Scenario::UnrelatedGone => {
            assert_eq!(result["failure_reason"], "timed_out");
            assert!(
                text.contains("Private TCP: pending at observation;"),
                "{text}"
            );
            assert!(
                observed(text, "shared peer: relay frames flushed locally") > 0,
                "{text}"
            );
            assert!(
                text.contains("authenticated TCP SYN-ACK received: not observed"),
                "{text}"
            );
            assert!(
                text.contains("peer-labelled frames received: not observed"),
                "{text}"
            );
            assert!(
                observed(text, "shared peer: WireGuard initiation produced") > 0,
                "{text}"
            );
            assert_eq!(
                observed(text, "shared peer: WireGuard response header received"),
                0,
                "{text}"
            );
            assert_eq!(
                observed(text, "shared peer: WireGuard transport-data produced"),
                0,
                "{text}"
            );
            assert!(
                text.contains("SYNs may still be awaiting encryption"),
                "{text}"
            );
            assert!(text.contains("credential preparation: passed."), "{text}");
            assert!(text.contains("authentication: not reached."), "{text}");
            assert!(text.contains("Background wait for peer data;"), "{text}");
            let status = match scenario {
                Scenario::TargetGone => "offline",
                Scenario::ControlsOnly => "online",
                _ => "unknown",
            };
            assert!(
                text.contains(&format!("Selected peer control-plane status: {status};")),
                "{text}"
            );
            if !matches!(scenario, Scenario::SilentPeer) {
                assert_eq!(
                    observed(text, "Shared selected relay KeepAlive"),
                    1,
                    "{text}"
                );
                assert_eq!(observed(text, "Shared selected relay Ping"), 1, "{text}");
            }
            if matches!(scenario, Scenario::TargetGone) {
                assert!(
                    text.contains("Selected peer PeerGone: disconnected;"),
                    "{text}"
                );
                assert!(
                    text.contains("Peer last seen by control: 2026-10-18T03:20:00"),
                    "{text}"
                );
                assert!(
                    text.contains("Peer offline notification estimated locally at:"),
                    "{text}"
                );
                control.update_map(json!({"OnlineChange":{"2":true}})).await;
                // A later actual operation must observe the updated authenticated
                // map; querying the first attempt still returns its offline facts.
                let later = h.raw(
                    json!({"version":1,"method":"ssh.exec","remaining_ms":2500,"params":params()})
                        .to_string(),
                );
                tokio::pin!(later);
                let later = loop {
                    tokio::select! {
                        result = &mut later => break result,
                        frame = retained_relay.as_mut().unwrap().next() => {
                            assert!(frame.unwrap().unwrap().get().as_type::<frame::SendPacket>().is_some());
                        }
                    }
                };
                let updated = diagnostic_text(&later.last().unwrap()["data"]);
                assert!(
                    updated.contains("Selected peer control-plane status: online;"),
                    "{updated}"
                );
                assert!(!updated.contains("Peer last seen by control:"), "{updated}");
            } else {
                assert!(
                    !text.contains("Selected peer PeerGone: disconnected;"),
                    "{text}"
                );
            }
        }
        Scenario::TcpReset => {
            assert_eq!(result["failure_reason"], "network_failure");
            assert!(
                observed(text, "this TCP connection: authenticated TCP RST received") > 0,
                "{text}"
            );
            assert!(text.contains("detail: reset or closed"), "{text}");
            assert!(
                text.contains("Next step: An authenticated TCP RST was observed"),
                "{text}"
            );
            assert!(
                observed(text, "shared peer: WireGuard response header received") > 0,
                "{text}"
            );
            assert!(
                observed(text, "shared peer: WireGuard transport-data produced") > 0,
                "{text}"
            );
            assert!(
                observed(
                    text,
                    "shared peer: WireGuard transport-data header received"
                ) > 0,
                "{text}"
            );
        }
        Scenario::SshSilent | Scenario::RelayMove | Scenario::Concurrent => {
            assert_eq!(result["failure_reason"], "timed_out");
            assert!(
                text.contains("Private TCP: passed at observation;"),
                "{text}"
            );
            if matches!(scenario, Scenario::RelayMove) {
                assert!(text.contains("Selected relay region: 1;"), "{text}");
                assert!(
                    text.contains("setup already started when selected;"),
                    "{text}"
                );
            }
            assert!(text.contains("ssh proof: pending."), "{text}");
            assert_eq!(
                observed(text, "this TCP connection: authenticated TCP RST received"),
                0,
                "{text}"
            );
            assert!(
                observed(
                    text,
                    "this TCP connection: authenticated TCP SYN-ACK received"
                ) > 0,
                "{text}"
            );
        }
        Scenario::RelayPending => {
            assert_eq!(result["failure_reason"], "timed_out");
            assert!(text.contains("Selected relay region: 2;"), "{text}");
            assert!(
                text.contains("Selected relay relay tls: pending;"),
                "{text}"
            );
            assert!(
                text.contains("relay frames flushed locally: not observed"),
                "{text}"
            );
        }
        Scenario::RelayFailure => {
            assert!(text.contains("Selected relay region: 2;"), "{text}");
            assert!(
                text.contains("Selected relay relay attempt: failed;"),
                "{text}"
            );
            assert!(
                text.contains("Next step: Inspect the selected DERP"),
                "{text}"
            );
        }
        Scenario::RelayWritePending => {
            assert_eq!(result["failure_reason"], "timed_out");
            // Timeout retires this operation's binding. The native driver can
            // abandon the partial write before capture, so its final stage need
            // not remain pending. Queued versus flushed is stable in either case.
            assert!(text.contains("Selected relay relay write: "), "{text}");
            assert!(
                observed(text, "shared peer: relay frames queued") > 0,
                "{text}"
            );
            assert_eq!(
                observed(text, "shared peer: relay frames flushed locally"),
                0,
                "{text}"
            );
            assert_eq!(
                observed(
                    text,
                    "this TCP connection: authenticated TCP packets received"
                ),
                0,
                "{text}"
            );
        }
        Scenario::MapFailure => {
            // Native retirement cancels its still-opening binding.
            assert_eq!(result["failure_reason"], "cancelled", "{text}");
            assert!(
                text.contains("Private TCP: pending at observation;"),
                "{text}"
            );
            assert!(text.contains("terminal root: map stream;"), "{text}");
            assert!(
                text.contains("Next step: Inspect the native control/map stream"),
                "{text}"
            );
            assert!(!text.contains("private-map-canary"));
        }
    }
    let attempt = diagnostic_attempt(result);
    let history = h
        .raw(
            json!({"version":1,"method":"ssh.diagnose","params":{"attemptId":attempt}}).to_string(),
        )
        .await;
    assert_eq!(history.last().unwrap()["data"]["status"], "found");
    let retained = diagnostic_text(&history.last().unwrap()["data"]);
    if matches!(scenario, Scenario::MapFailure) {
        // Node cleanup can finish after the operation; its captured path cannot change.
        let captured = |text: &str| {
            text.lines()
                .filter(|line| !line.starts_with("- Native observations:"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(captured(retained), captured(text));
    } else {
        assert_eq!(retained, text);
    }
    assert!(text.len() <= 8192 && !text.contains("synthetic-secret"));
    assert!(!text.contains(&peer_key.to_string()));
    // Repeated operations retain the existing resolved host-authority cache.
    resolve.assert_calls_async(1).await;
    inventory
        .assert_calls_async(if other_resolve.is_some() { 2 } else { 1 })
        .await;
    if let Some(resolve) = other_resolve {
        resolve.assert_calls_async(1).await;
    }
    h.shutdown().await;
    bounded(home_gate.destroyed()).await;
    if let Some(other) = other
        && !matches!(scenario, Scenario::RelayFailure)
    {
        other.task.abort();
        let _ = other.task.await;
    }
    control.assert_control_closed();
    dial.assert_closed(2);
    api.finish().await;
    control.finish().await;
}

fn observed(text: &str, name: &str) -> u32 {
    let prefix = format!("- {name}: ");
    let value = text
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap();
    if value == "not observed." {
        0
    } else {
        value.split(';').next().unwrap().parse().unwrap()
    }
}
