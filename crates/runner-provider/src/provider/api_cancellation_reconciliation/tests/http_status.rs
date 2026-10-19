use super::*;

async fn respond_status(mut request: Request, status: &str) {
    const BODY: &str = "private-response-body";
    request
        .socket
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
                BODY.len(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    request.socket.shutdown().await.unwrap();
    // The peer closing the failed response synchronizes the real HTTP read
    // before the next explicit clock advance.
    request.disconnected().await;
}

async fn wait_for_events(
    captured: &CapturedEvents,
    message: &str,
    count: usize,
) -> Vec<CapturedEvent> {
    bounded(async {
        loop {
            let entries = events(captured, message);
            if entries.len() >= count {
                return entries;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
}

fn assert_status_context(event: &CapturedEvent, run_id: RunId, status: u16) {
    assert_eq!(event.fields["status"], status.to_string());
    assert_eq!(event.fields["failure_stage"], "status");
    assert_eq!(event.fields["failure_kind"], "http_status");
    assert_eq!(event.fields["endpoint"], "run cancellation reconciliation");
    assert_eq!(event.fields["method"], "GET");
    assert_eq!(
        event.fields["path"],
        format!("/api/runners/runs/{run_id}/cancellation")
    );
    assert!(!event.fields["host"].is_empty());
    assert!(!event.fields["client_request_id"].is_empty());
    assert_eq!(event.fields["client_session_id"], "cancellation-test");
    assert!(!event.fields["client_version"].is_empty());
    assert_eq!(event.fields["will_retry"], "true");
    let diagnostic = format!("{event:?}");
    for secret in [
        "sandbox-test-token",
        "private-response-body",
        "runnerGroup=",
        "heartbeatGeneration=",
    ] {
        assert!(!diagnostic.contains(secret), "leaked {secret}");
    }
}

#[tokio::test(start_paused = true)]
async fn temporary_http_statuses_warn_once_per_sustained_episode_and_reset_on_recovery() {
    for (status, response) in [
        (502, "502 Bad Gateway"),
        (503, "503 Service Unavailable"),
        (504, "504 Gateway Timeout"),
    ] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let mut server = Server::new().await;
        let controller = server.controller();
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let first_dispatch = Instant::now();
        let registration = bounded(observe(&controller, &registry, run_id)).await;
        let first = server.next().await;
        // Bounded I/O keeps time frozen from dispatch through peer receipt.
        assert_eq!(first.at, first_dispatch);
        bounded(respond_status(first, response)).await;

        let first_failure = wait_for_events(&captured, FAILURE, 1).await;
        assert_eq!(first_failure.len(), 1);
        assert_eq!(first_failure[0].level, Level::INFO);
        assert_eq!(first_failure[0].fields["consecutive_failures"], "1");
        assert_eq!(first_failure[0].fields["degraded"], "false");
        assert_status_context(&first_failure[0], run_id, status);
        assert!(!registration.is_cancelled());

        // Await the paused-clock timer so Tokio's millisecond deadline rounding
        // completes before bounded socket I/O keeps the runtime runnable.
        tokio::time::sleep(INTERVAL).await;
        let retry = server.next().await;
        assert!(retry.at - first_dispatch >= INTERVAL);
        bounded(respond_status(retry, response)).await;
        let degraded = wait_for_events(&captured, DEGRADED, 1).await;
        assert_eq!(degraded.len(), 1);
        assert_eq!(degraded[0].level, Level::WARN);
        assert_eq!(degraded[0].fields["consecutive_failures"], "2");
        assert!(
            degraded[0].fields["failure_elapsed_ms"]
                .parse::<u64>()
                .unwrap()
                >= 30000
        );
        assert_eq!(degraded[0].fields["degraded"], "true");
        assert_status_context(&degraded[0], run_id, status);

        tokio::time::sleep(INTERVAL).await;
        bounded(respond_status(server.next().await, response)).await;
        assert_eq!(events(&captured, DEGRADED).len(), 1);
        tokio::time::sleep(INTERVAL).await;
        bounded(server.next().await.mode(run_id, None)).await;
        let recovered = wait_for_events(&captured, RECOVERED, 1).await;
        assert_eq!(recovered[0].level, Level::INFO);
        assert_eq!(recovered[0].fields["recovered_after_failures"], "3");
        assert_eq!(recovered[0].fields["was_degraded"], "true");
        assert!(!registration.is_cancelled());

        tokio::time::sleep(INTERVAL).await;
        bounded(respond_status(server.next().await, response)).await;
        let failures = wait_for_events(&captured, FAILURE, 2).await;
        assert_eq!(failures.len(), 2);
        assert_eq!(failures[1].level, Level::INFO);
        assert_eq!(failures[1].fields["consecutive_failures"], "1");
        assert_eq!(failures[1].fields["degraded"], "false");
        tokio::time::sleep(INTERVAL).await;
        bounded(server.next().await.mode(run_id, Some("hard"))).await;
        bounded(registration.handle().signals().hard().cancelled()).await;
        let recovered = events(&captured, RECOVERED);
        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered[1].fields["recovered_after_failures"], "1");
        assert_eq!(recovered[1].fields["was_degraded"], "false");
        assert_eq!(events(&captured, DEGRADED).len(), 1);
        assert!(registration.unregister().await);
        controller.shutdown().await;
    }
}

#[tokio::test(start_paused = true)]
async fn delayed_first_receipt_keeps_dispatch_cadence_and_delivers_cancellation() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let (accepted, first_accepted) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let mut server = Server::with_first_request_gate(Some(FirstRequestGate {
        accepted,
        release: released,
    }))
    .await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();

    let first_dispatch = Instant::now();
    let registration = bounded(observe(&controller, &registry, run_id)).await;
    // No clock advance separates the real dispatch and accepted socket.
    assert_eq!(bounded(first_accepted).await.unwrap(), first_dispatch);
    let receipt_delay = Duration::from_secs(1);
    tokio::time::advance(receipt_delay).await;
    release.send(()).unwrap();
    let first = server.next().await;
    let first_receipt = first.at;
    assert_eq!(first_receipt - first_dispatch, receipt_delay);
    bounded(respond_status(first, "502 Bad Gateway")).await;
    let failure = wait_for_events(&captured, FAILURE, 1).await;
    assert_status_context(&failure[0], run_id, 502);
    assert!(!registration.is_cancelled());

    // End the timer phase before bounded I/O freezes the retry observation.
    tokio::time::sleep_until(first_dispatch + INTERVAL).await;
    let retry = server.next().await;
    let dispatch_interval = retry.at - first_dispatch;
    let receipt_interval = retry.at - first_receipt;
    assert!(
        dispatch_interval >= INTERVAL,
        "dispatch interval: {dispatch_interval:?}; receipt interval: {receipt_interval:?}"
    );
    // A shorter peer gap is valid when the first receipt was delayed.
    assert!(
        receipt_interval < INTERVAL,
        "dispatch interval: {dispatch_interval:?}; receipt interval: {receipt_interval:?}"
    );
    bounded(retry.mode(run_id, Some("hard"))).await;
    bounded(registration.handle().signals().hard().cancelled()).await;
    assert!(events(&captured, DEGRADED).is_empty());
    assert!(registration.unregister().await);
    controller.shutdown().await;
}

#[tokio::test]
async fn isolated_bad_gateway_recovers_and_delivers_cancellation_without_warning() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = observe(&controller, &registry, run_id).await;
    let first = server.next().await;
    tokio::time::pause();
    respond_status(first, "502 Bad Gateway").await;
    let first_failure = wait_for_events(&captured, FAILURE, 1).await;
    assert_eq!(first_failure[0].level, Level::INFO);
    assert!(!registration.is_cancelled());

    tokio::time::sleep(INTERVAL).await;
    server.next().await.mode(run_id, Some("hard")).await;
    bounded(registration.handle().signals().hard().cancelled()).await;
    assert!(events(&captured, DEGRADED).is_empty());
    let recovered = events(&captured, RECOVERED);
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].fields["recovered_after_failures"], "1");
    assert_eq!(recovered[0].fields["was_degraded"], "false");
    assert_eq!(events(&captured, FAILURE).len(), 1);
    assert!(registration.unregister().await);
    controller.shutdown().await;
}

