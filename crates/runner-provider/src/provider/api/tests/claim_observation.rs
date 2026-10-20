use super::*;

fn request_header<'a>(request: &'a str, name: &str) -> &'a str {
    request
        .split("\r\n\r\n")
        .next()
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value.trim()))
        .unwrap_or_else(|| panic!("request missing {name}"))
}

fn assert_request_correlation(event: &CapturedEvent, request: &str, run_id: RunId) {
    assert_eq!(event.level, Level::INFO);
    assert_eq!(event_field(event, "run_id"), run_id.to_string());
    for (field, header) in [
        ("client_request_id", "x-client-request-id"),
        ("client_session_id", "x-client-session-id"),
    ] {
        assert_eq!(event_field(event, field), request_header(request, header));
    }
    Uuid::parse_str(event_field(event, "client_request_id")).unwrap();
}

fn elapsed_ms(event: &CapturedEvent, name: &str) -> u64 {
    event_field(event, name).parse().unwrap()
}

fn assert_completed_observation(
    events: &[CapturedEvent],
    request: &str,
    run_id: RunId,
    outcome: &str,
    status: Option<u16>,
) {
    let started = captured_event(events, "claim request execution started");
    let completed = captured_event(events, "claim request completed");
    assert_request_correlation(started, request, run_id);
    assert_request_correlation(completed, request, run_id);
    assert_eq!(event_field(completed, "outcome"), outcome);
    assert_eq!(
        event_field(started, "client_version"),
        request_header(request, "x-client-version")
    );
    assert_eq!(
        completed.fields.get("http_status"),
        status.map(|value| value.to_string()).as_ref()
    );
    assert_eq!(
        event_field(completed, "response_headers_received"),
        status.is_some().to_string()
    );
    assert!(
        elapsed_ms(completed, "claim_elapsed_ms")
            >= elapsed_ms(completed, "execution_to_completion_ms")
    );
    if let Some(status) = status {
        let headers = captured_event(events, "claim response headers received");
        assert_request_correlation(headers, request, run_id);
        assert_eq!(event_field(headers, "http_status"), status.to_string());
        assert_eq!(
            event_field(headers, "execution_to_response_headers_ms"),
            event_field(completed, "execution_to_response_headers_ms")
        );
        assert!(
            elapsed_ms(completed, "execution_to_completion_ms")
                >= elapsed_ms(headers, "execution_to_response_headers_ms")
        );
    } else {
        assert!(
            !completed
                .fields
                .contains_key("execution_to_response_headers_ms")
        );
        assert!(!events.iter().any(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("claim response headers received")
        }));
    }
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str) == Some("claim request completed")
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn unavailable_claim_records_execution_before_a_gated_response() {
    let run_id = RunId::new_v4();
    let (release, gate) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: gate,
        response: http_response("404 Not Found", b"private unavailable response"),
    }])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let mut candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.into())
        .with_discovery_source(JobDiscoverySource::Ably)
        .with_direct_candidate_timing(
            Some(Duration::from_millis(2)),
            Some(Duration::from_millis(3)),
        );
    candidate.mark_provider_discovery_returned();
    candidate.mark_main_loop_handling_started();
    candidate.mark_local_admission_started();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let claiming = Arc::clone(&provider);
    let claim =
        tokio::spawn(async move { claiming.claim(candidate).await }.with_subscriber(subscriber));
    let request = server.next_request("gated unavailable claim").await;
    let pending = captured.entries();
    let started = captured_event(&pending, "claim request execution started");
    assert_request_correlation(started, &request, run_id);
    assert_eq!(event_field(started, "discovery_source"), "ably");
    assert_eq!(
        event_field(started, "direct_candidate_notification_to_enqueue_ms"),
        "2"
    );
    assert_eq!(event_field(started, "direct_candidate_inbox_wait_ms"), "3");
    assert!(
        started
            .fields
            .contains_key("provider_discovery_to_main_loop_ms")
    );
    assert!(
        started
            .fields
            .contains_key("main_loop_to_local_admission_ms")
    );
    assert!(
        started
            .fields
            .contains_key("local_admission_to_execution_ms")
    );
    let lookup = captured_event(&pending, "claim cancellation lookup completed");
    assert_eq!(lookup.level, Level::INFO);
    assert_eq!(event_field(lookup, "run_id"), run_id.to_string());
    assert!(lookup.fields.contains_key("cancellation_lookup_ms"));
    assert!(!pending.iter().any(|event| {
        event.fields.get("message").map(String::as_str) == Some("claim request completed")
    }));
    assert!(!claim.is_finished());

    release.send(()).unwrap();
    assert!(
        join_raw_http_task(claim, "gated unavailable claim")
            .await
            .is_none()
    );
    let events = captured.entries();
    assert_completed_observation(&events, &request, run_id, "unavailable", Some(404));
    let completed = captured_event(&events, "claim request completed");
    assert!(!completed.fields.contains_key("response_body_read_ms"));
    assert!(!completed.fields.contains_key("response_decode_ms"));
    assert!(
        events
            .iter()
            .all(|event| event.level != Level::WARN && event.level != Level::ERROR),
        "ordinary unavailability must not emit warnings/errors: {events:#?}"
    );
    provider.shutdown().await;
    server.assert_finished().await;
}

