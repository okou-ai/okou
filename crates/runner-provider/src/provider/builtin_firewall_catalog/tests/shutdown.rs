use super::*;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn controller() -> TestResult<(
    tempfile::TempDir,
    RawHttpTestServer,
    BuiltinFirewallCatalogRefreshController,
)> {
    let directory = tempfile::tempdir()?;
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(catalog_response())]).await;
    let api = ApiClient::new(
        HttpClient::new(HttpClientConfig {
            api_url: server.url(),
            vercel_bypass: None,
            client_session_id: "catalog-shutdown-test".into(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })?,
        "synthetic-runner-token".into(),
    );
    let controller = BuiltinFirewallCatalogRefreshController::new(
        api,
        directory.path().join("catalog.json"),
        directory.path().join("catalog.lock"),
        CancellationToken::new(),
    );
    controller.prepare_startup_readiness().await?;
    // Keep the actual periodic task unpolled until shutdown assertions finish.
    Ok((directory, server, controller))
}

async fn finish(
    directory: &tempfile::TempDir,
    mut server: RawHttpTestServer,
    controller: &BuiltinFirewallCatalogRefreshController,
) -> TestResult {
    tokio::time::timeout(Duration::from_secs(2), controller.shutdown()).await?;
    let cache: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(directory.path().join("catalog.json")).await?)?;
    assert_eq!(
        cache
            .get("catalogVersion")
            .and_then(serde_json::Value::as_str),
        Some("test-catalog")
    );
    let request = server.next_request("initial catalog readiness").await;
    assert!(request.starts_with("POST /api/runners/builtin-firewalls/resolve "));
    server.assert_finished().await;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_catalog_shutdown_retains_controller_and_task() -> TestResult {
    let (directory, server, controller) = controller().await?;
    let mut first = Box::pin(controller.shutdown());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    let mut concurrent = Box::pin(controller.shutdown());
    assert!(
        futures_util::poll!(concurrent.as_mut()).is_pending(),
        "concurrent catalog shutdown must retain its worker join"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(first, concurrent);
    })
    .await?;
    finish(&directory, server, &controller).await
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_catalog_shutdown_retains_controller_and_task() -> TestResult {
    let (directory, server, controller) = controller().await?;
    let mut first = Box::pin(controller.shutdown());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    drop(first);
    let mut retry = Box::pin(controller.shutdown());
    assert!(
        futures_util::poll!(retry.as_mut()).is_pending(),
        "cancelled catalog shutdown must retain its worker join"
    );
    tokio::time::timeout(Duration::from_secs(2), retry).await?;
    finish(&directory, server, &controller).await
}
