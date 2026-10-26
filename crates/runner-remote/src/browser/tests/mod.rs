mod driver;
mod fixture;
use super::*;
use fixture::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn real_guest_stream_filters_targets_selectors_and_global_methods_and_chunks_capture() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    let targets = command(&mut socket, 1, "Target.getTargets", json!({}), None).await;
    assert_eq!(
        targets["result"]["targetInfos"].as_array().unwrap().len(),
        1
    );
    assert_eq!(targets["result"]["targetInfos"][0]["targetId"], OWNED);
    assert!(
        command(
            &mut socket,
            2,
            "Target.attachToTarget",
            json!({"targetId":FOREIGN,"flatten":true}),
            None
        )
        .await
        .get("error")
        .is_some()
    );
    assert_eq!(
        command(
            &mut socket,
            3,
            "Target.attachToTarget",
            json!({"targetId":OWNED,"flatten":true}),
            None
        )
        .await["result"]["sessionId"],
        "session-owned"
    );
    for (index, method) in [
        "Browser.close",
        "Browser.grantPermissions",
        "Browser.setDownloadBehavior",
        "Target.createTarget",
        "Target.createBrowserContext",
        "Target.sendMessageToTarget",
        "Storage.getCookies",
        "Network.getAllCookies",
        "Unknown.operation",
    ]
    .iter()
    .enumerate()
    {
        assert!(
            command(&mut socket, 10 + index as u64, method, json!({}), None)
                .await
                .get("error")
                .is_some()
        );
    }
    assert!(
        command(
            &mut socket,
            30,
            "Target.setAutoAttach",
            json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
            None
        )
        .await
        .get("error")
        .is_some()
    );
    assert!(
        command(
            &mut socket,
            31,
            "Page.navigate",
            json!({"url":"https://example.test","frameId":"forged-frame"}),
            Some("session-owned")
        )
        .await
        .get("error")
        .is_some()
    );
    assert!(
        command(
            &mut socket,
            32,
            "Runtime.callFunctionOn",
            json!({"objectId":"forged-object","functionDeclaration":"function(){}"}),
            Some("session-owned")
        )
        .await
        .get("error")
        .is_some()
    );
    command(
        &mut socket,
        33,
        "Runtime.evaluate",
        json!({"expression":"by-value","returnByValue":true}),
        Some("session-owned"),
    )
    .await;
    assert!(
        command(
            &mut socket,
            34,
            "Runtime.callFunctionOn",
            json!({"objectId":"forged-object","functionDeclaration":"function(){}"}),
            Some("session-owned")
        )
        .await
        .get("error")
        .is_some()
    );
    command(
        &mut socket,
        35,
        "Runtime.evaluate",
        json!({"expression":"object"}),
        Some("session-owned"),
    )
    .await;
    assert!(
        command(
            &mut socket,
            36,
            "Runtime.callFunctionOn",
            json!({"objectId":"object-owned","functionDeclaration":"function(){}"}),
            Some("session-owned")
        )
        .await
        .get("result")
        .is_some()
    );
    assert!(
        command(
            &mut socket,
            37,
            "Page.navigate",
            json!({"url":"https://example.test"}),
            Some("forged-session")
        )
        .await
        .get("error")
        .is_some()
    );
    let capture = command(
        &mut socket,
        38,
        "Page.captureScreenshot",
        json!({"format":"png"}),
        Some("session-owned"),
    )
    .await;
    assert_eq!(capture["result"]["data"].as_str().unwrap().len(), 100_000);
    for (index, params) in [
        json!({"type":"keyDown","modifiers":2,"key":"a","code":"KeyN","windowsVirtualKeyCode":78}),
        json!({"type":"keyDown","modifiers":10,"key":"c","code":"KeyC","windowsVirtualKeyCode":67}),
        json!({"type":"keyDown","modifiers":10,"key":"Delete","code":"Delete","windowsVirtualKeyCode":46}),
        json!({"type":"keyDown","key":"c","windowsVirtualKeyCode":117}),
        json!({"type":"keyDown","modifiers":1,"key":"f"}),
        json!({"type":"keyDown","modifiers":2,"key":"a","nativeVirtualKeyCode":78}),
        json!({"type":"keyDown","modifiers":2,"key":"a","code":"KeyA","windowsVirtualKeyCode":65,"nativeVirtualKeyCode":78}),
    ].into_iter().enumerate() {
        assert!(command(&mut socket, 50 + index as u64, "Input.dispatchKeyEvent", params, Some("session-owned")).await.get("error").is_some());
    }
    assert!(
        !peer
            .state
            .methods
            .lock()
            .unwrap()
            .iter()
            .any(|method| method == "Input.dispatchKeyEvent")
    );
    // A changed native loader retires document selectors even when its
    // lifecycle event has not arrived at the Guest yet.
    command(
        &mut socket,
        39,
        "Page.navigate",
        json!({"url":"https://owned.example/next"}),
        Some("session-owned"),
    )
    .await;
    let calls_before = peer
        .state
        .methods
        .lock()
        .unwrap()
        .iter()
        .filter(|m| m.as_str() == "Runtime.callFunctionOn")
        .count();
    assert!(
        command(
            &mut socket,
            40,
            "Runtime.callFunctionOn",
            json!({"objectId":"object-owned", "functionDeclaration":"function(){}"}),
            Some("session-owned")
        )
        .await
        .get("error")
        .is_some()
    );
    assert_eq!(
        peer.state
            .methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.as_str() == "Runtime.callFunctionOn")
            .count(),
        calls_before
    );
    let methods = peer.state.methods.lock().unwrap().clone();
    assert!(!methods.iter().any(|m| m == "Browser.close"
        || m == "Target.setAutoAttach"
        || m == "Target.createTarget"));
    socket.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    assert_eq!(peer.state.connections.load(Ordering::SeqCst), 0);
    peer.shutdown().await;
}

