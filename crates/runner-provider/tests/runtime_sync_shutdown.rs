use std::sync::Arc;
use std::time::Duration;

use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, HttpClient, HttpClientConfig,
    JobProvider, RunCancellationRegistry,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn provider() -> TestResult<(tempfile::TempDir, TcpListener, Arc<ApiProvider>)> {
    let directory = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let http = HttpClient::new(HttpClientConfig {
        api_url: format!("http://{}", listener.local_addr()?),
        vercel_bypass: None,
        client_session_id: "runtime-sync-shutdown-test".into(),
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
    Ok((directory, listener, provider))
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_cloned_shutdown_waits_for_dispatcher_retirement() -> TestResult {
    let (_directory, _listener, provider) = provider().await?;
    let handle = provider.connector_runtime_sync_handle();
    let other_handle = handle.clone();

    // No yield lets the real dispatcher retire between these public calls.
    let mut first = Box::pin(handle.shutdown());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    let mut concurrent = Box::pin(other_handle.shutdown());
    assert!(
        futures_util::poll!(concurrent.as_mut()).is_pending(),
        "concurrent shutdown must wait for dispatcher retirement"
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(first, concurrent);
    })
    .await
    .expect("both shutdown callers should join the dispatcher");
    provider.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_shutdown_retains_dispatcher_join_for_another_clone() -> TestResult {
    let (_directory, _listener, provider) = provider().await?;
    let handle = provider.connector_runtime_sync_handle();
    let other_handle = handle.clone();

    let mut first = Box::pin(handle.shutdown());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    drop(first);
    // The dispatcher has still not been scheduled. Cancelling its waiter
    // must leave the actual join boundary available through another clone.
    let mut retry = Box::pin(other_handle.shutdown());
    assert!(
        futures_util::poll!(retry.as_mut()).is_pending(),
        "cancelled shutdown must retain the dispatcher join"
    );
    tokio::time::timeout(Duration::from_secs(1), retry)
        .await
        .expect("another clone should join after cancellation");
    tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
        .await
        .expect("shutdown should remain idempotent after retirement");
    provider.shutdown().await;
    Ok(())
}
