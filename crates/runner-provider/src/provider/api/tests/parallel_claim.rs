use super::*;

fn request_body(request: &str) -> serde_json::Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

// This case observes real TCP requests across the provider's ordinary poll
// timer. A paused clock can expire the claim before kernel I/O progresses.
#[tokio::test]
async fn pending_claim_exclusions_do_not_rearm_immediate_poll() {
    tokio::join!(
        assert_pending_poll_cadence(false),
        assert_pending_poll_cadence(true)
    );
}

async fn assert_pending_poll_cadence(ignore_exclusions: bool) {
    let slow = RunId::new_v4();
    let fast = RunId::new_v4();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (entered, claim_entered) = oneshot::channel();
    let (release, mut claim_release) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut claim, _) = listener.accept().await.unwrap();
        entered
            .send(read_http_request(&mut claim).await.unwrap())
            .unwrap();
        let (mut poll, _) = listener.accept().await.unwrap();
        let first = read_http_request(&mut poll).await.unwrap();
        let response = if ignore_exclusions {
            poll_job_response(slow)
        } else {
            json_response("200 OK", r#"{"job":null}"#)
        };
        poll.write_all(&response).await.unwrap();
        drop(poll);

        // With no other notification, an empty excluded response or an
        // API returning the in-flight Run must wait for ordinary cadence,
        // rather than perpetually rearming the immediate backlog path.
        let next = tokio::select! {
            connection = listener.accept() => {
                let (mut poll, _) = connection.unwrap();
                let request = read_http_request(&mut poll).await.unwrap();
                poll.write_all(&poll_job_response(fast)).await.unwrap();
                claim_release.await.unwrap();
                Some(request)
            }
            result = &mut claim_release => {
                result.unwrap();
                None
            },
        };
        claim
            .write_all(&http_response("404 Not Found", b"unavailable"))
            .await
            .unwrap();
        (first, next)
    });
    let provider = api_provider_for_test(
        url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let claiming = Arc::clone(&provider);
    let claim = tokio::spawn(async move {
        claiming
            .claim(JobCandidate::new(
                slow,
                crate::profile::DEFAULT_PROFILE.into(),
            ))
            .await
    });
    let request = claim_entered.await.unwrap();
    assert!(request.starts_with(&format!("POST /api/runners/jobs/{slow}/claim ")));
    let candidate = tokio::time::timeout(POLL_FAST + Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    release.send(()).unwrap();
    assert!(
        join_raw_http_task(claim, "pending claim settlement")
            .await
            .is_none()
    );
    let (first, next) = join_raw_http_task(server, "pending claim poll server").await;
    provider.shutdown().await;

    assert_eq!(candidate.run_id(), fast);
    assert_eq!(
        request_body(&first)["excludedRunIds"],
        serde_json::json!([slow])
    );
    let next = request_body(&next.expect("discovery must remain pending until the next poll"));
    assert_eq!(next["excludedRunIds"], serde_json::json!([slow]));
    assert_eq!(next["telemetry"]["pollReason"], "fast");
}

#[tokio::test]
async fn poll_excludes_an_in_flight_claim_and_discovers_other_work() {
    let slow = RunId::new_v4();
    let fast = RunId::new_v4();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (entered, claim_entered) = oneshot::channel();
    let (release, claim_release) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut initial_poll, _) = listener.accept().await.unwrap();
        let initial = read_http_request(&mut initial_poll).await.unwrap();
        assert!(initial.starts_with(&format!("POST {} ", routes::runners::poll::POLL.path)));
        initial_poll
            .write_all(&poll_job_response(slow))
            .await
            .unwrap();
        drop(initial_poll);

        let (mut claim, _) = listener.accept().await.unwrap();
        let claim_request = read_http_request(&mut claim).await.unwrap();
        entered.send(claim_request).unwrap();

        let (mut poll, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut poll).await.unwrap();
        let excludes_slow = request_body(&request)["excludedRunIds"]
            .as_array()
            .is_some_and(|runs| runs.contains(&serde_json::json!(slow)));
        // A queued oldest run remains visible until its claim commits. The API
        // can return the next eligible run only when the poll excludes it.
        poll.write_all(&poll_job_response(if excludes_slow { fast } else { slow }))
            .await
            .unwrap();
        drop(poll);
        claim_release.await.unwrap();
        claim
            .write_all(&http_response("404 Not Found", b"unavailable"))
            .await
            .unwrap();
        request
    });
    let provider = api_provider_for_test(
        url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    let candidate = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), slow);
    let claiming = Arc::clone(&provider);
    let claim = tokio::spawn(async move { claiming.claim(candidate).await });
    let request = tokio::time::timeout(Duration::from_secs(5), claim_entered)
        .await
        .unwrap()
        .unwrap();
    assert!(request.starts_with(&format!("POST /api/runners/jobs/{slow}/claim ")));

    let candidate = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    release.send(()).unwrap();
    assert!(
        join_raw_http_task(claim, "blocked claim settlement")
            .await
            .is_none()
    );
    let request = join_raw_http_task(server, "concurrent claim/poll server").await;
    provider.shutdown().await;

    assert_eq!(
        candidate.run_id(),
        fast,
        "an outstanding claim must not hide unrelated queued work"
    );
    assert_eq!(
        request_body(&request)["excludedRunIds"],
        serde_json::json!([slow])
    );
}

