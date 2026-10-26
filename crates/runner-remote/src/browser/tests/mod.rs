mod driver;
mod fixture;
use super::*;
use fixture::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn every_capability_forwards_verbatim_without_added_native_queries() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    let cases: Vec<(&str, Value, Option<&str>)> = vec![
        ("Browser.close", json!({}), None),
        (
            "Browser.grantPermissions",
            json!({"origin":"https://foreign.example","permissions":["geolocation"]}),
            None,
        ),
        (
            "Browser.setDownloadBehavior",
            json!({"behavior":"allow","downloadPath":"/tmp/provider-private"}),
            None,
        ),
        (
            "Target.createTarget",
            json!({"url":"about:blank","newWindow":true}),
            None,
        ),
        (
            "Target.createBrowserContext",
            json!({"disposeOnDetach":false}),
            None,
        ),
        (
            "Target.sendMessageToTarget",
            json!({"sessionId":"session-any","message":"{\"id\":1}"}),
            None,
        ),
        (
            "Storage.getCookies",
            json!({"browserContextId":"any"}),
            None,
        ),
        ("Network.getAllCookies", json!({}), None),
        (
            "DOMStorage.getDOMStorageItems",
            json!({"storageId":{"securityOrigin":"https://foreign.example","isLocalStorage":true}}),
            None,
        ),
        (
            "IndexedDB.requestDatabaseNames",
            json!({"securityOrigin":"https://foreign.example"}),
            None,
        ),
        (
            "CacheStorage.requestCacheNames",
            json!({"securityOrigin":"https://foreign.example"}),
            None,
        ),
        (
            "Fetch.enable",
            json!({"patterns":[{"urlPattern":"*"}]}),
            None,
        ),
        ("Debugger.enable", json!({}), None),
        (
            "Tracing.start",
            json!({"categories":"devtools.timeline"}),
            None,
        ),
        ("Page.crash", json!({}), None),
        ("Runtime.terminateExecution", json!({}), None),
        (
            "Network.setCookie",
            json!({"name":"a","value":"b","url":"https://example.test"}),
            None,
        ),
        (
            "Page.navigate",
            json!({"url":"file:///provider-private"}),
            None,
        ),
        ("Page.navigate", json!({"url":"chrome://settings"}), None),
        ("Unknown.futureMethod", json!({"any":["shape",1]}), None),
        (
            "Emulation.setDeviceMetricsOverride",
            json!({"width":900,"height":700,"mobile":false,"deviceScaleFactor":1}),
            Some("session-owned"),
        ),
        (
            "Input.dispatchKeyEvent",
            json!({"type":"keyDown","modifiers":2,"key":"Enter","code":"Enter","windowsVirtualKeyCode":13}),
            Some("session-owned"),
        ),
        (
            "Target.setAutoAttach",
            json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
            Some("session-owned"),
        ),
        (
            "Runtime.callFunctionOn",
            json!({"objectId":"forged-object","functionDeclaration":"function(){}"}),
            Some("session-owned"),
        ),
        (
            "Fixture.echo",
            json!({"futureParameter":{"enabled":true}}),
            Some("session-owned"),
        ),
    ];
    for (index, (method, params, session)) in cases.iter().enumerate() {
        let id = index as u64 + 1;
        let reply = command(&mut socket, id, method, params.clone(), *session).await;
        assert!(
            reply.get("result").is_some(),
            "{method} must forward instead of being denied: {reply}"
        );
    }
    // Native replies are returned unchanged, not reinterpreted per method.
    assert_eq!(
        command(
            &mut socket,
            100,
            "Fixture.echo",
            json!({"arbitrary":{"nested":[1,2,3]}}),
            None
        )
        .await["result"],
        json!({"arbitrary":{"nested":[1,2,3]}})
    );
    let targets = command(&mut socket, 101, "Target.getTargets", json!({}), None).await;
    let infos = targets["result"]["targetInfos"].as_array().unwrap();
    assert_eq!(infos.len(), 2, "discovery output must not be filtered");
    // Exactly one native command per Guest command: no Browser.getWindowForTarget,
    // Page.getFrameTree or any other injected control query.
    let methods = peer.state.methods.lock().unwrap().clone();
    let expected: Vec<String> = cases
        .iter()
        .map(|(method, _, _)| (*method).to_owned())
        .chain(["Fixture.echo".to_owned(), "Target.getTargets".to_owned()])
        .collect();
    assert_eq!(methods, expected);
    socket.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn native_errors_and_events_forward_without_closing_the_stream() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    let error = command(
        &mut socket,
        1,
        "Fixture.unsupported",
        json!({}),
        Some("session-owned"),
    )
    .await;
    assert_eq!(error["error"]["code"], -32601);
    assert_eq!(error["error"]["message"], "private upstream diagnostic");
    assert_eq!(error["sessionId"], "session-owned");
    // A native command error is data, not a transport fault.
    assert!(
        command(&mut socket, 2, "Browser.getVersion", json!({}), None)
            .await
            .get("result")
            .is_some()
    );
    command(
        &mut socket,
        3,
        "Fixture.events",
        json!({}),
        Some("session-owned"),
    )
    .await;
    let mut observed = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while observed.len() < 7 {
            let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
            observed.push(serde_json::from_str::<Value>(&text).unwrap());
        }
    })
    .await
    .unwrap();
    // Foreign sessions, foreign targets and global-domain events are forwarded
    // byte-faithfully; the broker no longer filters or rewrites them.
    assert_eq!(observed[1]["sessionId"], "foreign-session");
    assert_eq!(observed[1]["params"]["value"], "foreign");
    assert_eq!(observed[2]["params"]["targetId"], FOREIGN);
    assert_eq!(observed[3]["method"], "Storage.futureEvent");
    assert_eq!(observed[0]["method"], "Fixture.futureEvent");
    assert_eq!(observed[4]["method"], "Runtime.consoleAPICalled");
    assert_eq!(
        observed[4]["params"]["args"][0]["value"]["objectId"],
        "forged-object"
    );
    assert_eq!(observed[5]["method"], "CSS.styleSheetAdded");
    assert_eq!(observed[6]["method"], "Network.responseReceived");
    socket.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
}

#[tokio::test]
async fn large_messages_forward_in_both_directions() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    // This exceeds the former 4 MiB message limit and the 8 MiB normal queue
    // budget. It must progress in both directions instead of deadlocking.
    let large = "x".repeat(9 * 1024 * 1024);
    let echoed = command(
        &mut socket,
        1,
        "Fixture.echo",
        json!({"text":large}),
        Some("session-owned"),
    )
    .await;
    assert_eq!(echoed["result"]["text"], large);
    socket.close(None).await.unwrap();
    harness.shutdown().await;
    peer.wait_closed().await;
    peer.shutdown().await;
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
async fn browser_stream_outlives_initial_idle_expiry_and_sixty_seconds_until_run_cancellation() {
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
    harness.set_api(false).await;
    // This is a real duration-bound regression, not a readiness delay. The
    // external peers do not share Tokio's virtual clock. The socket survives
    // both its initial idle expiry and the ordinary RPC budget without API I/O.
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
async fn native_browser_instance_closure_ends_an_established_stream() {
    let peer = Peer::new().await;
    let harness = Harness::new(&peer).await;
    let mut socket = harness.connect().await;
    command(&mut socket, 1, "Browser.getVersion", json!({}), None).await;
    // The provider's physical instance owns expiry/stop. Its native closure,
    // rather than a copied API deadline, terminates an otherwise idle stream.
    peer.shutdown().await;
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
