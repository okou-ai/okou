use super::*;
use flate2::{Compression, write::GzEncoder};
use std::io::Write;

fn gzip(body: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(body).unwrap();
    encoder.finish().unwrap()
}

fn gzip_response(status: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[tokio::test]
async fn claim_negotiates_gzip_and_preserves_large_context_and_decoded_attribution() {
    let server = MockServer::start_async().await;
    let run_id = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let prompt = "界 compressed claim context\n".repeat(5000);
    let mut context: Value = serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
    context["prompt"] = Value::String(prompt.clone());
    let body = serde_json::to_vec(&context).unwrap();
    assert!((64 * 1024..256 * 1024).contains(&body.len()));
    let compressed = gzip(&body);
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/jobs/{run_id}/claim"))
                .header("accept-encoding", "gzip")
                .header("authorization", "Bearer runner-token");
            then.status(200)
                .header("content-type", "application/json")
                .header("content-encoding", "gzip")
                .body(compressed);
        })
        .await;

    let claimed = api_client_for_server(&server)
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.into(),
        ))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(claimed.context.run_id, run_id);
    assert_eq!(claimed.context.prompt, prompt);
    assert_eq!(
        claimed.context.vars.as_ref().unwrap()["FIXTURE_REGION"],
        "test-region"
    );
    let storages = &claimed.context.storage_manifest.as_ref().unwrap().storages;
    assert_eq!(storages.len(), 3);
    assert_eq!(
        storages
            .iter()
            .find(|entry| entry.vas_storage_name == "workflow")
            .unwrap()
            .vas_version_id,
        "b".repeat(64)
    );
    assert_eq!(
        claimed.response_attribution.body_size_bucket(),
        "64_256_kib"
    );
    assert_eq!(
        claimed.response_attribution.content_encoding(),
        "absent_or_decoded"
    );
    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn poll_decodes_gzip_and_claim_preserves_compressed_status_errors() {
    let server = MockServer::start_async().await;
    let poll = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::runners::poll::POLL.path)
                .header("accept-encoding", "gzip");
            then.status(200)
                .header("content-encoding", "gzip")
                .body(gzip(br#"{"job":null}"#));
        })
        .await;
    let run_id = RunId::new_v4();
    let claim = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/jobs/{run_id}/claim"));
            then.status(409)
                .header("content-encoding", "gzip")
                .body(gzip(b"already claimed"));
        })
        .await;
    let api = api_client_for_server(&server);

    assert!(
        api.poll(
            TEST_RUNNER_ID.parse().unwrap(),
            "default",
            &[],
            &[],
            PollReason::Immediate
        )
        .await
        .unwrap()
        .job
        .is_none()
    );
    let error = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.into(),
        ))
        .await
        .unwrap_err();
    let ClaimApiError::Request(ProviderError::ApiStatus(error)) = error else {
        panic!("expected the original HTTP status error");
    };
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert!(error.to_string().contains("already claimed"));
    poll.assert_calls_async(1).await;
    claim.assert_calls_async(1).await;
}

#[tokio::test]
async fn claim_rejects_corrupt_and_truncated_gzip_without_accepting_partial_json() {
    let body = gzip(RUNNER_CLAIM_RESPONSE_FIXTURE.as_bytes());
    let mut corrupt = body.clone();
    *corrupt.first_mut().unwrap() = 0;
    let mut truncated = body;
    truncated.truncate(truncated.len() - 4);
    for body in [corrupt, truncated] {
        // The HTTP body is complete; gzip itself is invalid or incomplete.
        let mut server =
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(gzip_response("200 OK", &body))])
                .await;
        let error = api_client_for_url(server.url())
            .claim_for_test(&JobCandidate::new(
                RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap(),
                crate::profile::DEFAULT_PROFILE.into(),
            ))
            .await
            .unwrap_err();
        assert!(matches!(error, ClaimApiError::ResponseRead(_)), "{error:?}");
        server.next_request("invalid compressed claim").await;
        server.assert_finished().await;
    }
}

async fn stalled_gzip_peer() -> (String, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (sent, received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut socket).await.unwrap();
        let body = gzip(RUNNER_CLAIM_RESPONSE_FIXTURE.as_bytes());
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(&body[..body.len() / 2]).await.unwrap();
        sent.send(()).unwrap();
        let mut byte = [0];
        let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
            .await
            .expect("dropped gzip response must disconnect");
        match read {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("expected peer closure, got {other:?}"),
        }
    });
    (url, received, server)
}

#[tokio::test]
async fn cancelling_claim_disconnects_a_stalled_gzip_body() {
    let (url, body_sent, server) = stalled_gzip_peer().await;
    let api = api_client_for_url(url);
    let claim = tokio::spawn(async move {
        api.claim_for_test(&JobCandidate::new(
            RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap(),
            crate::profile::DEFAULT_PROFILE.into(),
        ))
        .await
    });
    body_sent.await.unwrap();
    assert!(!claim.is_finished());
    claim.abort();
    assert!(claim.await.unwrap_err().is_cancelled());
    join_raw_http_task(server, "cancelled gzip body").await;
}

#[tokio::test]
async fn gzip_body_consumption_retains_the_whole_request_timeout() {
    let (url, body_sent, server) = stalled_gzip_peer().await;
    let api = api_client_for_url(url);
    let response = api
        .http
        .request_route(routes::runners::poll::POLL, "runner-token")
        .timeout(Duration::from_secs(1))
        .send("poll")
        .await
        .unwrap();
    body_sent.await.unwrap();
    // The response has passed header handling; its timer still owns body reads.
    raw_http_test_support::clock::advance_timer_phase(Duration::from_secs(1)).await;
    let error = response.bytes().await.unwrap_err();
    assert!(error.is_timeout(), "{error:?}");
    join_raw_http_task(server, "timed out gzip body").await;
}
