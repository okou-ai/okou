//! A real provider claim remains reportable while failed preparation is cleaned up.

use api_contracts::generated::routes;
use httpmock::prelude::*;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, RunCancellationRegistry,
    http::{HttpClient, HttpClientConfig},
};
use runner_types::types::CompleteRequest;
use serde_json::json;

use super::*;

#[tokio::test]
async fn http_claim_failure_completion_preserves_independent_cleanup_and_full_lease() {
    let server = MockServer::start_async().await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let run = RunId::new_v4();
    let claim_path = format!("/api/runners/jobs/{run}/claim");
    let claim = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(&claim_path)
                .header("authorization", "Bearer runner-token");
            then.status(200).json_body(json!({
                "runId": run,
                "prompt": "claimed before preparation failed",
                "sandboxToken": "original-claimed-run-token",
                "reuseKey": fixture.home.reuse_key,
                "cliAgentType": "claude_code",
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let completion = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path)
                .header("authorization", "Bearer original-claimed-run-token")
                .json_body(json!({
                    "runId": run,
                    "exitCode": 1,
                    "error": "claimed preparation failed",
                    "sandboxId": fixture.home.sandbox_id
                }));
            then.status(200);
        })
        .await;
    let provider = ApiProvider::new(
        HttpClient::new(HttpClientConfig {
            api_url: server.base_url(),
            vercel_bypass: None,
            client_session_id: "claimed-preparation-ownership".into(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "runner-token".into(),
        ApiProviderConfig {
            ably_side_message_handler: None,
            runner_identity: RunnerProcessIdentity::new(uuid::Uuid::from_u128(1), 7).unwrap(),
            runner_hostname: None,
            group: "claimed-preparation-ownership".into(),
            supported_profiles: vec!["vm0/default".into()],
            installed_okou_cli: None,
        },
        BuiltinFirewallCatalogCachePaths {
            cache_path: fixture.home._dir.path().join("firewall.json"),
            lock_path: fixture.home._dir.path().join("firewall.lock"),
        },
        CancellationToken::new(),
        RunCancellationRegistry::new(),
    );
    fixture
        .overrides
        .push_guest_state_restore_result(Err(sandbox::SandboxError::Start {
            message: "claimed preparation failed".into(),
        }));
    let mut admission = fixture.admission.take().unwrap();
    let failure = tokio::time::timeout(
        WAIT,
        admission.prepare_and_claim(provider.clone(), fixture.candidate(run), &fixture.tracker),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(failure.contains("claimed preparation failed"));
    claim.assert_calls_async(1).await;
    assert!(admission.commit().is_err());
    fixture.retained().await;

    let (context, auth, _) = admission
        .take_claim_response()
        .unwrap()
        .expect("failed preparation must retain the successful HTTP claim")
        .into_parts();
    assert_eq!(context.run_id, run);
    tokio::time::timeout(
        WAIT,
        provider.complete(
            CompleteRequest {
                run_id: context.run_id,
                exit_code: 1,
                failure_reason: None,
                error: Some("claimed preparation failed".into()),
                sandbox_id: Some(fixture.home.sandbox_id),
            },
            auth,
        ),
    )
    .await
    .unwrap();
    completion.assert_calls_async(1).await;
    assert!(matches!(
        admission.take_claim_response(),
        Err(MemoryOperationError::Consumed)
    ));
    assert!(admission.commit().is_err());
    // Reporting failure is independent of required saving and backing exit.
    fixture.retained().await;

    let kill = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    let GuardedSpeculativeRollback::Cleanup(task) = fixture.rollback(&mut admission).await.unwrap()
    else {
        panic!("unusable preparation requires owned cleanup");
    };
    drop(task);
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    let mut shutdown = Box::pin(fixture.tracker.close_and_wait());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    exit.confirm_exit();
    kill.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();

    let mut retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert!(retained[0].cleanup_completed());
    assert!(matches!(
        HomePromotionFixture::checkout_result(&fixture.home.cache, &fixture.home.reuse_key).await,
        HomeCacheCheckoutResult::Hit
    ));
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        0
    );
    drop(retained[0].take_completed_lease().unwrap());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    claim.assert_calls_async(1).await;
    completion.assert_calls_async(1).await;
    tokio::time::timeout(WAIT, provider.shutdown())
        .await
        .unwrap();
}
