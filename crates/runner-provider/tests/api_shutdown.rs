use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::routes::runners::builtin_firewalls::resolve::RESOLVE;
use raw_http_test_support::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, HttpClient, HttpClientConfig,
    JobProvider, RunCancellationRegistry,
};
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn provider() -> TestResult<(tempfile::TempDir, RawHttpTestServer, Arc<ApiProvider>)> {
    let directory = tempfile::tempdir()?;
    let catalog = serde_json::json!({
        "catalogDigest": format!("sha256:{}", "a".repeat(64)),
        "catalogVersion": "shutdown-test",
        "firewalls": {
            "example": {
                "name": "example",
                "apis": [{
                    "id": "", "base": "https://api.example.com",
                    "auth": { "headers": {} },
                    "permissions": [{ "name": "read", "rules": ["GET /items"] }],
                }],
            },
        },
    });
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        &catalog.to_string(),
    ))])
    .await;
    let http = HttpClient::new(HttpClientConfig {
        api_url: server.url(),
        vercel_bypass: None,
        client_session_id: "api-shutdown-test".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })?;
    let provider = ApiProvider::new(
        http,
        "synthetic-runner-token".into(),
        ApiProviderConfig {
            ably_side_message_handler: None,
            runner_identity: RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1)?,
            runner_hostname: None,
            group: "test".into(),
            supported_profiles: vec![],
            installed_okou_cli: None,
        },
        BuiltinFirewallCatalogCachePaths {
            cache_path: directory.path().join("catalog.json"),
            lock_path: directory.path().join("catalog.lock"),
        },
        CancellationToken::new(),
        RunCancellationRegistry::new(),
    );
    // Its separately exported shutdown already retains custody. Retire it
    // through the public API so it cannot mask the remaining worker owners.
    provider.connector_runtime_sync_handle().shutdown().await;
    provider.prepare_startup_readiness().await?;
    // Do not yield after readiness spawns the real catalog/Ably tasks.
    Ok((directory, server, provider))
}

async fn finish(
    directory: &tempfile::TempDir,
    mut server: RawHttpTestServer,
    provider: &ApiProvider,
) -> TestResult {
    tokio::time::timeout(Duration::from_secs(2), provider.shutdown()).await?;
    let cache: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(directory.path().join("catalog.json")).await?)?;
    assert_eq!(
        cache
            .get("catalogVersion")
            .and_then(serde_json::Value::as_str),
        Some("shutdown-test")
    );
    let request = server.next_request("startup catalog publication").await;
    assert!(request.starts_with(&format!("POST {} ", RESOLVE.path)));
    server.assert_finished().await;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_provider_shutdown_waits_for_all_worker_owners() -> TestResult {
    let (directory, server, provider) = provider().await?;
    let second_provider = provider.clone();
    let third_provider = provider.clone();
    let mut first = Box::pin(provider.shutdown());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    let mut second = Box::pin(second_provider.shutdown());
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    let mut third = Box::pin(third_provider.shutdown());
    assert!(
        futures_util::poll!(third.as_mut()).is_pending(),
        "concurrent provider shutdown must retain all worker joins"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(first, second, third);
    })
    .await?;
    finish(&directory, server, &provider).await
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_provider_shutdown_retains_all_worker_owners() -> TestResult {
    let (directory, server, provider) = provider().await?;
    let mut first = Box::pin(provider.shutdown());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    drop(first);
    let mut second = Box::pin(provider.shutdown());
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    drop(second);
    let mut retry = Box::pin(provider.shutdown());
    assert!(
        futures_util::poll!(retry.as_mut()).is_pending(),
        "cancelled provider shutdown must retain all worker joins"
    );
    tokio::time::timeout(Duration::from_secs(2), retry).await?;
    finish(&directory, server, &provider).await
}
