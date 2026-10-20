use super::*;

#[tokio::test]
async fn poll_preserves_independent_source_in_claim_request_without_native_history() {
    let server = MockServer::start_async().await;
    let run_id = RunId::new_v4();
    let source = RunId::new_v4();
    let preference = serde_json::json!({
        "kind": "preference",
        "runnerIdentity": {"runnerId": TEST_RUNNER_ID, "heartbeatGeneration": 7},
        "tier": "finalizingPredecessor",
        "expiresAt": "2999-01-01T00:00:00Z",
        "finalizingSourceRunId": source
    });
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": run_id,
                    "prompt": "continue with another framework",
                    "appendSystemPrompt": null,
                    "vars": null,
                    "experimentalProfile": "vm0/default",
                    "reuseKey": "thread:independent-finalizing-source",
                    "runnerPreference": preference
                }
            }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let candidate = tokio::time::timeout(Duration::from_secs(5), provider.discover())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), run_id);
    assert_eq!(candidate.history_generation_run_id(), None);
    assert_eq!(
        candidate.runner_preference().unwrap().target(),
        crate::provider::RunnerPreferenceTarget::FinalizingPredecessor(source)
    );
    assert_eq!(
        claim_request_body_for_test(&candidate)["telemetry"]["runnerPreference"],
        preference
    );
    mock.assert_async().await;
}
