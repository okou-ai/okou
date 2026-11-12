use super::*;

#[tokio::test]
async fn supplied_publication_binds_api_controls_and_completion_without_claim_or_claim_timing() {
    let run_id = RunId::new_v4();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response(
            "200 OK",
            &serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone"}).to_string(),
        )),
        RawHttpAction::Respond(http_response("204 No Content", b"")),
    ])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let registration = provider.cancel_tokens.register(run_id).await.unwrap();
    let mut publication: Value = serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
    publication["runId"] = serde_json::json!(run_id);
    publication["reuseKey"] = serde_json::json!("thread:supplied");
    publication["sandboxToken"] = serde_json::json!("supplied-run-token");
    let context = decode_execution_publication(&serde_json::to_vec(&publication).unwrap()).unwrap();
    assert!(
        context.instruction_file.is_some(),
        "shared content normalization is required on supplied work"
    );
    let claimed = provider.bind_supplied(context).await.unwrap();
    assert!(claimed.api_claim_timing().is_none());
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
