use super::*;
use crate::provider::RunnerPreferenceTarget;

fn preferred_candidate(run_id: RunId) -> JobCandidate {
    JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.into())
        .with_reuse_key(Some("thread:preferred-claim-retry".into()))
        .with_discovery_source(JobDiscoverySource::Ably)
        .with_runner_preference(ActiveRunnerPreference::new(
            test_runner_identity(),
            RunnerPreferenceTarget::HomeCache,
            Instant::now() + Duration::from_secs(10),
        ))
}

fn request_id(request: &str) -> &str {
    request
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("x-client-request-id")
                .then_some(value.trim())
        })
        .unwrap()
}

#[tokio::test]
async fn preferred_claim_recovers_retryable_failure_within_the_original_operation() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let sensitive_body = "private-claim-error-body";
    for (index, failure) in [
        RawHttpAction::Respond(format!("HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\ncf-ray: 0123456789abcdef-SEA\r\nx-vercel-id: iad1::request-1\r\n\r\n{sensitive_body}", sensitive_body.len()).into_bytes()),
        RawHttpAction::ResetConnection,
    ].into_iter().enumerate() {
        let server = RawHttpTestServer::spawn(vec![
            failure,
            RawHttpAction::Respond(json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE)),
        ])
        .await;
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let (claimed, events) =
            capture_api_provider_events(provider.claim(preferred_candidate(run_id))).await;
        assert_eq!(
            claimed
                .expect("a retryable failure must retain the original claim operation")
                .context()
                .run_id,
            run_id
        );
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 2);
        assert_ne!(request_id(&requests[0]), request_id(&requests[1]));
        let headers: Vec<_> = events.iter().filter(|event| event.fields.get("message").map(String::as_str) == Some("claim response headers received")).collect();
        assert_eq!(headers.len(), if index == 0 { 2 } else { 1 });
        if index == 0 {
            assert_eq!(event_field(headers[0], "client_request_id"), request_id(&requests[0]));
            assert_eq!(event_field(headers[0], "http_status"), "500");
            assert_eq!(event_field(headers[0], "response_cf_ray"), "0123456789abcdef-SEA");
            assert_eq!(event_field(headers[0], "response_vercel_id"), "iad1::request-1");
        }
        assert_eq!(event_field(headers.last().unwrap(), "client_request_id"), request_id(&requests[1]));
        let mut bodies = Vec::new();
        for request in &requests {
            assert!(request.starts_with(&format!(
                "POST /api/runners/jobs/{run_id}/claim?workflowSkills=2&singleCharacterSkills=1 "
            )));
            let body: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(
                body["runnerIdentity"],
                serde_json::json!(test_runner_identity())
            );
            assert_eq!(body["telemetry"]["runnerPreferenceClaimState"], "active");
            bodies.push(body);
        }
        let first_ms = bodies[0]["telemetry"]["jobDiscoveredToClaimRequestMs"]
            .as_u64()
            .unwrap();
        let second_ms = bodies[1]["telemetry"]["jobDiscoveredToClaimRequestMs"]
            .as_u64()
            .unwrap();
        assert!(
            second_ms >= first_ms + duration_ms(PREFERRED_CLAIM_RETRY_DELAY),
            "claim telemetry must include the failed attempt and backoff"
        );
        assert!(
            !format!("{events:#?}").contains(sensitive_body),
            "failed claim response bodies must stay private"
        );
        provider.shutdown().await;
    }
}

#[tokio::test]
async fn preferred_claim_retry_settles_unavailable_or_enters_cooldown() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let other_run = RunId::new_v4();
    for (first, second, must_exclude) in [
        (
            RawHttpAction::Respond(status_response(500)),
            RawHttpAction::Respond(status_response(500)),
            true,
        ),
        (
            RawHttpAction::Respond(status_response(500)),
            RawHttpAction::Respond(status_response(404)),
            false,
        ),
        (
            RawHttpAction::ResetConnection,
            RawHttpAction::Respond(status_response(500)),
            true,
        ),
        (
            RawHttpAction::ResetConnection,
            RawHttpAction::Respond(status_response(404)),
            false,
        ),
        (
            RawHttpAction::ResetConnection,
            RawHttpAction::ResetConnection,
            true,
        ),
    ] {
        let server = RawHttpTestServer::spawn(vec![
            first,
            second,
            RawHttpAction::Respond(poll_job_response(other_run)),
        ])
        .await;
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        assert!(provider.claim(preferred_candidate(run_id)).await.is_none());
        let next = tokio::time::timeout(Duration::from_secs(5), provider.discover())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.run_id(), other_run);
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 3);
        for request in &requests[..2] {
            assert!(request.starts_with(&format!(
                "POST /api/runners/jobs/{run_id}/claim?workflowSkills=2&singleCharacterSkills=1 "
            )));
        }
        assert!(requests[2].starts_with("POST /api/runners/poll "));
        let poll: Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        let excludes_run = poll["excludedRunIds"]
            .as_array()
            .is_some_and(|runs| runs.contains(&serde_json::json!(run_id)));
        assert_eq!(excludes_run, must_exclude);
        provider.shutdown().await;
    }
}

