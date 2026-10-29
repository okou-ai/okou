use super::*;
use crate::provider::api_ably_supervisor::make_ably_config;

use std::sync::Mutex as StdMutex;

use ably_subscriber::protocol::{
    AblyMessage, ConnectionDetails, ProtocolMessage, action, decode_msg, encode_msg,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{
    Message as WsMessage,
    handshake::server::{Callback, ErrorResponse, Request, Response},
};

const CHANNEL: &str = "runner-group:default";
const COMPETITOR_ID: &str = "60000000-0000-4000-8000-000000000001";

struct VerifyRunnerHeartbeat;

impl Callback for VerifyRunnerHeartbeat {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        let url = reqwest::Url::parse(&format!("ws://localhost{}", request.uri())).unwrap();
        assert!(
            url.query_pairs()
                .any(|(key, value)| key == "heartbeatInterval" && value == "5000")
        );
        Ok(response)
    }
}

#[derive(Default)]
struct Queue {
    pending: bool,
    owner: Option<Uuid>,
    preference_expires_at: Option<tokio::time::Instant>,
    preference_expires_at_utc: String,
    polls: usize,
}

impl Queue {
    fn response(&mut self, request: &str) -> Vec<u8> {
        let path = request.split_whitespace().nth(1).unwrap();
        if path == routes::runners::heartbeat::HEARTBEAT.path {
            return http_response("204 No Content", b"");
        }
        if path == routes::runners::poll::POLL.path {
            self.polls += 1;
            let job = if self.pending && self.owner.is_none() {
                serde_json::json!({
                    "runId": RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID,
                    "experimentalProfile": crate::profile::DEFAULT_PROFILE,
                    "reuseKey": "thread:heartbeat-test",
                    "runnerPreference": {
                        "kind": "preference",
                        "runnerIdentity": {
                            "runnerId": TEST_RUNNER_ID,
                            "heartbeatGeneration": TEST_HEARTBEAT_GENERATION,
                        },
                        "tier": "homeCache",
                        "expiresAt": self.preference_expires_at_utc,
                    },
                })
            } else {
                serde_json::Value::Null
            };
            return json_response("200 OK", &serde_json::json!({ "job": job }).to_string());
        }
        assert_eq!(
            path,
            format!(
                "/api/runners/jobs/{RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID}/claim?workflowSkills=2"
            )
        );
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        let runner: Uuid = body["runnerIdentity"]["runnerId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let preferred = runner == TEST_RUNNER_ID.parse::<Uuid>().unwrap();
        let expired = self
            .preference_expires_at
            .is_some_and(|at| at <= tokio::time::Instant::now());
        if self.pending && self.owner.is_none() && (preferred || expired) {
            self.owner = Some(runner);
            json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE)
        } else {
            http_response("404 Not Found", b"unavailable")
        }
    }
}

#[tokio::test]
async fn heartbeat_limits_reconciliation_to_admittable_held_inventory() {
    let server = MockServer::start_async().await;
    let heartbeats = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::runners::heartbeat::HEARTBEAT.path);
            then.status(204);
        })
        .await;
    let mut sandbox = heartbeat_state_for_test();
    sandbox.held_home_states.clear();
    let mut home = heartbeat_state_for_test();
    home.held_sandbox_states.clear();
    let mut empty = heartbeat_state_for_test();
    empty.held_sandbox_states.clear();
    empty.held_home_states.clear();
    let mut full = heartbeat_state_for_test();
    full.admittable_profiles.clear();
    let mut other_profile = heartbeat_state_for_test();
    other_profile.admittable_profiles = vec!["other/profile".into()];
    let mut stopping = heartbeat_state_for_test();
    stopping.mode = "stopping".into();
    let mut draining = heartbeat_state_for_test();
    draining.mode = "draining".into();

    for (name, state, eligible) in [
        ("sandbox", sandbox, true),
        ("home", home, true),
        ("empty", empty, false),
        ("full", full, false),
        ("other profile", other_profile, false),
        ("stopping", stopping, false),
        ("draining", draining, false),
    ] {
        let wakeups = Arc::new(PollWakeups::new(true));
        let cancel = CancellationToken::new();
        let provider = api_provider_for_test(server.base_url(), cancel.clone(), wakeups.clone());
        let startup = wakeups
            .wait_for_poll_due(&cancel, POLL_SLOW, POLL_FAST)
            .await
            .unwrap();
        wakeups.record_poll_result(startup, PollOutcome::Empty, POLL_WAKEUP_RETRY);
        provider.heartbeat(&state).await.unwrap();

        // Pause only after HTTP has finished; the remaining boundary is the
        // production scheduler, with no kernel IO awaiting clock progress.
        tokio::time::pause();
        let wait = wakeups.wait_for_poll_due(&cancel, POLL_SLOW, POLL_FAST);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending(), "{name}");
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(futures_util::poll!(&mut wait).is_pending(), "{name}");
        tokio::time::advance(POLL_REUSE).await;
        if eligible {
            assert!(
                matches!(
                    futures_util::poll!(&mut wait),
                    std::task::Poll::Ready(Some(due)) if due.reason() == PollReason::Fast
                ),
                "{name}"
            );
        } else {
            assert!(futures_util::poll!(&mut wait).is_pending(), "{name}");
            tokio::time::advance(POLL_SLOW).await;
            assert_eq!(wait.await.unwrap().reason(), PollReason::Slow, "{name}");
        }
        tokio::time::resume();
        provider.shutdown().await;
    }
    heartbeats.assert_calls_async(7).await;
}

