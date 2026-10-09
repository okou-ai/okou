use super::super::super::*;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn startup_failure_joins_the_passive_observer_before_returning() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    tracing::callsite::rebuild_interest_cache();
    let dir = tempfile::tempdir().unwrap();
    let result = run_start_with_home(
        StartArgs {
            config: dir.path().join("missing.yaml"),
            api_url: None,
            token: None,
            local: true,
        },
        &sandbox_firecracker::FirecrackerRuntimeProvider,
        || panic!("invalid startup must not load runtime home"),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        captured
            .entries()
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("host memory observer stopped")
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn successful_return_joins_the_passive_observer_before_returning() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    tracing::callsite::rebuild_interest_cache();
    let result = run_with_host_memory_observer(std::future::ready(Ok(()))).await;
    assert!(result.is_ok());
    assert_eq!(
        captured
            .entries()
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("host memory observer stopped")
            })
            .count(),
        1
    );
}