#[tokio::test]
async fn other_http_statuses_remain_immediate_warnings_without_delivering_cancellation() {
    for (status, response) in [
        (401, "401 Unauthorized"),
        (403, "403 Forbidden"),
        (404, "404 Not Found"),
        (429, "429 Too Many Requests"),
        (500, "500 Internal Server Error"),
        (501, "501 Not Implemented"),
    ] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let mut server = Server::new().await;
        let controller = server.controller();
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let registration = observe(&controller, &registry, run_id).await;
        let first = server.next().await;
        respond_status(first, response).await;
        let failures = wait_for_events(&captured, FAILURE, 1).await;
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].level, Level::WARN);
        assert_eq!(failures[0].fields["consecutive_failures"], "1");
        assert_status_context(&failures[0], run_id, status);
        assert!(events(&captured, DEGRADED).is_empty());
        assert!(!registration.is_cancelled());
        assert!(registration.unregister().await);
        controller.shutdown().await;
    }
}

#[tokio::test]
async fn forbidden_during_a_temporary_episode_warns_before_the_degradation_threshold() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = observe(&controller, &registry, run_id).await;
    let first = server.next().await;
    tokio::time::pause();
    tokio::time::sleep(Duration::from_secs(9)).await;
    respond_status(first, "502 Bad Gateway").await;
    assert_eq!(
        wait_for_events(&captured, FAILURE, 1).await[0].level,
        Level::INFO
    );

    tokio::time::sleep(Duration::from_secs(21)).await;
    respond_status(server.next().await, "403 Forbidden").await;
    let failures = wait_for_events(&captured, FAILURE, 2).await;
    assert_eq!(failures.len(), 2);
    assert_eq!(failures[1].level, Level::WARN);
    assert_eq!(failures[1].fields["consecutive_failures"], "2");
    assert!(
        failures[1].fields["failure_elapsed_ms"]
            .parse::<u64>()
            .unwrap()
            < 30000
    );
    assert_status_context(&failures[1], run_id, 403);
    assert!(events(&captured, DEGRADED).is_empty());
    assert!(!registration.is_cancelled());
    assert!(registration.unregister().await);
    controller.shutdown().await;
}