#[tokio::test]
async fn successful_claim_settlement_retires_exclusion_and_wakes_empty_poll() {
    let slow: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let fast = RunId::new_v4();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (entered, claim_entered) = oneshot::channel();
    let (empty_sent, empty_response) = oneshot::channel();
    let (release, claim_release) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut claim, _) = listener.accept().await.unwrap();
        entered
            .send(read_http_request(&mut claim).await.unwrap())
            .unwrap();
        let (mut poll, _) = listener.accept().await.unwrap();
        let first = read_http_request(&mut poll).await.unwrap();
        poll.write_all(&json_response("200 OK", r#"{"job":null}"#))
            .await
            .unwrap();
        drop(poll);
        empty_sent.send(()).unwrap();
        claim_release.await.unwrap();
        claim
            .write_all(&json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE))
            .await
            .unwrap();
        drop(claim);
        let (mut poll, _) = listener.accept().await.unwrap();
        let next = read_http_request(&mut poll).await.unwrap();
        poll.write_all(&poll_job_response(fast)).await.unwrap();
        (first, next)
    });
    let provider = api_provider_for_test(
        url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    let claiming = Arc::clone(&provider);
    let claim = tokio::spawn(async move {
        claiming
            .claim(JobCandidate::new(
                slow,
                crate::profile::DEFAULT_PROFILE.into(),
            ))
            .await
    });
    claim_entered.await.unwrap();
    let discovering = Arc::clone(&provider);
    let discovery = tokio::spawn(async move { discovering.discover().await });
    tokio::time::timeout(Duration::from_secs(5), empty_response)
        .await
        .unwrap()
        .unwrap();
    release.send(()).unwrap();
    assert!(
        join_raw_http_task(claim, "successful claim settlement")
            .await
            .is_some()
    );
    let candidate = join_raw_http_task(discovery, "claim settlement wakeup")
        .await
        .unwrap();
    let (first, next) = join_raw_http_task(server, "successful claim poll server").await;
    provider.shutdown().await;

    assert_eq!(candidate.run_id(), fast);
    assert_eq!(
        request_body(&first)["excludedRunIds"],
        serde_json::json!([slow])
    );
    let next = request_body(&next);
    assert!(next.get("excludedRunIds").is_none());
    assert_eq!(next["telemetry"]["pollReason"], "immediate");
}

#[tokio::test]
async fn pending_claim_has_exclusion_priority_without_evicting_full_cooldown_inventory() {
    let cooldowns: Vec<_> = (0..CLAIM_COOLDOWN_CAPACITY)
        .map(|_| RunId::new_v4())
        .collect();
    let server_cooldowns = cooldowns.clone();
    let slow = RunId::new_v4();
    let first_fast = RunId::new_v4();
    let next_fast = RunId::new_v4();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (entered, claim_entered) = oneshot::channel();
    let (release, claim_release) = oneshot::channel();
    let server = tokio::spawn(async move {
        for run_id in server_cooldowns {
            let (mut claim, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut claim).await.unwrap();
            assert!(request.starts_with(&format!("POST /api/runners/jobs/{run_id}/claim ")));
            claim.write_all(&status_response(400)).await.unwrap();
        }
        let (mut claim, _) = listener.accept().await.unwrap();
        entered
            .send(read_http_request(&mut claim).await.unwrap())
            .unwrap();
        let (mut poll, _) = listener.accept().await.unwrap();
        let first = read_http_request(&mut poll).await.unwrap();
        poll.write_all(&poll_job_response(first_fast))
            .await
            .unwrap();
        drop(poll);
        claim_release.await.unwrap();
        claim
            .write_all(&http_response("404 Not Found", b"unavailable"))
            .await
            .unwrap();
        drop(claim);
        let (mut poll, _) = listener.accept().await.unwrap();
        let next = read_http_request(&mut poll).await.unwrap();
        poll.write_all(&poll_job_response(next_fast)).await.unwrap();
        (first, next)
    });
    let provider = api_provider_for_test(
        url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    for run_id in &cooldowns {
        assert!(
            provider
                .claim(JobCandidate::new(
                    *run_id,
                    crate::profile::DEFAULT_PROFILE.into()
                ))
                .await
                .is_none()
        );
    }
    let claiming = Arc::clone(&provider);
    let claim = tokio::spawn(async move {
        claiming
            .claim(JobCandidate::new(
                slow,
                crate::profile::DEFAULT_PROFILE.into(),
            ))
            .await
    });
    claim_entered.await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    release.send(()).unwrap();
    assert!(
        join_raw_http_task(claim, "pending claim at full cooldown capacity")
            .await
            .is_none()
    );
    let next = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    let (first_request, next_request) =
        join_raw_http_task(server, "full cooldown poll server").await;
    provider.shutdown().await;

    assert_eq!(first.run_id(), first_fast);
    assert_eq!(next.run_id(), next_fast);
    let first_body = request_body(&first_request);
    let first_exclusions = first_body["excludedRunIds"].as_array().unwrap();
    assert_eq!(first_exclusions.len(), CLAIM_COOLDOWN_CAPACITY);
    assert!(first_exclusions.contains(&serde_json::json!(slow)));
    assert!(
        cooldowns
            .iter()
            .filter(|id| first_exclusions.contains(&serde_json::json!(id)))
            .count()
            == CLAIM_COOLDOWN_CAPACITY - 1
    );
    let next_body = request_body(&next_request);
    let next_exclusions = next_body["excludedRunIds"].as_array().unwrap();
    assert_eq!(next_exclusions.len(), CLAIM_COOLDOWN_CAPACITY);
    assert!(
        cooldowns
            .iter()
            .all(|id| next_exclusions.contains(&serde_json::json!(id)))
    );
    assert!(!next_exclusions.contains(&serde_json::json!(slow)));
}