#[tokio::test]
async fn only_retryable_failures_with_an_active_local_reuse_preference_recover() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let expired = preferred_candidate(run_id).with_runner_preference(ActiveRunnerPreference::new(
        test_runner_identity(),
        RunnerPreferenceTarget::HomeCache,
        Instant::now() - Duration::from_secs(1),
    ));
    let insufficient =
        preferred_candidate(run_id).with_runner_preference(ActiveRunnerPreference::new(
            test_runner_identity(),
            RunnerPreferenceTarget::HomeCache,
            Instant::now() + Duration::from_millis(10),
        ));
    let other_process =
        preferred_candidate(run_id).with_runner_preference(ActiveRunnerPreference::new(
            RunnerProcessIdentity::new(
                TEST_RUNNER_ID.parse().unwrap(),
                TEST_HEARTBEAT_GENERATION + 1,
            )
            .unwrap(),
            RunnerPreferenceTarget::HomeCache,
            Instant::now() + Duration::from_secs(10),
        ));
    let mut cases = vec![
        (
            RawHttpAction::Respond(status_response(400)),
            preferred_candidate(run_id),
        ),
        (
            RawHttpAction::Respond(status_response(429)),
            preferred_candidate(run_id),
        ),
        (
            RawHttpAction::Respond(status_response(503)),
            preferred_candidate(run_id),
        ),
        (RawHttpAction::Disconnect, preferred_candidate(run_id)),
        (
            RawHttpAction::Respond(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{".to_vec(),
            ),
            preferred_candidate(run_id),
        ),
    ];
    for candidate in [
        JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.into()),
        preferred_candidate(run_id).with_reuse_key(None),
        preferred_candidate(run_id).with_reuse_key(Some(String::new())),
        preferred_candidate(run_id)
            .without_runner_preference(RunnerPreferenceRemovalReason::Cleared),
        expired,
        insufficient,
        other_process,
    ] {
        cases.push((
            RawHttpAction::Respond(status_response(500)),
            candidate.clone(),
        ));
        cases.push((RawHttpAction::ResetConnection, candidate));
    }
    for (failure, candidate) in cases {
        // Keep a successful second response available: an unintended retry
        // would produce an executable job instead of the required rejection.
        let mut server = RawHttpTestServer::spawn(vec![
            failure,
            RawHttpAction::Respond(json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE)),
        ])
        .await;
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        assert!(provider.claim(candidate).await.is_none());
        let request = server.next_request("the single rejected claim").await;
        assert!(request.starts_with(&format!("POST /api/runners/jobs/{run_id}/claim?")));
        assert!(server.try_next_request().is_err());
        provider.shutdown().await;
        server.cancel_and_reap().await;
    }
}

#[tokio::test]
async fn shutdown_after_the_initial_submission_does_not_admit_a_retry() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let (release, wait) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: wait,
            response: status_response(500),
        },
        RawHttpAction::Respond(json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE)),
    ])
    .await;
    let cancel = CancellationToken::new();
    let provider = api_provider_for_test(
        server.url(),
        cancel.clone(),
        Arc::new(PollWakeups::new(false)),
    );
    let claiming = Arc::clone(&provider);
    let claim = tokio::spawn(async move { claiming.claim(preferred_candidate(run_id)).await });
    server.next_request("the initially accepted claim").await;
    cancel.cancel();
    release.send(()).unwrap();

    assert!(
        join_raw_http_task(claim, "claim settlement during shutdown")
            .await
            .is_none()
    );
    assert!(server.try_next_request().is_err());
    provider.shutdown().await;
    server.cancel_and_reap().await;
}

#[tokio::test]
async fn preferred_claim_retry_stays_excluded_while_other_work_progresses() {
    for connection_reset in [false, true] {
        let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
        let other_run = RunId::new_v4();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (entered, retry_entered) = oneshot::channel();
        let (release, retry_release) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            read_http_request(&mut first).await.unwrap();
            if connection_reset {
                first.set_zero_linger().unwrap();
            } else {
                first.write_all(&status_response(500)).await.unwrap();
            }
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            entered
                .send(read_http_request(&mut second).await.unwrap())
                .unwrap();
            let (mut poll, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut poll).await.unwrap();
            poll.write_all(&poll_job_response(other_run)).await.unwrap();
            drop(poll);
            retry_release.await.unwrap();
            second
                .write_all(&json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE))
                .await
                .unwrap();
            request
        });
        let provider = api_provider_for_test(
            url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(true)),
        );
        let claiming = Arc::clone(&provider);
        let candidate =
            preferred_candidate(run_id).with_runner_preference(ActiveRunnerPreference::new(
                test_runner_identity(),
                RunnerPreferenceTarget::ExactSandbox(RunId::new_v4()),
                Instant::now() + Duration::from_secs(10),
            ));
        let claim = tokio::spawn(async move { claiming.claim(candidate).await });
        let second = tokio::time::timeout(Duration::from_secs(5), retry_entered)
            .await
            .unwrap()
            .unwrap();
        assert!(second.starts_with(&format!("POST /api/runners/jobs/{run_id}/claim?")));
        let other = tokio::time::timeout(Duration::from_secs(5), provider.discover())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(other.run_id(), other_run);
        release.send(()).unwrap();

        let job = join_raw_http_task(claim, "recovered preferred claim")
            .await
            .unwrap();
        assert_eq!(job.context().run_id, run_id);
        let poll = join_raw_http_task(server, "parallel discovery peer").await;
        let body: Value = serde_json::from_str(poll.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["excludedRunIds"], serde_json::json!([run_id]));
        provider.shutdown().await;
    }
}
