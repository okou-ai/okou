use super::*;

fn request_body(request: &str) -> serde_json::Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[tokio::test]
async fn candidate_deferrals_keep_unrelated_poll_work_ready() {
    let first = RunId::new_v4();
    let second = RunId::new_v4();
    let unrelated = RunId::new_v4();
    let server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(poll_job_response(unrelated))]).await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    provider
        .defer_candidate_until(first, Instant::now() + Duration::from_secs(30))
        .await;
    provider
        .defer_candidate_until(second, Instant::now() + Duration::from_secs(60))
        .await;
    let candidate = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), unrelated);
    let requests = server.assert_finished_with_requests().await;
    let exclusions = request_body(&requests[0])["excludedRunIds"]
        .as_array()
        .unwrap()
        .clone();
    assert!(exclusions.contains(&serde_json::json!(first)));
    assert!(exclusions.contains(&serde_json::json!(second)));
    provider.shutdown().await;
}

// Real TCP stays on real time. The candidate's deadline is the behavior under
// test, not a sleep added to make a race pass.
#[tokio::test]
async fn earliest_candidate_expiry_survives_later_deferral_and_duplicate_hint() {
    let first = RunId::new_v4();
    let later = RunId::new_v4();
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"job":null}"#)),
        RawHttpAction::Respond(poll_job_response(first)),
    ])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    provider
        .defer_candidate_until(first, Instant::now() + Duration::from_millis(300))
        .await;
    provider
        .defer_candidate_until(later, Instant::now() + Duration::from_secs(30))
        .await;
    provider
        .defer_candidate_until(first, Instant::now() + Duration::from_secs(60))
        .await;
    let candidate = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), first);
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(
        request_body(&requests[1])["excludedRunIds"],
        serde_json::json!([later])
    );
    provider.shutdown().await;
}

#[tokio::test]
async fn candidate_deferral_filters_a_poll_result_that_raced_registration() {
    let held = RunId::new_v4();
    let unrelated = RunId::new_v4();
    let (release, response) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: response,
            response: poll_job_response(held),
        },
        RawHttpAction::Respond(poll_job_response(unrelated)),
    ])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    let discovering = Arc::clone(&provider);
    let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        discovering.discover().await.unwrap()
    }));
    server.next_request("poll before admission hold").await;
    provider
        .defer_candidate_until(held, Instant::now() + Duration::from_secs(30))
        .await;
    release.send(()).unwrap();
    let candidate = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), unrelated);
    let requests = server.assert_finished_with_requests().await;
    // next_request consumed the first request above; these are unread requests.
    assert_eq!(requests.len(), 1);
    assert_eq!(
        request_body(&requests[0])["excludedRunIds"],
        serde_json::json!([held])
    );
    provider.shutdown().await;
}

#[tokio::test]
async fn stopping_admission_releases_candidate_exclusions_before_resume() {
    let run_id = RunId::new_v4();
    let server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(poll_job_response(run_id))]).await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    provider
        .defer_candidate_until(run_id, Instant::now() + Duration::from_secs(30))
        .await;
    provider.clear_candidate_deferrals().await;
    assert_eq!(provider.discover().await.unwrap().run_id(), run_id);
    let requests = server.assert_finished_with_requests().await;
    assert!(request_body(&requests[0]).get("excludedRunIds").is_none());
    provider.shutdown().await;
}

#[tokio::test]
async fn partial_admission_expiry_during_an_excluded_poll_wakes_the_earlier_run() {
    let first = RunId::new_v4();
    let later = RunId::new_v4();
    let (release, response) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: response,
            response: json_response("200 OK", r#"{"job":null}"#),
        },
        RawHttpAction::Respond(poll_job_response(first)),
    ])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    let first_deadline = Instant::now() + Duration::from_secs(2);
    provider.defer_candidate_until(first, first_deadline).await;
    provider
        .defer_candidate_until(later, Instant::now() + Duration::from_secs(30))
        .await;
    let discovering = Arc::clone(&provider);
    let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        discovering.discover().await.unwrap()
    }));
    let request = server
        .next_request("excluded poll before first admission expiry")
        .await;
    assert!(
        request_body(&request)["excludedRunIds"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(first))
    );
    // Hold real I/O across expiry, then resume real time before releasing it.
    // No later holder may swallow the deadline of a run excluded by this poll.
    raw_http_test_support::clock::advance_timer_phase(
        first_deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
    )
    .await;
    release.send(()).unwrap();
    let candidate = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), first);
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(
        request_body(&requests[0])["excludedRunIds"],
        serde_json::json!([later])
    );
    provider.shutdown().await;
}

#[tokio::test]
async fn releasing_an_already_pruned_candidate_still_wakes_discovery() {
    let expired = RunId::new_v4();
    let later = RunId::new_v4();
    let (release, response) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: response,
            response: json_response("200 OK", r#"{"job":null}"#),
        },
        RawHttpAction::Respond(poll_job_response(expired)),
    ])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    provider
        .defer_candidate_until(later, Instant::now() + Duration::from_secs(30))
        .await;
    // Lazy expiry can remove this hold before Reactor releases its waiter,
    // including while all claim slots prevent another discovery poll.
    assert!(!provider.admission_deferrals.contains(expired));
    let discovering = Arc::clone(&provider);
    let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        discovering.discover().await.unwrap()
    }));
    server
        .next_request("poll after the earlier hold was pruned")
        .await;
    provider.release_candidate_deferral(expired).await;
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .run_id(),
        expired
    );
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(
        request_body(&requests[0])["excludedRunIds"],
        serde_json::json!([later])
    );
    provider.shutdown().await;
}