#[tokio::test]
async fn native_metadata_races_and_invalid_window_replies_cannot_release_results() {
    for method in [
        "Target.getTargetInfo",
        "Browser.getWindowForTarget",
        "Target.getTargets",
    ] {
        let peer = Peer::new().await;
        let harness = Harness::new(&peer).await;
        let mut socket = harness.connect().await;
        command(&mut socket, 1, "Target.getTargets", json!({}), None).await;
        match method {
            "Target.getTargetInfo" => peer.state.move_on_metadata.store(true, Ordering::SeqCst),
            "Browser.getWindowForTarget" => peer
                .state
                .move_after_window_check
                .store(true, Ordering::SeqCst),
            _ => peer.state.malformed_window.store(true, Ordering::SeqCst),
        }
        let params = if method == "Target.getTargets" {
            json!({})
        } else {
            json!({"targetId":OWNED})
        };
        socket
            .send(Message::Text(
                json!({"id":2,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    break;
                }
                if let Message::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    assert!(
                        !(value["id"] == 2 && value.get("result").is_some()),
                        "released stale or malformed metadata for {method}"
                    );
                }
            }
        })
        .await
        .unwrap();
        harness.shutdown().await;
        peer.wait_closed().await;
        peer.shutdown().await;
    }
}

#[tokio::test]
async fn cancelled_setup_retains_host_capacity_until_its_resolver_finishes() {
    use tokio::io::AsyncReadExt;
    let peer = Peer::new().await;
    let network = Arc::new(GatedResolver::new(peer.address));
    let harness = Harness::with_network(
        peer.address,
        Arc::clone(&peer.tls),
        network.clone(),
        Arc::new(Semaphore::new(1)),
    )
    .await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut first = harness.request(json!({}), cancel.clone()).await;
    tokio::time::timeout(Duration::from_secs(3), network.entered.notified())
        .await
        .unwrap();
    cancel.cancel();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), first.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert!(bytes.is_empty());
    let denied = tokio::time::timeout(Duration::from_secs(3), harness.forged_request(json!({})))
        .await
        .unwrap();
    assert_eq!(
        denied,
        vec![json!({"type":"error","code":"resource_exhausted","delivery":"not_dispatched"})]
    );
    network.release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), network.finished.notified())
        .await
        .unwrap();
    let mut next = harness.connect().await;
    assert!(
        command(&mut next, 1, "Browser.getVersion", json!({}), None)
            .await
            .get("result")
            .is_some()
    );
    next.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn revocation_during_native_event_validation_withholds_the_event() {
    let peer = Peer::new().await;
    let mut harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    command(&mut socket, 1, "Target.getTargets", json!({}), None).await;
    command(
        &mut socket,
        2,
        "Target.attachToTarget",
        json!({"targetId":OWNED,"flatten":true}),
        None,
    )
    .await;
    peer.state.pause_auto_attach.store(true, Ordering::SeqCst);
    command(
        &mut socket,
        3,
        "Target.setAutoAttach",
        json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
        Some("session-owned"),
    )
    .await;
    // Only the owned child-attachment event asks for a frame tree after
    // setAutoAttach has completed. Periodic checks cannot consume this gate.
    tokio::time::timeout(
        Duration::from_secs(3),
        peer.state.child_tree_entered.notified(),
    )
    .await
    .unwrap();
    harness.set_api(false).await;
    peer.state.child_tree_release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                assert_ne!(value["method"], "Target.attachedToTarget");
            }
        }
    })
    .await
    .unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn a_new_stream_observes_the_effect_without_replaying_a_lost_acknowledgement() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    command(&mut socket, 1, "Target.getTargets", json!({}), None).await;
    command(
        &mut socket,
        2,
        "Target.attachToTarget",
        json!({"targetId":OWNED,"flatten":true}),
        None,
    )
    .await;
    peer.state.drop_input_ack.store(true, Ordering::SeqCst);
    socket.send(Message::Text(json!({"id":3,"method":"Input.insertText","sessionId":"session-owned","params":{"text":"A"}}).to_string().into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                assert!(!(value["id"] == 3 && value.get("result").is_some()));
            }
        }
    })
    .await
    .unwrap();
    peer.wait_closed().await;
    let mut next = harness.connect().await;
    command(&mut next, 1, "Target.getTargets", json!({}), None).await;
    command(
        &mut next,
        2,
        "Target.attachToTarget",
        json!({"targetId":OWNED,"flatten":true}),
        None,
    )
    .await;
    assert_eq!(
        command(
            &mut next,
            3,
            "Runtime.evaluate",
            json!({"expression":"inserted","returnByValue":true}),
            Some("session-owned")
        )
        .await["result"]["result"]["value"],
        "A"
    );
    next.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn browser_stream_outlives_sixty_seconds_then_run_cancellation_joins_it() {
    let peer = Peer::new().await;
    let mut harness = Harness::new(&peer).await;
    harness.expires = authority::now() + 50_000;
    harness.set_api(true).await;
    let mut socket = harness.connect().await;
    assert!(
        command(&mut socket, 1, "Browser.getVersion", json!({}), None)
            .await
            .get("result")
            .is_some()
    );
    harness.expires += 600_000;
    harness.set_api(true).await;
    command(&mut socket, 9, "Browser.getVersion", json!({}), None).await;
    // This is a real duration-bound regression, not a readiness delay. The
    // external HTTP peer and UTC leases do not share Tokio's virtual clock;
    // jumping it would expire unrelated in-flight HTTP operations spuriously.
    tokio::time::sleep_until(Instant::now() + Duration::from_secs(61)).await;
    assert!(
        command(&mut socket, 2, "Browser.getVersion", json!({}), None)
            .await
            .get("result")
            .is_some()
    );
    harness.cancelled.cancel();
    tokio::time::timeout(Duration::from_secs(3), async {
        while socket
            .next()
            .await
            .is_some_and(|r| r.is_ok_and(|m| !m.is_close()))
        {}
    })
    .await
    .unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    assert_eq!(peer.state.connections.load(Ordering::SeqCst), 0);
    peer.shutdown().await;
}

