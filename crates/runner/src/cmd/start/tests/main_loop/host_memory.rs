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
    let result = tokio::spawn(run_start_with_home(
        StartArgs {
            config: dir.path().join("missing.yaml"),
            api_url: None,
            token: None,
            local: true,
        },
        &sandbox_firecracker::FirecrackerRuntimeProvider,
        || panic!("invalid startup must not load runtime home"),
        runner_host::home_observation::HomeObservationHandle::default(),
    ))
    .await
    .expect("startup task must return without panicking");
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
    let observer = runner_supervisor::host_memory::HostMemoryObserver::spawn();
    let result = finish_host_memory_observation(observer, Ok(())).await;
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

#[tokio::test]
async fn observer_join_failure_is_returned_after_successful_startup() {
    let joined = tokio::spawn(async { panic!("observer task failed") }).await;
    let error = finish_observed_start(Ok(()), joined).unwrap_err();
    match error {
        RunnerError::Internal(message) => {
            assert!(message.starts_with("join host memory observer: "));
            assert!(message.contains("observer task failed"));
        }
        other => panic!("expected observer join failure, got {other}"),
    }
}

#[tokio::test]
async fn observer_join_failure_preserves_the_primary_startup_error() {
    let joined = tokio::spawn(async { panic!("observer task failed") }).await;
    let result = Err(RunnerError::Config("primary startup error".into()));
    let error = finish_observed_start(result, joined).unwrap_err();
    match error {
        RunnerError::Config(message) => assert_eq!(message, "primary startup error"),
        other => panic!("expected primary startup error, got {other}"),
    }
}
