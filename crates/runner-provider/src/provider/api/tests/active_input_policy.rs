use super::*;
use crate::active_input::ActiveInputBatch;
use httpmock::Method::GET;

#[tokio::test]
async fn claimed_run_carries_original_platform_policy_on_active_input_reads() {
    for policy in [
        None,
        Some("[]"),
        Some(r#"["image-generation"]"#),
        Some("not-json"),
        Some(r#"["future-tool"]"#),
    ] {
        let server = MockServer::start_async().await;
        let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
        let mut response: serde_json::Value =
            serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
        response["environment"][DISABLED_PAID_TOOLS_ENV_VAR] = serde_json::json!(r#"["scrape"]"#);
        response["vars"][DISABLED_PAID_TOOLS_ENV_VAR] = serde_json::json!(r#"["web-search"]"#);
        if let Some(policy) = policy {
            response["platformEnvironment"][DISABLED_PAID_TOOLS_ENV_VAR] =
                serde_json::json!(policy);
        }
        let claim = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/jobs/{run_id}/claim"));
                then.status(200).json_body(response);
            })
            .await;
        let read = server
            .mock_async(|when, then| {
                let when = when
                    .method(GET)
                    .path(format!("/api/runners/runs/{run_id}/steerable-inputs/next"))
                    .header("authorization", "Bearer fixture-sandbox-token-not-real");
                if let Some(policy) = policy {
                    when.query_param("disabledPaidTools", policy);
                } else {
                    when.query_param_missing("disabledPaidTools");
                }
                then.status(200)
                    .json_body(serde_json::json!({"input": null}));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("valid Run is claimed");
        let (_, _, source) = claimed.into_parts();
        let mut source = source.expect("thread Run owns an active-input source");
        for _ in 0..2 {
            assert!(
                matches!(source.read(1).await.unwrap(), ActiveInputBatch::Api(response) if response.input.is_none())
            );
        }
        claim.assert_calls_async(1).await;
        read.assert_calls_async(2).await;
    }
}
