use super::*;

#[tokio::test]
async fn supplied_publication_binds_run_scoped_controls_and_completion() {
    let run_id = RunId::new_v4();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response(
            "200 OK",
            &serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone"}).to_string(),
        )),
        RawHttpAction::Respond(http_response("204 No Content", b"")),
    ])
    .await;
    let provider = api_provider_for_test(server.url(), CancellationToken::new());
    let registration = provider.cancel_tokens.register(run_id).await.unwrap();
    let mut publication: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    publication["runId"] = serde_json::json!(run_id);
    publication["reuseKey"] = serde_json::json!("thread:supplied");
    publication["sandboxToken"] = serde_json::json!("supplied-run-token");
    let context = decode_execution_publication(&serde_json::to_vec(&publication).unwrap()).unwrap();
    assert!(
        context.instruction_file.is_some(),
        "shared content normalization is required on supplied work"
    );
    let claimed = provider.bind_supplied(context).await.unwrap();
    assert!(matches!(
        claimed.active_input_source(),
        Some(ActiveInputSource::Api(_))
    ));
    let request = server
        .next_request("supplied Run cancellation reconciliation")
        .await;
    assert!(request.starts_with(&format!("GET /api/runners/runs/{run_id}/cancellation?")));
    assert!(request.contains("authorization: Bearer supplied-run-token"));
    tokio::time::timeout(
        Duration::from_secs(5),
        registration.handle().signals().hard().cancelled(),
    )
    .await
    .unwrap();
    let (_, completion_auth, source) = claimed.into_parts();
    drop(source);
    let completing = provider.clone();
    let task = tokio::spawn(async move {
        completing
            .complete(
                CompleteRequest {
                    run_id,
                    exit_code: 0,
                    failure_reason: None,
                    error: None,
                    sandbox_id: None,
                },
                completion_auth,
            )
            .await;
    });
    let request = server.next_request("supplied Run completion").await;
    assert!(request.starts_with("POST "));
    assert!(request.contains("authorization: Bearer supplied-run-token"));
    task.await.unwrap();
    registration.unregister().await;
    provider.shutdown().await;
    server.assert_finished().await;
}

#[tokio::test]
async fn supplied_runs_keep_distinct_completion_authority_when_settled_in_reverse_order() {
    let server = MockServer::start_async().await;
    let provider = api_provider_for_test(server.base_url(), CancellationToken::new());
    assert!(provider.clone().local_source().is_none());
    let mut jobs = Vec::new();
    let mut mocks = Vec::new();
    for token in ["first-publication-token", "second-publication-token"] {
        let run_id = RunId::new_v4();
        let mut publication: Value =
            serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
        publication["runId"] = serde_json::json!(run_id);
        publication["sandboxToken"] = serde_json::json!(token);
        let context =
            decode_execution_publication(&serde_json::to_vec(&publication).unwrap()).unwrap();
        let job = provider.bind_supplied(context).await.unwrap();
        mocks.push(
            server
                .mock_async(|when, then| {
                    when.method(POST)
                        .path("/api/webhooks/agent/complete")
                        .header("authorization", format!("Bearer {token}"))
                        .body_includes(format!("\"runId\":\"{run_id}\""));
                    then.status(204);
                })
                .await,
        );
        jobs.push((run_id, job));
    }
    for (run_id, job) in jobs.into_iter().rev() {
        let (_, authority, source) = job.into_parts();
        drop(source);
        provider.complete(complete_request(run_id), authority).await;
    }
    for mock in mocks {
        mock.assert_calls_async(1).await;
    }
    provider.shutdown().await;
}