#[tokio::test]
async fn api_revocation_and_native_window_move_close_without_replaying_commands() {
    for moved in [false, true] {
        let peer = Peer::new().await;
        let mut harness = Harness::new(&peer).await;
        let mut socket = harness.connect().await;
        command(&mut socket, 1, "Target.getTargets", json!({}), None).await;
        command(
            &mut socket,
            2,
            "Target.attachToTarget",
            json!({"targetId":OWNED,"flatten":true}),
            None,
        )
        .await;
        if moved {
            peer.state.moved.store(true, Ordering::SeqCst);
        } else {
            harness.set_api(false).await;
        }
        let before = peer
            .state
            .methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.as_str() == "Input.insertText")
            .count();
        socket.send(Message::Text(json!({"id":3,"method":"Input.insertText","sessionId":"session-owned","params":{"text":"must not dispatch"}}).to_string().into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while socket
                .next()
                .await
                .is_some_and(|r| r.is_ok_and(|m| !m.is_close()))
            {}
        })
        .await
        .unwrap();
        let after = peer
            .state
            .methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.as_str() == "Input.insertText")
            .count();
        assert_eq!(before, after);
        harness.shutdown().await;
        peer.shutdown().await;
    }
}

#[tokio::test]
async fn guest_claims_cannot_select_an_endpoint_and_guest_cancellation_closes_io() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    for params in [
        json!({"runId":uuid::Uuid::new_v4()}),
        json!({"cdpUrl":"wss://foreign.example/"}),
        json!({"primaryWindowId":102}),
    ] {
        assert_eq!(
            harness.forged_request(params).await,
            vec![json!({"type":"error","code":"invalid_request","delivery":"not_dispatched"})]
        );
    }
    assert_eq!(peer.state.connections.load(Ordering::SeqCst), 0);
    let mut socket = harness.connect().await;
    command(&mut socket, 1, "Browser.getVersion", json!({}), None).await;
    harness.sandbox_cancelled.cancel();
    tokio::time::timeout(Duration::from_secs(3), async {
        while socket
            .next()
            .await
            .is_some_and(|r| r.is_ok_and(|m| !m.is_close()))
        {}
    })
    .await
    .unwrap();
    assert!(!harness.cancelled.is_cancelled());
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn legitimate_existing_renewal_extends_the_stream_but_expired_state_closes_it() {
    let peer = Peer::new().await;
    let mut harness = Harness::new(&peer).await;
    harness.expires = authority::now() + 50_000;
    harness.set_api(true).await;
    let mut socket = harness.connect().await;
    command(&mut socket, 1, "Browser.getVersion", json!({}), None).await;
    harness.expires += 600_000;
    harness.set_api(true).await;
    command(&mut socket, 2, "Browser.getVersion", json!({}), None).await;
    assert!(
        command(&mut socket, 3, "Browser.getVersion", json!({}), None)
            .await
            .get("result")
            .is_some()
    );
    harness.expires = authority::now() - 1;
    harness.set_api(true).await;
    socket
        .send(Message::Text(
            json!({"id":4,"method":"Browser.getVersion","params":{}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while socket
            .next()
            .await
            .is_some_and(|r| r.is_ok_and(|m| !m.is_close()))
        {}
    })
    .await
    .unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn page_auto_attach_only_exposes_owned_iframes_and_context_events() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    command(&mut socket, 1, "Target.getTargets", json!({}), None).await;
    command(
        &mut socket,
        2,
        "Target.attachToTarget",
        json!({"targetId":OWNED,"flatten":true}),
        None,
    )
    .await;
    command(
        &mut socket,
        3,
        "Runtime.enable",
        json!({}),
        Some("session-owned"),
    )
    .await;
    let context = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let value: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            if value["method"] == "Runtime.executionContextCreated" {
                return value;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(context["params"]["context"]["id"], 100);
    assert!(
        command(
            &mut socket,
            4,
            "Runtime.evaluate",
            json!({"expression":"1","contextId":200}),
            Some("session-owned")
        )
        .await
        .get("error")
        .is_some()
    );
    command(
        &mut socket,
        5,
        "Target.setAutoAttach",
        json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
        Some("session-owned"),
    )
    .await;
    let child = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(!text.contains("context-foreign") && !text.contains("session-worker"));
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["method"] == "Target.attachedToTarget" {
                return value;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(child["params"]["sessionId"], "session-child");
    assert!(
        command(
            &mut socket,
            6,
            "Runtime.runIfWaitingForDebugger",
            json!({}),
            Some("session-child")
        )
        .await
        .get("result")
        .is_some()
    );
    assert!(
        command(
            &mut socket,
            7,
            "Runtime.evaluate",
            json!({"expression":"1"}),
            Some("session-worker")
        )
        .await
        .get("error")
        .is_some()
    );
    assert!(
        !peer
            .state
            .methods
            .lock()
            .unwrap()
            .iter()
            .any(|method| method == "Runtime.evaluate")
    );
    socket.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn verified_https_discovery_handles_chunking_and_rejects_redirects_or_foreign_endpoints() {
    for (status, foreign) in [(200, false), (302, false), (200, true)] {
        let peer = Peer::new().await;
        let mut harness = Harness::new(&peer).await;
        let upstream = if foreign {
            "wss://foreign.example/".to_owned()
        } else {
            harness.provider_url.clone()
        };
        let discovery =
            HttpsPeer::new(&peer, status, json!({"webSocketDebuggerUrl":upstream})).await;
        harness.provider_url = format!(
            "https://{HOST}:{}/?token=private-provider-canary",
            discovery.address.port()
        );
        harness.set_api(true).await;
        let mut socket = harness.connect().await;
        if status == 200 && !foreign {
            assert!(
                command(&mut socket, 1, "Browser.getVersion", json!({}), None)
                    .await
                    .get("result")
                    .is_some()
            );
            socket.close(None).await.unwrap();
        } else {
            tokio::time::timeout(Duration::from_secs(3), async {
                while socket
                    .next()
                    .await
                    .is_some_and(|r| r.is_ok_and(|m| !m.is_close()))
                {}
            })
            .await
            .unwrap();
            assert_eq!(peer.state.connections.load(Ordering::SeqCst), 0);
        }
        harness.shutdown().await;
        discovery.shutdown().await;
        peer.wait_closed().await;
        peer.shutdown().await;
    }
}