// Keep all peers in this runtime and use real time: a paused Tokio clock can
// expire a claim while the kernel is still moving an ordinary HTTP response.
#[tokio::test]
async fn silent_socket_reconciliation_respects_budget_and_expired_preference() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_address = listener.local_addr().unwrap();
    let queue = Arc::new(StdMutex::new(Queue::default()));
    let queue_peer = Arc::clone(&queue);
    let stop_http = CancellationToken::new();
    let peer_stop = stop_http.clone();
    let (initial_tx, initial_rx) = oneshot::channel();
    let (reconciled_tx, reconciled_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut initial_tx = Some(initial_tx);
        let reconciliation = Arc::new(StdMutex::new(Some(reconciled_tx)));
        let mut requests = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                () = peer_stop.cancelled() => break,
                Some(result) = requests.join_next(), if !requests.is_empty() => result.unwrap(),
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted.unwrap();
                    let queue = Arc::clone(&queue_peer);
                    let reconciliation = Arc::clone(&reconciliation);
                    // Only the first poll signals queue admission, after its
                    // empty response. Creating the job before it would let
                    // startup's immediate poll mask the broken safety cadence.
                    let initial = initial_tx.take();
                    requests.spawn(async move {
                        let request = match read_http_request(&mut stream).await {
                            Ok(request) => request,
                            // A late Ably candidate can cancel discover's HTTP
                            // request before it sends complete headers.
                            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return,
                            Err(error) => panic!("reading discovery API request: {error}"),
                        };
                        let request_received_at = tokio::time::Instant::now();
                        let (response, reconciled) = {
                            let mut queue = queue.lock().unwrap();
                            let response = queue.response(&request);
                            let reconciled = request.split_whitespace().nth(1)
                                == Some(routes::runners::poll::POLL.path)
                                && queue.polls == 2;
                            (response, reconciled)
                        };
                        if let Err(error) = stream.write_all(&response).await {
                            // A cancelled poll may disconnect after its headers
                            // were read, too. The startup gate must still finish.
                            assert!(initial.is_none());
                            assert!(matches!(error.kind(),
                                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                            ), "writing discovery API response: {error}");
                            return;
                        }
                        if let Some(initial) = initial {
                            initial.send(()).unwrap();
                        }
                        if reconciled {
                            reconciliation.lock().unwrap().take().unwrap()
                                .send(request_received_at).unwrap();
                        }
                    });
                }
            }
        }
        while let Some(result) = requests.join_next().await {
            result.unwrap();
        }
    });

    // Token exchange has a separate bounded loopback peer, leaving the API's
    // first accepted request available as the initial-poll synchronization gate.
    let tokens = MockServer::start_async().await;
    tokens
        .mock_async(|when, then| {
            when.method(POST).path("/keys/fixture.key/requestToken");
            then.status(201).json_body(serde_json::json!({
                "token": "synthetic-token",
                "expires": chrono::Utc::now().timestamp_millis() + 3_600_000,
            }));
        })
        .await;
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let socket_address = socket.local_addr().unwrap();
    let (deliver, delivery) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let (tcp, _) = socket.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_hdr_async(tcp, VerifyRunnerHeartbeat)
            .await
            .unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("silent-connection".into()),
            connection_key: Some("silent-connection!fixture".into()),
            connection_details: Some(ConnectionDetails {
                max_idle_interval: Some(5_000),
                connection_state_ttl: Some(120_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        ws.send(WsMessage::Binary(encode_msg(&connected).unwrap().into()))
            .await
            .unwrap();
        let attach = ws.next().await.unwrap().unwrap();
        assert_eq!(
            decode_msg(&attach.into_data()).unwrap().action,
            action::ATTACH
        );
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some(CHANNEL.into()),
            channel_serial: Some("fixture-0".into()),
            ..Default::default()
        };
        ws.send(WsMessage::Binary(encode_msg(&attached).unwrap().into()))
            .await
            .unwrap();

        // Keep TCP/WebSocket open but send neither business messages nor Ping
        // frames. A close frame would test a different, immediately visible fault.
        delivery.await.unwrap();
        let late = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some(CHANNEL.into()),
            messages: Some(vec![AblyMessage {
                name: Some("job".into()),
                data: Some(serde_json::json!({
                    "runId": run_id,
                    "profile": crate::profile::DEFAULT_PROFILE,
                })),
                ..Default::default()
            }]),
            ..Default::default()
        };
        ws.send(WsMessage::Binary(encode_msg(&late).unwrap().into()))
            .await
            .unwrap();
        while let Some(frame) = ws.next().await {
            if matches!(frame.unwrap(), WsMessage::Close(_)) {
                ws.flush().await.unwrap();
                break;
            }
        }
    });
    let wakeups = Arc::new(PollWakeups::new(true));
    let provider = api_provider_for_test(
        format!("http://{api_address}"),
        CancellationToken::new(),
        Arc::clone(&wakeups),
    );
    let mut config = make_ably_config(&provider.api, &provider.group);
    config.get_token = Box::new(|| {
        Box::pin(async {
            Ok(ably_subscriber::TokenRequest {
                key_name: "fixture.key".into(),
                timestamp: chrono::Utc::now().timestamp_millis(),
                nonce: "fixture-nonce".into(),
                mac: "fixture-mac".into(),
                capability: "{\"*\":[\"subscribe\"]}".into(),
                ttl: None,
                client_id: None,
            })
        })
    });
    config.host = Some(socket_address.to_string());
    config.rest_host = Some(tokens.address().to_string());
    let subscription = ably_subscriber::subscribe(config).await.unwrap();
    let supervisor = AblySupervisor::connected_for_test(
        AblySupervisorConfig {
            ably_side_message_handler: None,
            api: provider.api.clone(),
            group: provider.group.clone(),
            profiles: provider.supported_profiles.clone(),
            poll_wakeups: wakeups,
            direct_candidates: Arc::clone(&provider.direct_candidates),
            cancel_tokens: provider.cancel_tokens.clone(),
            connector_runtime_sync: provider.connector_runtime_sync.clone(),
            active_input_notifications: provider.active_input_notifications.clone(),
            provider_cancel: provider.cancel.clone(),
        },
        subscription,
    );
    *provider.ably_supervisor.lock().await = Some(supervisor);
    let discovering = Arc::clone(&provider);
    let claim = tokio::spawn(async move {
        let candidate = discovering.discover().await.unwrap();
        assert_eq!(candidate.run_id(), run_id);
        discovering.claim(candidate).await
    });
    tokio::time::timeout(Duration::from_secs(5), initial_rx)
        .await
        .unwrap()
        .unwrap();
    let eligible_since = tokio::time::Instant::now();
    provider
        .heartbeat(&heartbeat_state_for_test())
        .await
        .unwrap();

    let expires = tokio::time::Instant::now() + Duration::from_secs(2);
    {
        let mut queue = queue.lock().unwrap();
        queue.pending = true;
        queue.preference_expires_at = Some(expires);
        queue.preference_expires_at_utc =
            (chrono::Utc::now() + chrono::Duration::seconds(2)).to_rfc3339();
    }
    let mut competitor = api_provider_for_test(
        format!("http://{api_address}"),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    Arc::get_mut(&mut competitor).unwrap().runner_identity =
        RunnerProcessIdentity::new(COMPETITOR_ID.parse().unwrap(), TEST_HEARTBEAT_GENERATION)
            .unwrap();
    tokio::time::sleep_until(expires).await;
    assert!(
        competitor
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.into()
            ))
            .await
            .is_some()
    );
    // Keep the actual two-second expiry: ten-second polling cannot promise
    // preferred ownership, and the competitor is allowed to win after expiry.
    let reconciled_at = tokio::time::timeout_at(
        eligible_since + POLL_REUSE + Duration::from_secs(4),
        reconciled_rx,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        reconciled_at >= eligible_since + POLL_REUSE,
        "routine reconciliation must not start before the ten-second budget"
    );
    assert!(provider.poll_wakeups.snapshot().ably_connected);
    {
        let queue = queue.lock().unwrap();
        assert_eq!(queue.owner, Some(COMPETITOR_ID.parse().unwrap()));
        assert_eq!(
            queue.polls, 2,
            "startup and one load-limited reconciliation"
        );
    }

    // The same live socket later delivers its stale job notification through
    // the production Ably supervisor. Claim authority still rejects it.
    deliver.send(()).unwrap();
    let claimed =
        join_raw_http_task(claim, "late preferred claim after competitor ownership").await;
    assert!(claimed.is_none());
    provider.shutdown().await;
    competitor.shutdown().await;
    join_raw_http_task(peer, "silent WebSocket peer shutdown").await;
    stop_http.cancel();
    join_raw_http_task(server, "silent discovery API peer shutdown").await;
}