#[tokio::test]
async fn claim_observations_cover_success_status_transport_read_and_decode_outcomes() {
    let run_id = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let cases = [
        (
            RawHttpAction::Respond(json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE)),
            "response_decoded",
            Some(200),
        ),
        (
            RawHttpAction::Respond(http_response("409 Conflict", b"private status response")),
            "http_error",
            Some(409),
        ),
        (
            RawHttpAction::Respond(http_response(
                "503 Service Unavailable",
                b"private status response",
            )),
            "http_error",
            Some(503),
        ),
        (RawHttpAction::Disconnect, "transport_error", None),
        (
            RawHttpAction::Respond(
                b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{\"runId\":"
                    .to_vec(),
            ),
            "response_read_error",
            Some(200),
        ),
        (
            RawHttpAction::Respond(http_response("200 OK", b"private invalid JSON")),
            "response_decode_error",
            Some(200),
        ),
    ];
    for (action, outcome, status) in cases {
        let mut server = RawHttpTestServer::spawn(vec![action]).await;
        let api = api_client_for_url(server.url());
        let candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.into())
            .with_discovery_source(JobDiscoverySource::Poll)
            .with_poll_timing(Duration::from_millis(4), Duration::from_millis(5));
        let (result, events) = capture_api_provider_events(api.claim_for_test(&candidate)).await;
        match (outcome, result) {
            ("response_decoded", Ok(Some(claimed))) => assert_eq!(claimed.context.run_id, run_id),
            ("http_error", Err(ClaimApiError::Request(ProviderError::ApiStatus(error)))) => {
                assert_eq!(Some(error.status.as_u16()), status);
            }
            ("transport_error", Err(ClaimApiError::Request(ProviderError::ApiTransport(_))))
            | ("response_read_error", Err(ClaimApiError::ResponseRead(_)))
            | ("response_decode_error", Err(ClaimApiError::ResponseDecode(_))) => {}
            (_, result) => panic!("unexpected {outcome} outcome: {result:?}"),
        }
        let request = server.next_request("claim observation outcome").await;
        assert_completed_observation(&events, &request, run_id, outcome, status);
        let started = captured_event(&events, "claim request execution started");
        assert_eq!(event_field(started, "discovery_source"), "poll");
        assert_eq!(event_field(started, "poll_due_to_job_discovered_ms"), "4");
        assert_eq!(event_field(started, "poll_http_request_ms"), "5");
        assert!(
            !started
                .fields
                .contains_key("direct_candidate_inbox_wait_ms")
        );
        let completed = captured_event(&events, "claim request completed");
        if status.is_some() {
            assert!(completed.fields.contains_key("response_body_read_ms"));
            assert!(
                elapsed_ms(completed, "execution_to_completion_ms")
                    >= elapsed_ms(completed, "response_body_read_ms")
            );
        } else {
            assert!(completed.fields.contains_key("transport_failure_kind"));
            assert!(completed.fields.contains_key("transport_failure_cause"));
        }
        assert_eq!(
            completed.fields.contains_key("response_decode_ms"),
            matches!(outcome, "response_decoded" | "response_decode_error")
        );
        let diagnostic = format!("{events:?}");
        for sensitive in [
            "runner-token",
            "authorization",
            "private status response",
            "private invalid JSON",
            "fixture-secret-value-not-real",
            "FIXTURE_API_KEY",
            "fixture-model",
        ] {
            assert!(
                !diagnostic.contains(sensitive),
                "diagnostics leaked {sensitive}"
            );
        }
        server.assert_finished().await;
    }
}

#[tokio::test]
async fn claim_timeout_retains_request_identity_without_inventing_response_timing() {
    let run_id = RunId::new_v4();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Stall]).await;
    let api = api_client_for_url(server.url());
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let claim = tokio::spawn(
        async move {
            api.claim_for_test(&JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.into(),
            ))
            .await
        }
        .with_subscriber(subscriber),
    );
    let request = server.next_request("claim that times out").await;
    // Keep the existing ten-second production timeout. The raw peer deliberately
    // withholds its response; no sleep or shortened test-only transport is used.
    let result = tokio::time::timeout(Duration::from_secs(15), claim)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        result,
        Err(ClaimApiError::Request(ProviderError::ApiTransport(ref error)))
            if error.failure_kind == ApiFailureKind::Timeout
    ));
    let events = captured.entries();
    assert_completed_observation(&events, &request, run_id, "transport_error", None);
    let completed = captured_event(&events, "claim request completed");
    assert_eq!(event_field(completed, "transport_failure_kind"), "timeout");
    assert!(!completed.fields.contains_key("response_body_read_ms"));
    assert!(!completed.fields.contains_key("response_decode_ms"));
    server.cancel_and_reap().await;
}
